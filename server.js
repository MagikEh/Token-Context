#!/usr/bin/env node
/**
 * token-context — MCP server for the goose "Token Context" app.
 *
 * Exposes:
 *   - tool   `show_context_hud`  -> mounts the HUD (returns ui:// resource)
 *   - tool   `get_context_stats` -> live token stats (polled by the HUD at 5 Hz)
 *   - resource `ui://token-context/hud` -> the HUD HTML (bump suffix per HTML change)
 *
 * Stats are read from goose's session SQLite store (read-only). The store is
 * updated by goose after each LLM response completes, so:
 *   - "used tokens" = the tracked session's current context size (total_tokens)
 *   - "tok/s"       = rolling output-token rate over recent completed responses
 *
 * Which session is tracked, in order:
 *   1. an explicit `session_id` argument to get_context_stats
 *   2. AGENT_SESSION_ID — goose injects this into the stdio extension env of
 *      the session the extension was added to, so each chat's HUD reports on
 *      its own chat (fixes "old chat HUD follows the newest chat")
 *   3. the most recently updated user session (fallback)
 *
 * Context-window resolution, in order:
 *   1. GOOSE_CONTEXT_WINDOW env var
 *   2. models[*].context_limit from ~/.config/goose/custom_providers/*.json
 *      (matched by the session's provider name + model name; directory
 *      overridable via GOOSE_CUSTOM_PROVIDERS_DIR)
 *   3. built-in model table
 *   4. goose config.yaml GOOSE_LOCAL_MODEL_SETTINGS context_size (local provider)
 *   5. DEFAULT_WINDOW (200000)
 *
 * Env vars (all optional; full table with defaults in README.md):
 *   store / config:
 *     GOOSE_SESSIONS_DB            path to sessions.db (default: auto-discover)
 *     GOOSE_CONTEXT_WINDOW         context window in tokens (overrides all)
 *     GOOSE_CUSTOM_PROVIDERS_DIR   dir containing custom provider JSON files
 *     GOOSE_CONFIG_PATH            goose config.yaml path (test hook)
 *     GOOSE_AUTO_COMPACT_THRESHOLD context-bar triggers (env → config.yaml → 0.8)
 *   /slots monitor:
 *     GOOSE_SLOTS_URL, GOOSE_SLOT_POLL_MS, GOOSE_SLOT_ACTIVE_POLL_MS,
 *     GOOSE_SLOT_SETTLE_MS, GOOSE_SLOT_HEARTBEAT_MS, GOOSE_SLOT_REVALIDATE_MS,
 *     GOOSE_SLOT_AWAIT_MS, GOOSE_SLOT_DORMANT_POLL_MS, GOOSE_TPS_OFFSET_MS
 *   HUD claim broker:
 *     GOOSE_HUD_CLAIM_TTL_MS, GOOSE_HUD_CLAIM_TAKEOVER_MS
 *   injected by goose (not user settings):
 *     AGENT_SESSION_ID             scopes this process to one session
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_HTML = readFileSync(join(__dirname, "index.html"), "utf-8");
const RESOURCE_URI = "ui://token-context/hud";
const SERVER_NAME = "token-context";
const SERVER_VERSION = "1.4.5";

// ---------------------------------------------------------------------------
// SQLite access (read-only). Uses the built-in `node:sqlite` (Node >= 22.5).
// ---------------------------------------------------------------------------
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function discoverDbPath() {
  if (process.env.GOOSE_SESSIONS_DB) return process.env.GOOSE_SESSIONS_DB;
  const candidates = [
    join(homedir(), ".local", "share", "goose", "sessions", "sessions.db"),
    join(homedir(), ".goose", "sessions", "sessions.db"),
    join(homedir(), ".local", "share", "Block", "goose", "sessions", "sessions.db"),
    join(homedir(), "Library", "Application Support", "goose", "sessions", "sessions.db"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

const DB_PATH = discoverDbPath();

/** Lazily open the store read-only. Returns null if unavailable. */
function openDb() {
  if (!DatabaseSync) return null;
  if (!existsSync(DB_PATH)) return null;
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context window resolution. Sources, in order:
//   1. GOOSE_CONTEXT_WINDOW env var
//   2. custom provider JSON: models[*].context_limit (provider+model match)
//   3. known-model table
//   4. goose config.yaml GOOSE_LOCAL_MODEL_SETTINGS context_size (local provider)
//   5. DEFAULT_WINDOW
// ---------------------------------------------------------------------------
const MODEL_WINDOWS = [
  [/claude-(opus|sonnet|haiku)-[34]/i, 200_000],
  [/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 200_000],
  [/gpt-4o/i, 128_000],
  [/gpt-4-turbo/i, 128_000],
  [/gpt-4\b/i, 128_000],
  [/o1|o3|o4-mini/i, 200_000],
  [/gemini-2\.5|gemini-2\b/i, 1_048_576],
  [/gemini-1\.5/i, 1_048_576],
  [/llama-3\.[13](-405b|-70b)?/i, 131_072],
  [/mistral-large/i, 131_072],
  [/deepseek/i, 131_072],
];
const DEFAULT_WINDOW = 200_000;
// Root-level goose config path; overridable via env (test hook, same
// pattern as GOOSE_SESSIONS_DB / GOOSE_CUSTOM_PROVIDERS_DIR).
const gooseConfigPath = () =>
  process.env.GOOSE_CONFIG_PATH || join(homedir(), ".config", "goose", "config.yaml");
const CUSTOM_PROVIDERS_DIR =
  process.env.GOOSE_CUSTOM_PROVIDERS_DIR ||
  join(homedir(), ".config", "goose", "custom_providers");

/**
 * Parse every custom provider JSON. Returns:
 *   byProvider: Map<providerName, Map<modelName, contextLimit>>
 *   byModel:    Map<modelName, contextLimit>  (fallback when the session's
 *              provider_name does not match any custom provider's `name`)
 *   baseUrlByProvider: Map<providerName, baseUrl>  (source of the /slots URL)
 * Re-read on every stats call (not cached): provider JSON edits apply without
 * an extension restart; the directory holds a handful of small files.
 */
function loadCustomProviders() {
  const byProvider = new Map();
  const byModel = new Map();
  const baseUrlByProvider = new Map();
  let files = [];
  try {
    files = readdirSync(CUSTOM_PROVIDERS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return { byProvider, byModel };
  }
  for (const f of files) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(join(CUSTOM_PROVIDERS_DIR, f), "utf-8"));
    } catch {
      continue;
    }
    if (!cfg || !Array.isArray(cfg.models)) continue;
    const providerName = typeof cfg.name === "string" ? cfg.name.trim() : "";
    const baseUrl = typeof cfg.base_url === "string" ? cfg.base_url.trim() : "";
    if (providerName && baseUrl) baseUrlByProvider.set(providerName, baseUrl);
    for (const m of cfg.models) {
      if (!m || typeof m.name !== "string") continue;
      const limit = Number(m.context_limit);
      if (!Number.isFinite(limit) || limit <= 0) continue;
      const modelKey = m.name.trim();
      if (providerName) {
        if (!byProvider.has(providerName)) byProvider.set(providerName, new Map());
        byProvider.get(providerName).set(modelKey, limit);
      }
      if (!byModel.has(modelKey)) byModel.set(modelKey, limit);
    }
  }
  return { byProvider, byModel, baseUrlByProvider };
}

function lookupInMap(map, key) {
  if (!map) return undefined;
  const exact = map.get(key);
  if (exact !== undefined) return exact;
  const lower = key.toLowerCase();
  for (const [k, v] of map) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Best-effort read of a root-level scalar key from goose's config.yaml
 *  (column-0 keys only, so nested keys under other sections never match).
 *  Re-read on every stats call: config edits apply without an extension
 *  restart (the file is small and page-cached). */
function configRootValue(key) {
  let text;
  try {
    const cfgPath = gooseConfigPath();
    if (!existsSync(cfgPath)) return undefined;
    text = readFileSync(cfgPath, "utf-8");
  } catch {
    return undefined;
  }
  const m = text.match(new RegExp("^" + key + ":\\s*(.+?)\\s*$", "m"));
  return m ? m[1].replace(/^["']|["']$/g, "") : undefined;
}

/** Best-effort parse of GOOSE_LOCAL_MODEL_SETTINGS -> context_size from config.yaml.
 *  Read on demand (not cached at module load): same no-restart semantics as
 *  the other config.yaml reads — a config edit, or a config file that was
 *  briefly unreadable at startup, applies without an extension restart. */
function readLocalModelContextSizes() {
  let text;
  try {
    const cfgPath = gooseConfigPath();
    if (!existsSync(cfgPath)) return new Map();
    text = readFileSync(cfgPath, "utf-8");
  } catch {
    return new Map();
  }
  const sizes = new Map();
  let inSection = false;
  let currentModel = null;
  for (const line of text.split("\n")) {
    if (/^GOOSE_LOCAL_MODEL_SETTINGS:\s*(#.*)?$/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^\S/.test(line)) break; // dedented back to a top-level key
    const modelMatch = line.match(/^ {2}(.+):\s*$/);
    const ctxMatch = line.match(/^ {4,}context_size:\s*(\d+)\s*$/);
    if (modelMatch) {
      currentModel = modelMatch[1].trim().replace(/^["']|["']$/g, "");
    } else if (ctxMatch && currentModel) {
      const n = parseInt(ctxMatch[1], 10);
      if (Number.isFinite(n) && n > 0) sizes.set(currentModel, n);
    }
  }
  return sizes;
}

function resolveContextWindow(model, provider) {
  if (process.env.GOOSE_CONTEXT_WINDOW) {
    const n = parseInt(process.env.GOOSE_CONTEXT_WINDOW, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (model) {
    // Custom providers are authoritative for the models they define.
    const { byProvider, byModel } = loadCustomProviders();
    if (provider) {
      const perProvider = lookupInMap(byProvider, provider);
      if (perProvider) {
        const limit = lookupInMap(perProvider, model);
        if (limit !== undefined) return limit;
      }
    }
    const byModelLimit = lookupInMap(byModel, model);
    if (byModelLimit !== undefined) return byModelLimit;

    for (const [re, w] of MODEL_WINDOWS) if (re.test(model)) return w;
    // The built-in "local" provider is managed by goose itself, so its
    // GOOSE_LOCAL_MODEL_SETTINGS context_size is authoritative.
    if (provider === "local") {
      for (const [key, size] of readLocalModelContextSizes()) {
        if (key === model || key.startsWith(model + ":")) return size;
      }
    }
  }
  return DEFAULT_WINDOW;
}

/**
 * Context-bar colour triggers, derived from the session's auto-compaction
 * point so they scale with any context window:
 *   red    = GOOSE_AUTO_COMPACT_THRESHOLD (goose default 0.8 = 80 % of the
 *            window; 0.0 disables auto-compaction → legacy 90 % red point)
 *   yellow = 80 % of red (WARN_RATIO), so the two always move together.
 * Precedence: server process env → config.yaml root key → goose default.
 */
const WARN_RATIO = 0.8;
const DEFAULT_COMPACT_THRESHOLD = 0.8; // goose's documented default
const LEGACY_DANGER_PCT = 90;          // red point when auto-compaction is off
const round2 = (x) => Math.round(x * 100) / 100; // percent display precision

export function resolveBarThresholds() {
  let t = null; // fraction 0..1; 0 = explicitly disabled; null = unset
  for (const raw of [
    process.env.GOOSE_AUTO_COMPACT_THRESHOLD,
    configRootValue("GOOSE_AUTO_COMPACT_THRESHOLD"),
  ]) {
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) { t = n; break; }
  }
  const dangerPct =
    t === null ? DEFAULT_COMPACT_THRESHOLD * 100
    : t === 0 ? LEGACY_DANGER_PCT
    : t * 100;
  return {
    compactionThreshold: t === null ? DEFAULT_COMPACT_THRESHOLD : t,
    dangerPct: round2(dangerPct),
    warnPct: round2(dangerPct * WARN_RATIO),
  };
}

// ---------------------------------------------------------------------------
// Shared stats primitives (used by both the live monitor and the stats engine)
// ---------------------------------------------------------------------------
const TPS_WINDOW_MS = 30_000; // rolling window for the tok/s rate
// goose's real store keeps created_timestamp in whole seconds (some builds and
// our test fixtures use milliseconds); normalize so rate math is unit-correct.
const toMs = (ts) => (!ts ? 0 : ts < 1e12 ? ts * 1000 : ts);
// The session this process reports on, when scoped: goose injects
// AGENT_SESSION_ID into the stdio env of the session the extension was added
// to, so each chat's HUD reports on its own chat.
const AGENT_SESSION_ID = (process.env.AGENT_SESSION_ID || "").trim();

// ---------------------------------------------------------------------------
// HUD pop-out claim (v1.4.0; v1.4.2: takeover-on-fresh-init) — at most ONE
// popped-out HUD per session (NOT one HUD overall: inline HUDs may coexist,
// only the popped-out state is a singleton).
//
// The goose host re-renders every app tool result when it reloads the chat
// (e.g. on a theme switch), and every remounted guest requests pip mode —
// without coordination, N past triggers would pop N HUD windows. Guests
// therefore claim this session's single "popped-out" slot with a unique
// instance id at self-initialization:
//   • a fresh init TAKES OVER the slot when the current holder's claim is
//     older than the takeover window (default 10 s) — this is what lets the
//     user re-pop a new HUD via /token-context at any time;
//   • claims arriving in rapid succession (a theme-switch remount cascade)
//     are denied → those instances stay inline as placeholders, so a theme
//     switch still yields exactly one popped-out window;
//   • the displaced holder degrades to the placeholder on its next stats
//     poll and asks the host to return its window to inline.
// The goose PiP window's close button merely minimizes the HUD to inline —
// the instance stays alive and keeps polling, which is fine: the next
// /token-context init takes the slot over anyway.
// ---------------------------------------------------------------------------
const CLAIM_TTL_MS =
  Number(process.env.GOOSE_HUD_CLAIM_TTL_MS) > 0
    ? Number(process.env.GOOSE_HUD_CLAIM_TTL_MS)
    : 3000;
// A fresh init may take over the popped-out slot once the holder's claim is
// older than this (test hook: GOOSE_HUD_CLAIM_TAKEOVER_MS).
const CLAIM_TAKEOVER_MS =
  Number(process.env.GOOSE_HUD_CLAIM_TAKEOVER_MS) > 0
    ? Number(process.env.GOOSE_HUD_CLAIM_TAKEOVER_MS)
    : 10000;
// key -> { holder: instanceId, claimedAt: ms, holderSeen: ms }
const hudClaims = new Map();

/** Claim key for a HUD instance — same precedence as computeStats:
 *  explicit session id > AGENT_SESSION_ID > "auto" (shared slot when the
 *  server process is not session-scoped). */
const claimKeyFor = (explicitSessionId) =>
  ((explicitSessionId || "").trim() || AGENT_SESSION_ID || "auto");

/**
 * Init-time claim — the guest calls this exactly once at self-initialization.
 * A fresh init takes over the popped-out slot once the current holder's
 * claim is older than CLAIM_TAKEOVER_MS (or when there is no holder at all);
 * rapid successive claims (a theme-switch remount cascade) are denied so
 * that a chat reload pops exactly one window.
 * Returns "granted" or "denied".
 */
function claimSlot(key, instanceId) {
  const now = Date.now();
  let c = hudClaims.get(key);
  if (!c) {
    c = { holder: "", claimedAt: 0, holderSeen: 0 };
    hudClaims.set(key, c);
    if (hudClaims.size > 32) {
      // Bound the map: drop entries whose holder is stale (dead instances).
      for (const [k, e] of hudClaims)
        if (k !== key && now - e.holderSeen > CLAIM_TTL_MS) hudClaims.delete(k);
    }
  }
  if (c.holder === instanceId) {
    c.claimedAt = now;
    c.holderSeen = now;
    return "granted";
  }
  const holderCurrent =
    c.holder !== "" && now - c.claimedAt <= CLAIM_TAKEOVER_MS;
  if (!holderCurrent) {
    // No holder, or the holder's claim is old → this fresh init takes the
    // popped-out slot (the displaced holder degrades on its next poll).
    c.holder = instanceId;
    c.claimedAt = now;
    c.holderSeen = now;
    return "granted";
  }
  return "denied";
}

/**
 * Liveness refresh on a stats poll — reports whether this instance is the
 * CURRENT holder (display state: full HUD vs placeholder). Polls never
 * change the holder; only an init-time claim does.
 * Returns "granted" (this instance is the popped-out HUD) or "denied".
 */
function refreshClaim(key, instanceId) {
  const now = Date.now();
  const c = hudClaims.get(key);
  if (c && c.holder === instanceId) {
    c.holderSeen = now; // alive — even if its window was minimized to inline
    return "granted";
  }
  return "denied";
}

// ---------------------------------------------------------------------------
// Live model-server monitor (llama.cpp GET /slots)
//
// goose writes sessions.db only at response-completion time, so the DB is
// blind while a response streams. llama.cpp's server exposes /slots with a
// live state: is_processing, next_token[0].n_decoded (output tokens decoded
// so far) and n_prompt_tokens (measured prompt size). We poll it in the
// background and report a live "pre-fetched" estimate; when the response
// completes, the DB value becomes authoritative again (the estimate simply
// stops being reported).
//
// Two server shapes are supported:
//   * single-model llama-server — bare GET /slots answers with the slot array.
//   * router mode (--models-preset, one port serving many models) — a bare
//     GET /slots is refused with HTTP 400 "model name is missing"; slot state
//     is per-model at GET /slots?model=<name>. That refusal is detected on
//     the first poll, and from then on the tracked session's model name (from
//     sessions.db, refreshed on every stats call) is appended to the URL.
//
// Router mode adds a backend bypass: the router logs one line per PROXIED
// request, so steady polling spams its log. The router's router-local
// GET /v1/models catalog advertises each loaded model's backend host/port
// (in status.args), so once discovered the monitor polls the backend's own
// /slots directly — silent, and free to keep the full cadence. The backend
// cache is re-validated every REVALIDATE_MS (an evicted model's backend can
// stay alive-but-sleeping for a while) and after 3 consecutive misses (LRU
// swap → new port). Routers without a usable catalog, and the whole
// single-model path, fall back to a tiered cadence on the router endpoint:
// 100 ms for SETTLE_MS after activity, then a HEARTBEAT_POLL_MS heartbeat.
// All traffic is completion-anchored (AWAIT_MS below): beyond the await
// window after the last DB completion the monitor is fully dormant, so the
// backend's --sleep-idle-seconds countdown can elapse and VRAM is freed.
// ---------------------------------------------------------------------------
// Adaptive cadence: while a slot is decoding we want the tightest wall-clock
// measurement possible (it bounds the completion hand-off's duration error —
// a fixed 250ms grid cost up to ~500ms on short replies), so poll fast; when
// everything is idle there is nothing to measure, so relax.
const IDLE_POLL_MS =
  Number(process.env.GOOSE_SLOT_POLL_MS) > 0 ? Number(process.env.GOOSE_SLOT_POLL_MS) : 100;
const ACTIVE_POLL_MS = Math.min(
  Number(process.env.GOOSE_SLOT_ACTIVE_POLL_MS) > 0
    ? Number(process.env.GOOSE_SLOT_ACTIVE_POLL_MS)
    : 50,
  IDLE_POLL_MS
);
// Tiered cadence: router-mode servers log every PROXIED request, so a steady
// 10 Hz idle poll spams the server log 10 lines/s while nothing happens.
// Keep the 100 ms idle cadence only for SETTLE_MS after the last processing
// observation (tight hand-off end boundary + tool-loop bursts), then drop to
// a slow heartbeat until the next activity.
const SETTLE_MS =
  Number(process.env.GOOSE_SLOT_SETTLE_MS) > 0 ? Number(process.env.GOOSE_SLOT_SETTLE_MS) : 10_000;
const HEARTBEAT_POLL_MS =
  Number(process.env.GOOSE_SLOT_HEARTBEAT_MS) > 0 ? Number(process.env.GOOSE_SLOT_HEARTBEAT_MS) : 1000;
const REVALIDATE_MS =
  Number(process.env.GOOSE_SLOT_REVALIDATE_MS) > 0 ? Number(process.env.GOOSE_SLOT_REVALIDATE_MS) : 60_000;
const DISCOVER_THROTTLE_MS = 2000;
// Completion-anchored polling: /slots is NOT sleep-timer-exempt, so ANY
// steady polling (even 1 Hz) keeps the backend awake forever. Instead of a
// permanent heartbeat we poll only for a bounded window after the last DB
// completion, then go fully dormant (zero /slots traffic) so the backend's
// --sleep-idle-seconds countdown can actually elapse and VRAM is freed.
// The HUD's 5 Hz stats polling reads the DB and updates lastCompletionAt,
// waking the loop when a new response completes.
const AWAIT_MS =
  Number(process.env.GOOSE_SLOT_AWAIT_MS) > 0 ? Number(process.env.GOOSE_SLOT_AWAIT_MS) : 120_000;
// How often to re-evaluate the dormant condition without making an HTTP call.
const DORMANT_POLL_MS =
  Number(process.env.GOOSE_SLOT_DORMANT_POLL_MS) > 0 ? Number(process.env.GOOSE_SLOT_DORMANT_POLL_MS) : 5_000;
export const slotMonitor = {
  url: process.env.GOOSE_SLOTS_URL || null, // fixed override (tests)
  model: "",    // tracked session's model name (scopes /slots in router mode)
  router: false, // true once the endpoint proved to be a model ROUTER
  // Backend bypass (router mode): the router logs one line per PROXIED
  // request, but the per-model backend server it spawns answers its own
  // /slots silently. The backend's real port is advertised in the
  // router-local GET /v1/models catalog (status.args carries --host/--port),
  // so once discovered we poll the backend directly — zero log lines, and
  // no reason to relax the cadence.
  backendUrl: null,   // discovered backend /slots URL
  backendModel: "",   // model the cached backendUrl belongs to
  backendFails: 0,    // consecutive backend fetch failures (stale backend)
  lastDiscoverAt: 0,  // t of last /v1/models attempt (throttle + re-validate)
  state: null,
  fetchedAt: 0,
  failures: 0,
  startAt: null,
  lastIdleT: 0, // last poll (t) that saw no processing slot
  samples: [],
  promptTokens: 0,
  wasProc: false,
  lastProcEnd: 0, // t of the last proc→idle transition (drives the settle window)
  lastCompletionAt: 0, // ms timestamp of the most recent usage_ledger completion
  generationPending: false, // true when a user message exists without a matching completion
};

// The backend cache (discovered port) and the decode timeline (hand-off
// samples) are both per-model, and a model change / rediscovered backend
// invalidates both — so both resets live here, not inline at each site.
function clearBackendCache() {
  slotMonitor.backendUrl = null;
  slotMonitor.backendModel = "";
  slotMonitor.backendFails = 0;
}

// Drop the decode timeline (samples, start, prompt size): a new endpoint
// (model change, rediscovered backend) starts a fresh slot timeline, so old
// samples must not leak into the new hand-off estimate.
function resetSlotTimeline() {
  slotMonitor.state = null;
  slotMonitor.fetchedAt = 0;
  slotMonitor.samples = [];
  slotMonitor.startAt = null;
  slotMonitor.wasProc = false;
  slotMonitor.promptTokens = 0;
}

function setSlotsUrlForProvider(provider) {
  if (slotMonitor.url || !provider) return;
  const { baseUrlByProvider } = loadCustomProviders();
  const bu = baseUrlByProvider.get(provider);
  if (!bu) return;
  try {
    const u = new URL(bu);
    u.pathname = u.pathname.replace(/\/+$/, "").replace(/\/v\d+$/, "") + "/slots";
    slotMonitor.url = u.toString();
  } catch {
    /* ignore */
  }
}

// In router mode the tracked session's model scopes the /slots request
// (GET /slots?model=<name>); single-model servers answer bare /slots and
// the parameter is never appended.
function slotsUrlNow() {
  const base = slotMonitor.url;
  if (!base || !slotMonitor.router || !slotMonitor.model) return base;
  try {
    const u = new URL(base);
    u.searchParams.set("model", slotMonitor.model);
    return u.toString();
  } catch {
    return base;
  }
}

// Pure (unit-testable): the backend server's /slots URL for `model` from a
// router /v1/models catalog. The backend's real host/port ride in the model
// entry's status.args (the llama-server invocation used to spawn it); a
// loaded model without parseable args yields null → caller keeps polling
// the router endpoint (tiered cadence).
export function backendUrlFromCatalog(catalog, model) {
  if (!catalog || !Array.isArray(catalog.data)) return null;
  for (const entry of catalog.data) {
    if (!entry) continue;
    const isModel =
      entry.id === model ||
      (Array.isArray(entry.aliases) && entry.aliases.includes(model));
    if (!isModel) continue;
    const st = entry.status || {};
    if (st.value !== "loaded") return null;
    const args = Array.isArray(st.args) ? st.args : [];
    let host = "127.0.0.1";
    let port = 0;
    for (let i = 0; i + 1 < args.length; i++) {
      if (args[i] === "--port") port = Number(args[i + 1]);
      else if (args[i] === "--host") host = String(args[i + 1]);
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return `http://${host}:${port}/slots`;
  }
  return null;
}

// Throttled backend discovery / re-validation (router mode only). Runs:
//   - once per REVALIDATE_MS while the cached backend is healthy — closing
//     the "sleeping backend" trap: llama.cpp's --sleep-idle-seconds can keep
//     an evicted model's backend alive for a while, so a cached port can
//     keep "succeeding" against a stale idle backend after an LRU swap;
//   - immediately after the cached backend failed 3 consecutive fetches
//     (backend respawned on a new port);
//   - at most once per DISCOVER_THROTTLE_MS for any reason.
async function maybeDiscoverBackend() {
  const m = slotMonitor;
  if (!m.router || !m.model || !m.url) return;
  const healthy = m.backendUrl && m.backendModel === m.model && m.backendFails < 3;
  if (healthy && Date.now() - m.lastDiscoverAt < REVALIDATE_MS) return;
  if (Date.now() - m.lastDiscoverAt < DISCOVER_THROTTLE_MS) return;
  m.lastDiscoverAt = Date.now();
  let catalog = null;
  try {
    const base = m.url.replace(/\/slots\/?$/, "");
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 500);
    const r = await fetch(base + "/v1/models", { signal: ctrl.signal });
    clearTimeout(to);
    catalog = await r.json().catch(() => null);
  } catch {
    catalog = null; // router unreachable / no catalog → stay on the router endpoint
  }
  const found = backendUrlFromCatalog(catalog, m.model);
  if (found && found !== m.backendUrl) {
    m.backendUrl = found;
    m.backendModel = m.model;
    m.backendFails = 0;
    // A (re)discovered backend is a new slot timeline — drop samples taken
    // against the previous endpoint (old model, or the router).
    resetSlotTimeline();
  } else if (!found && m.backendUrl) {
    clearBackendCache(); // model unloaded (or no port info) → router endpoint
  }
}

// The tracked session's model name, refreshed on every stats call. A change
// discards the previous model's decode samples AND its backend cache, so its
// hand-off cannot be attributed to this session (slots are per-model, not
// per-session).
function setSlotsModel(model) {
  const m = typeof model === "string" ? model.trim() : "";
  if (m === slotMonitor.model) return;
  slotMonitor.model = m;
  clearBackendCache();
  resetSlotTimeline();
}

async function pollSlots() {
  if (!slotMonitor.url) return false;
  await maybeDiscoverBackend();
  const viaBackend = !!slotMonitor.backendUrl;
  const url = viaBackend ? slotMonitor.backendUrl : slotsUrlNow();
  const hadModel = slotMonitor.router && !!slotMonitor.model;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 200);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    const body = await r.json().catch(() => null);
    if (body === null) throw new Error("http " + r.status);
    if (Array.isArray(body)) {
      if (viaBackend) slotMonitor.backendFails = 0;
      // A bare /slots answering with a plain array means we are NOT talking
      // to a router after all (single-model server) — drop the flag.
      if (slotMonitor.router && !viaBackend && !hadModel) slotMonitor.router = false;
      slotMonitor.state = body;
      slotMonitor.fetchedAt = Date.now();
      slotMonitor.failures = 0;
      return true;
    }
    if (viaBackend) return backendMiss(); // a real backend never answers objects
    // A single-model llama-server always answers /slots with an array, so a
    // JSON object here (the router's HTTP 400 "model name is missing") means
    // we are talking to a model ROUTER: mark it and retry once, this time
    // with the tracked session's model name.
    if (!slotMonitor.router) {
      slotMonitor.router = true;
      console.error(
        `[token-context] /slots is router-mode (per-model); tracking "${
          slotMonitor.model || "(unknown model — waiting for a stats call)"
        }"`
      );
      if (slotMonitor.model) return pollSlots();
      return false; // model arrives with the next stats call
    }
    // Router mode, model-scoped request came back empty — the model is
    // probably unloaded (or the router is momentarily wedged). Nothing to
    // observe right now; not counted as a fetch failure.
    return false;
  } catch {
    if (viaBackend) return backendMiss();
    slotMonitor.failures++;
    if (slotMonitor.failures > 60) {
      slotMonitor.url = null;
      slotMonitor.router = false; // re-derived + re-detected on next stats call
      clearBackendCache();
    }
    return false;
  }
}

// A fetch against the (believed) backend failed: connection refused (LRU
// swap), abort (router wedged), or a non-array answer. Three consecutive
// misses clear the cache and zero lastDiscoverAt so the NEXT poll
// re-validates against the catalog immediately; meanwhile the loop keeps
// running on the router endpoint (tiered cadence).
function backendMiss() {
  const m = slotMonitor;
  m.backendFails++;
  if (m.backendFails >= 3) {
    clearBackendCache();
    m.lastDiscoverAt = 0; // force immediate catalog re-validation on next poll
  }
  return false;
}

// Summarize the processing slots in the newest snapshot: how many are busy,
// the max decoded-so-far count, and the max measured prompt size. The slot
// is per-server (per-model in router mode), so maxima — not sums — describe
// "the" generation the tracked session is observing. Shared by the state
// machine, the cadence gate, and the live display.
function processingSummary(st) {
  if (!Array.isArray(st)) return null;
  let count = 0, estOut = 0, promptTokens = 0;
  for (const s of st) {
    if (!s || !s.is_processing) continue;
    count++;
    const nt = Array.isArray(s.next_token) ? s.next_token[0] : null;
    estOut = Math.max(estOut, (nt && nt.n_decoded) || 0);
    promptTokens = Math.max(promptTokens, s.n_prompt_tokens || 0);
  }
  return { count, estOut, promptTokens };
}

// Slot state machine, driven by the /slots poll loop (NOT by guest stats
// ticks) so hand-off timestamps sit on the poll grid — 50 ms while
// decoding — instead of the guest's 200 ms render tick.
export function slotStateTransition(nowMs) {
  const sum = processingSummary(slotMonitor.state);
  if (sum && sum.count > 0) {
    slotMonitor.promptTokens = sum.promptTokens;
    if (!slotMonitor.wasProc) {
      slotMonitor.wasProc = true;
      slotMonitor.startAt = nowMs;
      slotMonitor.samples = [];
    }
    slotMonitor.samples.push({ t: nowMs, n: sum.estOut });
    while (slotMonitor.samples.length > 2 && slotMonitor.samples[0].t < nowMs - 8000) {
      slotMonitor.samples.shift();
    }
  } else {
    if (slotMonitor.wasProc) {
      slotMonitor.lastProcEnd = nowMs;
      captureHandoff(nowMs);
    }
    slotMonitor.wasProc = false;
    slotMonitor.startAt = null;
    slotMonitor.samples = [];
    slotMonitor.lastIdleT = nowMs;
  }
}

// True when the newest /slots snapshot is fresh and shows at least one
// busy slot. Stale (>1.5s, e.g. fetch failures) → false → idle cadence.
function isAnySlotProcessing() {
  const sum = processingSummary(slotMonitor.state);
  if (!sum || Date.now() - slotMonitor.fetchedAt > 1500) return false;
  return sum.count > 0;
}

// Completion hand-off: when a live slot goes idle, remember the final
// decoded-token count and the ms-resolution wall-clock elapsed time. The DB
// only stores whole-second timestamps, so this gives lastResponseTps() a
// precise duration — the idle "last" rate then closely matches goose's own
// measured per-message rate.
//
// Boundary estimation: the true start lies in the grid cell
// (lastIdleT, firstProcPoll] and the true end in (lastProcSample,
// idlePoll]. Estimating each boundary at its cell's midpoint removes the
// systematic polling-grid bias (naive first→last sampling shortens the span
// by up to half the grid at EACH end).
export const slotHandoff = { at: 0, tokens: 0, elapsedMs: 0 };
function captureHandoff(nowMs) {
  nowMs = nowMs || Date.now();
  const last = slotMonitor.samples[slotMonitor.samples.length - 1];
  const startAt = slotMonitor.startAt;
  if (!last || !startAt || last.n <= 0) return;
  const startEst =
    slotMonitor.lastIdleT > 0 && slotMonitor.lastIdleT < startAt
      ? (slotMonitor.lastIdleT + startAt) / 2
      : startAt; // no prior idle observation (server just started) → old behavior
  const endEst = (last.t + nowMs) / 2;
  const elapsedMs = endEst - startEst;
  if (elapsedMs < 500 || elapsedMs > 3600_000) return;
  slotHandoff.at = nowMs;
  slotHandoff.tokens = last.n;
  slotHandoff.elapsedMs = elapsedMs;
}
// Optional constant calibration (ms) added to the hand-off duration. goose's
// footer timer includes client-side overhead (serializing/transporting the
// prompt request, stream finalization) that the model-server window does
// not; GOOSE_TPS_OFFSET_MS lets a user fold that constant into the idle
// LAST rate. Default 0 = honest server-side measurement.
const TPS_OFFSET_MS =
  process.env.GOOSE_TPS_OFFSET_MS !== "" &&
  Number.isFinite(Number(process.env.GOOSE_TPS_OFFSET_MS))
    ? Number(process.env.GOOSE_TPS_OFFSET_MS)
    : 0;

// Pure (unit-testable): rate from the exact DB output tokens over the
// hand-off duration — only when the hand-off is fresh and its token count
// plausibly matches the ledger row (the slot is per-server, not per-session).
export function handoffRate(outTokens, handoff, nowMs, offsetMs = TPS_OFFSET_MS) {
  if (!handoff || !handoff.at || handoff.tokens <= 0) return null;
  if (nowMs - handoff.at > 15_000) return null;
  const out = outTokens || 0;
  if (Math.abs(handoff.tokens - out) > Math.max(32, Math.round(out * 0.05))) return null;
  const durMs = Math.max(100, (handoff.elapsedMs || 0) + (offsetMs || 0));
  return Math.round((out / (durMs / 1000)) * 10) / 10;
}

const LIVE_OFF = {
  active: false, phase: null, estOut: 0, estTps: 0,
  sinceMs: 0, promptTokens: 0, source: "llama-slots",
};

// Read-only view over the poll-loop state machine (display only — the
// samples it reports were timestamped on the 50 ms decode poll grid).
// `used` is the tracked session's current context size (sessions.total_tokens),
// used only for the per-server correlation guard below.
function liveEstimate(used) {
  const sum = processingSummary(slotMonitor.state);
  if (!sum || Date.now() - slotMonitor.fetchedAt > 1000) return LIVE_OFF;
  if (sum.count === 0) return LIVE_OFF;
  const estOut = sum.estOut;
  const now = Date.now();
  // promptTokens comes from the state machine (updated on the poll grid from
  // the same snapshot), keeping the display consistent with the hand-off.
  const promptTokens = slotMonitor.promptTokens;
  let estTps = 0;
  if (slotMonitor.samples.length >= 2 && estOut > 0) {
    const a = slotMonitor.samples[0];
    const b = slotMonitor.samples[slotMonitor.samples.length - 1];
    if (b.n > a.n && b.t > a.t) {
      estTps = Math.round(((b.n - a.n) / ((b.t - a.t) / 1000)) * 10) / 10;
    }
  }
  // The slot is per-server, not per-session: only trust it when its prompt
  // size correlates with the tracked session's context size.
  const correlated =
    !used || Math.abs(promptTokens - used) <= Math.max(8192, used * 0.25);
  return {
    active: correlated,
    phase: estOut > 0 ? "decode" : "prompt",
    estOut,
    estTps,
    sinceMs: slotMonitor.startAt ? now - slotMonitor.startAt : 0,
    promptTokens,
    source: "llama-slots",
  };
}

// Rate of the last completed (non-compaction) response: its output tokens
// over (completion time - time its request was written to the DB).
let _lastTpsCache = { key: null, tps: 0, src: "db" };
function lastResponseTps(db, sessionId) {
  try {
    const last = db
      .prepare(
        `SELECT created_timestamp, output_tokens FROM usage_ledger
         WHERE session_id = ? AND is_compaction = 0
         ORDER BY created_timestamp DESC LIMIT 1`
      )
      .get(sessionId);
    if (!last) return { tps: 0, src: "db" };
    // Update the completion anchor for the poll loop's await window.
    slotMonitor.lastCompletionAt = toMs(last.created_timestamp);
    const key = sessionId + ":" + last.created_timestamp;
    if (_lastTpsCache.key === key) {
      return { tps: _lastTpsCache.tps, src: _lastTpsCache.src };
    }
    const start = db
      .prepare(
        `SELECT MAX(created_timestamp) t FROM messages
         WHERE session_id = ? AND created_timestamp <= ?`
      )
      .get(sessionId, last.created_timestamp);
    const startMs = start && start.t ? toMs(start.t) : toMs(last.created_timestamp) - 2000;
    const durMs = Math.max(1000, toMs(last.created_timestamp) - startMs);
    const out = last.output_tokens || 0;
    // Completion hand-off: exact DB token count over the live monitor's
    // ms-resolution duration (falls back to the DB's whole-second span).
    const hTps = handoffRate(out, slotHandoff, Date.now());
    const tps = hTps != null ? hTps : Math.round((out / (durMs / 1000)) * 10) / 10;
    const src = hTps != null ? "handoff" : "db";
    _lastTpsCache = { key, tps, src };
    return { tps, src };
  } catch {
    return { tps: 0, src: "db" }; // e.g. fixture DB without messages/is_compaction
  }
}

// ---------------------------------------------------------------------------
// Stats computation — the payload of get_context_stats.
// The DB is authoritative at completion boundaries; the live monitor is
// authoritative while decoding. tps/tpsMode precedence: live (decoding) >
// last (completed response, hand-off-calibrated) > 30 s rolling ledger.
// ---------------------------------------------------------------------------
const SESSION_COLUMNS = `id, name, provider_name, model_config_json, total_tokens,
              input_tokens, output_tokens, cache_read_tokens,
              accumulated_total_tokens, updated_at`;

function getSession(db, sessionId) {
  let row;
  if (sessionId) {
    row = db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         WHERE session_type = 'user' AND id = ?`
      )
      .get(sessionId);
  } else {
    row = db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         WHERE session_type = 'user'
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get();
  }
  if (!row) return null;

  let model = "";
  try {
    model = JSON.parse(row.model_config_json || "{}").model_name || "";
  } catch {
    model = "";
  }
  return { ...row, model };
}

function rollingTps(db, sessionId) {
  // Rows are one per completed LLM response, in ascending created_timestamp.
  const cutoff = Date.now() - TPS_WINDOW_MS;
  // SQL cutoff is unit-agnostic (seconds-scale value passes both s- and ms-
  // stores); the precise window filter happens below in JS.
  const rows = db
    .prepare(
      `SELECT created_timestamp, output_tokens FROM usage_ledger
       WHERE session_id = ? AND created_timestamp >= ?
       ORDER BY created_timestamp ASC`
    )
    .all(sessionId, Math.floor(cutoff / 1000));

  const inWindow = rows.filter((r) => toMs(r.created_timestamp) >= cutoff);
  if (inWindow.length === 0) return { tps: 0, samples: 0, lastAt: null };

  const newest = inWindow[inWindow.length - 1];
  const oldest = inWindow[0];
  const outTokens = inWindow.reduce((s, r) => s + (r.output_tokens || 0), 0);

  // Span from the oldest in-window sample to "now" gives a live-feeling rate
  // that decays naturally as new responses land.
  const spanMs = Math.max(1000, Date.now() - toMs(oldest.created_timestamp));
  const tps = outTokens / (spanMs / 1000);

  return {
    tps: Math.round(tps * 10) / 10,
    samples: inWindow.length,
    lastAt: toMs(newest.created_timestamp),
  };
}

function computeStats(explicitSessionId) {
  const db = openDb();
  if (!db) {
    return {
      ok: false,
      error:
        DatabaseSync === null
          ? "node:sqlite unavailable (need Node >= 22.5)"
          : `sessions.db not found at ${DB_PATH}`,
      dbPath: DB_PATH,
    };
  }

  const argId = (explicitSessionId || "").trim();
  const target = argId || AGENT_SESSION_ID;
  const sessionSource = argId
    ? "argument"
    : AGENT_SESSION_ID
      ? "agent_session_id"
      : "most_recent";

  let stats;
  try {
    const s = getSession(db, target);
    if (!s) {
      // A specifically requested session must not silently fall back to a
      // different chat — that would show the wrong numbers in the wrong HUD.
      stats = {
        ok: true,
        empty: true,
        dbPath: DB_PATH,
        ...(target ? { sessionId: target, note: "session not found in sessions.db" } : {}),
      };
    } else {
      const used = s.total_tokens ?? 0;
      const contextWindow = resolveContextWindow(s.model, s.provider_name);
      const pct = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
      const barTh = resolveBarThresholds();
      const rolling = rollingTps(db, s.id);
      setSlotsUrlForProvider(s.provider_name);
      setSlotsModel(s.model);
      const live = liveEstimate(used);
      const last = lastResponseTps(db, s.id);
      // Wake signal: a user message exists without a matching completion,
      // meaning generation is (probably) in progress. This lets the poll
      // loop wake from dormancy within one stats tick (~200 ms) of the
      // user hitting send, so the first response after a quiet gap still
      // gets live tok/s.
      try {
        const lastMsg = db.prepare(
          `SELECT MAX(created_timestamp) t FROM messages WHERE session_id = ?`
        ).get(s.id);
        const lastLedger = db.prepare(
          `SELECT MAX(created_timestamp) t FROM usage_ledger WHERE session_id = ?`
        ).get(s.id);
        slotMonitor.generationPending =
          lastMsg?.t != null && lastLedger?.t != null && lastMsg.t > lastLedger.t + 2;
      } catch {
        slotMonitor.generationPending = false;
      }
      const lastTps = last.tps;
      const tps = live.active ? live.estTps : lastTps > 0 ? lastTps : rolling.tps;
      const tpsMode = live.active ? "live" : lastTps > 0 ? "last" : "rolling";

      stats = {
        ok: true,
        sessionId: s.id,
        sessionName: s.name || "",
        sessionSource,
        model: s.model,
        provider: s.provider_name || "",
        used,
        contextWindow,
        pct: Math.round(pct * 10) / 10,
        compactionThreshold: barTh.compactionThreshold,
        warnPct: barTh.warnPct,
        dangerPct: barTh.dangerPct,
        tps,
        tpsMode,
        lastTps,
        lastSource: last.src,
        live,
        tpsSamples: rolling.samples,
        isStreaming: live.active,
        input: s.input_tokens ?? 0,
        output: s.output_tokens ?? 0,
        cacheRead: s.cache_read_tokens ?? 0,
        sessionTotal: s.accumulated_total_tokens ?? 0,
        lastResponseAt: rolling.lastAt,
        updatedAt: s.updated_at,
        dbPath: DB_PATH,
      };
    }
  } finally {
    db.close();
  }
  return stats;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "show_context_hud",
        description:
          "Shows the Context HUD — a small pinned indicator with live tokens/sec and total tokens used over the context window. It stays docked just above the chat input.",
        inputSchema: { type: "object", properties: {}, required: [] },
        // Declares the UI resource for this tool (MCP Apps spec: McpUiToolMeta).
        // goose reads this from the tool definition to attach the trusted
        // mcpApp payload that the desktop renderer needs to mount the app.
        _meta: { ui: { resourceUri: RESOURCE_URI } },
      },
      {
        name: "get_context_stats",
        description:
          "Returns live token stats for this session as JSON: tokens/sec (rolling), tokens used, context window, and percentages. Intended for the Context HUD; safe to poll.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description:
                "Optional sessions.db session id to report on. Defaults to the session this extension was started for (AGENT_SESSION_ID), else the most recently active user session.",
            },
            instance_id: {
              type: "string",
              description:
                "Internal HUD protocol: unique id of the polling HUD instance (random per window load). When present, the response includes pipClaim ('granted' | 'denied') — whether this instance holds the session's single popped-out HUD slot. Not intended for the model.",
            },
          },
          required: [],
        },
      },
      {
        name: "hud_claim",
        description:
          "Internal HUD protocol: claims the session's single popped-out HUD slot (the HUD calls this once at self-initialization; not intended for the model). The popped-out state is a singleton — inline HUDs may coexist. A fresh initialization takes over the slot when the current holder's claim is older than the takeover window, so /token-context always pops a new HUD; rapid successive claims (a theme-switch chat reload) are denied and render a placeholder.",
        inputSchema: {
          type: "object",
          properties: {
            instance_id: {
              type: "string",
              description: "Unique id of this HUD instance (random per window load).",
            },
            session_id: {
              type: "string",
              description:
                "Optional sessions.db session id to claim for. Defaults to the session this extension was started for (AGENT_SESSION_ID), else a shared 'auto' slot.",
            },
          },
          required: ["instance_id"],
        },
      },
    ],
  };
});

// Tool arguments arrive untyped over the wire; parse the string ones
// defensively in one place (trim included).
const argStr = (args, key) => (typeof args?.[key] === "string" ? args[key].trim() : "");

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === "show_context_hud") {
    return {
      content: [{ type: "text", text: "Context HUD is now pinned above the chat input." }],
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    };
  }

  if (name === "get_context_stats") {
    const args = request.params.arguments || {};
    const sessionId = argStr(args, "session_id");
    const stats = computeStats(sessionId);
    const instanceId = argStr(args, "instance_id");
    if (instanceId && stats && stats.ok !== false) {
      // Claim bookkeeping: the poll is the holder's liveness signal and
      // reports the current holder (the display state). It never changes
      // the holder — only an init-time claim does (v1.4.2).
      stats.pipClaim = refreshClaim(claimKeyFor(sessionId), instanceId);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(stats) }],
      structuredContent: stats,
    };
  }

  if (name === "hud_claim") {
    const args = request.params.arguments || {};
    const instanceId = argStr(args, "instance_id");
    if (!instanceId) {
      const err = { ok: false, error: "instance_id is required" };
      return {
        content: [{ type: "text", text: JSON.stringify(err) }],
        structuredContent: err,
      };
    }
    const res = {
      ok: true,
      granted: false,
      pipClaim: "denied",
      session: claimKeyFor(argStr(args, "session_id")),
    };
    res.pipClaim = claimSlot(res.session, instanceId); // init-time claim
    res.granted = res.pipClaim === "granted";
    return {
      content: [{ type: "text", text: JSON.stringify(res) }],
      structuredContent: res,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: RESOURCE_URI,
        name: "Context HUD",
        description: "Live tokens/sec + context-window usage indicator",
        mimeType: "text/html;profile=mcp-app",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === RESOURCE_URI) {
    return {
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
          text: APP_HTML,
          _meta: {
            ui: {
              csp: {
                connectDomains: [],
                resourceDomains: [],
                frameDomains: [],
                baseUriDomains: [],
              },
              prefersBorder: true,
            },
          },
        },
      ],
    };
  }
  throw new Error(`Resource not found: ${uri}`);
});

// True while the monitor should keep polling for the tail of the last
// completed response: within AWAIT_MS of the newest usage_ledger row
// (lastCompletionAt is refreshed by every stats call, which is what wakes
// the loop out of dormancy).
const inAwaitWindow = (now) =>
  slotMonitor.lastCompletionAt > 0 && now - slotMonitor.lastCompletionAt < AWAIT_MS;

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Completion-anchored poll loop:
  //   • 50 ms while a slot is decoding (tight hand-off boundary)
  //   • 100 ms within AWAIT_MS of the last DB completion (catches tool-loop
  //     bursts, re-enters for the next response in a multi-turn exchange)
  //   • 100 ms during SETTLE_MS after the last processing observation
  //     (tight end-boundary for the hand-off estimate)
  //   • HEARTBEAT_POLL_MS (1 s) when the backend bypass is unavailable and
  //     we're outside the settle window but still within the await window
  //     (limits router proxy log spam in the fallback case)
  //   • DORMANT: no /slots traffic at all beyond AWAIT_MS, so the backend's
  //     --sleep-idle-seconds countdown can elapse and VRAM is freed.
  // The HUD's 5 Hz stats polling reads the DB and updates
  // slotMonitor.lastCompletionAt, waking the loop when a new response lands.
  const pollLoop = () => {
    const now = Date.now();
    if (!isAnySlotProcessing() && !inAwaitWindow(now) && !slotMonitor.generationPending) {
      // Dormant — skip the HTTP fetch entirely. Re-check the condition
      // periodically; the stats handler updates lastCompletionAt (completion)
      // or generationPending (new user message) to wake the loop.
      setTimeout(pollLoop, DORMANT_POLL_MS);
      return;
    }

    pollSlots()
      .catch(() => false)
      .then((ok) => {
        if (ok) slotStateTransition(Date.now());
        const now2 = Date.now();
        const proc2 = isAnySlotProcessing();
        const settling =
          slotMonitor.lastProcEnd > 0 && now2 - slotMonitor.lastProcEnd < SETTLE_MS;
        const delay = proc2
          ? ACTIVE_POLL_MS
          : inAwaitWindow(now2) || slotMonitor.generationPending
            ? slotMonitor.backendUrl || settling
              ? IDLE_POLL_MS
              : HEARTBEAT_POLL_MS
            : DORMANT_POLL_MS;
        setTimeout(pollLoop, delay);
      });
  };
  pollLoop();
  console.error(
    `[token-context] running on stdio (db: ${DB_PATH}, session: ${AGENT_SESSION_ID || "auto"}, custom_providers: ${CUSTOM_PROVIDERS_DIR})`
  );
}

// Only start the MCP server when this file is the entry point — unit tests
// import the exported helpers (handoffRate, slotMonitor, slotStateTransition,
// resolveBarThresholds, backendUrlFromCatalog, slotHandoff) without spawning
// the stdio server. The exports exist for the test harness only; the real
// MCP surface is the three tools + one resource.
let isMain = true;
try {
  isMain = !!process.argv[1] && "file://" + process.argv[1] === import.meta.url;
} catch {
  isMain = true; // when in doubt, keep the previous behaviour
}
if (isMain) {
  main().catch((err) => {
    console.error("[token-context] fatal:", err);
    process.exit(1);
  });
}

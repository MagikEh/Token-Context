// Protocol + behavior tests for the token-context server.
//  Part A: fixtures (temp sessions.db + temp custom_providers dir) —
//          custom-provider context_limit, per-session stats, AGENT_SESSION_ID.
//  Part B: real db smoke test (tool _meta, resource, live stats).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// Resolve the server relative to this file so the suite runs from any checkout.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "server.js");
const {
  handoffRate,
  slotMonitor,
  slotHandoff,
  slotStateTransition,
  resolveBarThresholds,
} = await import(SERVER);
const fails = [];
const check = (name, cond) => {
  if (!cond) fails.push(name);
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
};

// ---------------------------------------------------------------------------
// Part A: fixtures
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "ctx-hud-"));
const cpDir = join(tmp, "custom_providers");
mkdirSync(cpDir);
writeFileSync(join(cpDir, "prov_a.json"), JSON.stringify({
  name: "custom_test_a",
  engine: "openai",
  base_url: "http://127.0.0.1:1/v1",
  models: [
    { name: "test-model-big", context_limit: 123456 },
    { name: "test-model-small", context_limit: 65536 },
  ],
}));
writeFileSync(join(cpDir, "prov_b.json"), JSON.stringify({
  name: "custom_test_b",
  engine: "openai",
  base_url: "http://127.0.0.1:2/v1",
  models: [{ name: "other-model", context_limit: 424242 }],
}));
// Fixture goose configs for the dynamic bar-threshold tests (root-level keys).
const cfgNone = join(tmp, "config-none.yaml");
writeFileSync(cfgNone, "extensions:\n  todo:\n    enabled: true\n");
const cfg06 = join(tmp, "config-0.6.yaml");
writeFileSync(cfg06, "GOOSE_AUTO_COMPACT_THRESHOLD: 0.6\n");
const cfg0 = join(tmp, "config-0.yaml");
writeFileSync(cfg0, "GOOSE_AUTO_COMPACT_THRESHOLD: 0\n");

const dbPath = join(tmp, "sessions.db");
{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT, session_type TEXT,
      provider_name TEXT, model_config_json TEXT,
      total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, accumulated_total_tokens INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, created_timestamp INTEGER,
      input_tokens INTEGER, output_tokens INTEGER
    );
  `);
  const ins = db.prepare(`INSERT INTO sessions
    (id, name, session_type, provider_name, model_config_json,
     total_tokens, input_tokens, output_tokens, cache_read_tokens,
     accumulated_total_tokens, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  ins.run("sess-old", "Old Chat", "user", "custom_test_a",
    JSON.stringify({ model_name: "test-model-big" }),
    10000, 9000, 1000, 8000, 99999, now - 600000);
  ins.run("sess-new", "New Chat", "user", "custom_test_b",
    JSON.stringify({ model_name: "other-model" }),
    20000, 18000, 2000, 15000, 88888, now - 1000);
  ins.run("sess-plain", "Plain Chat", "user", "anthropic",
    JSON.stringify({ model_name: "claude-sonnet-4" }),
    30000, 27000, 3000, 2000, 77777, now - 300000);
  const led = db.prepare(`INSERT INTO usage_ledger
    (session_id, created_timestamp, input_tokens, output_tokens)
    VALUES (?,?,?,?)`);
  led.run("sess-old", now - 4000, 100, 400); // inside the 30s rolling window
  led.run("sess-new", now - 2000, 100, 300);
  db.close();
}

async function connectServer(envOverrides) {
  const env = { ...process.env };
  delete env.GOOSE_CONTEXT_WINDOW;
  delete env.GOOSE_SESSIONS_DB;
  delete env.GOOSE_CUSTOM_PROVIDERS_DIR;
  delete env.GOOSE_CONFIG_PATH;
  delete env.GOOSE_AUTO_COMPACT_THRESHOLD;
  delete env.AGENT_SESSION_ID;
  const client = new Client({ name: "tester", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [SERVER],
      env: {
        ...env,
        GOOSE_SESSIONS_DB: dbPath,
        GOOSE_CUSTOM_PROVIDERS_DIR: cpDir,
        GOOSE_CONFIG_PATH: cfgNone,
        ...envOverrides,
      },
      stderr: "pipe",
    })
  );
  return client;
}

console.log("=== Part A: fixtures (custom providers + per-session) ===");
{
  const c = await connectServer({});
  const stats = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);

  let r = stats(await c.callTool({ name: "get_context_stats", arguments: {} }));
  check("no-arg default = most recently updated session", r.sessionId === "sess-new");
  check("custom provider context_limit used (prov_b/other-model = 424242)",
    r.contextWindow === 424242);
  check("sessionSource = most_recent", r.sessionSource === "most_recent");
  check("dynamic thresholds: red on compaction point (default 80 %), yellow 80 % of red",
    r.compactionThreshold === 0.8 && r.dangerPct === 80 && r.warnPct === 64);

  r = stats(await c.callTool({ name: "get_context_stats", arguments: { session_id: "sess-old" } }));
  check("session_id arg selects sess-old", r.sessionId === "sess-old");
  check("custom provider context_limit used (prov_a/test-model-big = 123456)",
    r.contextWindow === 123456);
  check("sessionSource = argument", r.sessionSource === "argument");
  check("rolling tps > 0 from usage_ledger", r.tps > 0 && r.tpsSamples === 1);

  r = stats(await c.callTool({ name: "get_context_stats", arguments: { session_id: "sess-plain" } }));
  check("non-custom model falls through to built-in table (claude-sonnet-4 = 200000)",
    r.contextWindow === 200000);

  r = stats(await c.callTool({ name: "get_context_stats", arguments: { session_id: "does-not-exist" } }));
  check("unknown session_id -> empty (no silent cross-chat fallback)",
    r.ok === true && r.empty === true && r.note && r.sessionId === "does-not-exist");

  await c.close();
}
{
  // Simulates goose starting the extension for one specific session.
  const c = await connectServer({ AGENT_SESSION_ID: "sess-old" });
  const r = (await c.callTool({ name: "get_context_stats", arguments: {} }))
    .structuredContent;
  check("AGENT_SESSION_ID env selects that session for no-arg polls",
    r.sessionId === "sess-old" && r.contextWindow === 123456);
  check("sessionSource = agent_session_id", r.sessionSource === "agent_session_id");
  await c.close();
}
{
  // GOOSE_CONTEXT_WINDOW still overrides everything.
  const c = await connectServer({ GOOSE_CONTEXT_WINDOW: "777" });
  const r = (await c.callTool({
    name: "get_context_stats",
    arguments: { session_id: "sess-old" },
  })).structuredContent;
  check("GOOSE_CONTEXT_WINDOW overrides custom provider", r.contextWindow === 777);
  await c.close();
}
{
  // v1.3.9: thresholds track the session's auto-compaction point.
  const c = await connectServer({ GOOSE_CONFIG_PATH: cfg06 });
  const r = (await c.callTool({
    name: "get_context_stats",
    arguments: { session_id: "sess-new" },
  })).structuredContent;
  check("config 0.6 → red 60 %, yellow 48 % (80 % of red)",
    r.compactionThreshold === 0.6 && r.dangerPct === 60 && r.warnPct === 48);
  await c.close();
}
{
  const c = await connectServer({
    GOOSE_CONFIG_PATH: cfg06,
    GOOSE_AUTO_COMPACT_THRESHOLD: "0.75",
  });
  const r = (await c.callTool({
    name: "get_context_stats",
    arguments: { session_id: "sess-new" },
  })).structuredContent;
  check("env 0.75 beats config 0.6 → red 75 %, yellow 60 %",
    r.compactionThreshold === 0.75 && r.dangerPct === 75 && r.warnPct === 60);
  await c.close();
}
{
  const c = await connectServer({ GOOSE_CONFIG_PATH: cfg0 });
  const r = (await c.callTool({
    name: "get_context_stats",
    arguments: { session_id: "sess-new" },
  })).structuredContent;
  check("disabled (0) → legacy red 90 %, yellow 72 %",
    r.compactionThreshold === 0 && r.dangerPct === 90 && r.warnPct === 72);
  await c.close();
}

// ---------------------------------------------------------------------------
// Part B: real db smoke test (unchanged behavior)
// ---------------------------------------------------------------------------
console.log("\n=== Part B: real db smoke test ===");
{
  const realEnv = { ...process.env };
  delete realEnv.AGENT_SESSION_ID;
  delete realEnv.GOOSE_CONTEXT_WINDOW;
  delete realEnv.GOOSE_SESSIONS_DB;
  delete realEnv.GOOSE_CUSTOM_PROVIDERS_DIR;
  const c = new Client({ name: "tester", version: "0.0.1" });
  await c.connect(
    new StdioClientTransport({ command: "node", args: [SERVER], env: realEnv, stderr: "pipe" })
  );

  const tools = await c.listTools();
  check("tools listed", tools.tools.some((t) => t.name === "show_context_hud")
    && tools.tools.some((t) => t.name === "get_context_stats"));
  const hudTool = tools.tools.find((t) => t.name === "show_context_hud");
  check("tool definition _meta.ui.resourceUri",
    hudTool?._meta?.ui?.resourceUri === "ui://token-context/hud");
  const statsTool = tools.tools.find((t) => t.name === "get_context_stats");
  check("get_context_stats accepts optional session_id",
    !!statsTool?.inputSchema?.properties?.session_id
    && !statsTool.inputSchema.required?.includes("session_id"));

  const r1 = await c.callTool({ name: "show_context_hud", arguments: {} });
  check("show_context_hud returns ui _meta",
    r1._meta?.ui?.resourceUri === "ui://token-context/hud");
  console.log("text:", r1.content?.[0]?.text);

  const r2 = await c.callTool({ name: "get_context_stats", arguments: {} });
  const s = r2.structuredContent ?? JSON.parse(r2.content[0].text);
  console.log("stats:", JSON.stringify(s));
  check("real db stats ok", s.ok === true);
  check("stats expose lastSource (db|handoff)", s.lastSource === "db" || s.lastSource === "handoff");
  check("stats carry dynamic bar thresholds (yellow = 80 % of red)",
    typeof s.dangerPct === "number" && typeof s.warnPct === "number" &&
    s.dangerPct > 0 && s.warnPct > 0 && s.warnPct < s.dangerPct &&
    Math.abs(s.warnPct - 0.8 * s.dangerPct) <= 0.05);

  const res = await c.listResources();
  check("resource listed", res.resources.some((x) => x.uri === "ui://token-context/hud"));
  const rd = await c.readResource({ uri: "ui://token-context/hud" });
  check("resource mimeType", rd.contents[0].mimeType === "text/html;profile=mcp-app");
  check("resource CSP meta", !!rd.contents[0]._meta?.ui?.csp);
  await c.close();
}

rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Part C: completion hand-off unit checks (pure function)
// ---------------------------------------------------------------------------
console.log("\n=== Part C: handoff unit checks ===");
{
  const now = Date.now();
  const h = { at: now, tokens: 1683, elapsedMs: 27230 };
  check("handoff: fresh+matching → exact tokens / ms duration (1683/27.23s = 61.8)",
    handoffRate(1683, h, now) === 61.8);
  check("handoff: stale (>15s) → null",
    handoffRate(1683, { ...h, at: now - 16_000 }, now) === null);
  check("handoff: token mismatch (another response) → null",
    handoffRate(42, h, now) === null);
  check("handoff: absent handoff → null",
    handoffRate(1683, { at: 0, tokens: 0, elapsedMs: 0 }, now) === null);
  check("handoff: short-response tolerance (±32) accepted",
    handoffRate(100, { at: now, tokens: 118, elapsedMs: 2000 }, now) === 50.0);
  check("offset: +130ms extends duration (100/2.13s = 46.9)",
    handoffRate(100, { at: now, tokens: 100, elapsedMs: 2000 }, now, 130) === 46.9);
  check("offset: clamp — duration never < 100ms (100/0.1s = 1000.0)",
    handoffRate(100, { at: now, tokens: 100, elapsedMs: 2000 }, now, -1950) === 1000.0);
}

// ---------------------------------------------------------------------------
// Part D: poll-loop state machine + midpoint hand-off boundaries (v1.3.3)
// ---------------------------------------------------------------------------
console.log("\n=== Part D: state machine + midpoint hand-off ===");
{
  const reset = () => {
    slotMonitor.wasProc = false;
    slotMonitor.startAt = null;
    slotMonitor.samples = [];
    slotMonitor.lastIdleT = 0;
    slotMonitor.promptTokens = 0;
    slotHandoff.at = 0;
    slotHandoff.tokens = 0;
    slotHandoff.elapsedMs = 0;
  };
  const proc = (t, n) => {
    slotMonitor.state = [{ id: 0, is_processing: true, n_prompt_tokens: 1000, next_token: [{ n_decoded: n }] }];
    slotStateTransition(t);
  };
  const idle = (t) => {
    slotMonitor.state = [{ id: 0, is_processing: false, n_prompt_tokens: 1000, next_token: [] }];
    slotStateTransition(t);
  };

  // D1: grid-bias removal. 100ms idle grid / 50ms active grid:
  //   idle poll t=100, first proc poll t=150, last proc sample t=750,
  //   idle poll t=800. True start ∈ (100,150], true end ∈ (750,800].
  //   Midpoint estimate: (750+800)/2 − (100+150)/2 = 775 − 125 = 650
  //   (naive first→last would be 600 — a 50ms systematic shortfall).
  reset();
  idle(100);
  proc(150, 5);
  proc(200, 15);
  proc(750, 45);
  idle(800);
  check("midpoint: elapsed = 650 (775−125), not naive 600", slotHandoff.elapsedMs === 650);
  check("midpoint: final token count carried (45)", slotHandoff.tokens === 45);
  check("midpoint: handoff timestamped at the idle poll (800)", slotHandoff.at === 800);
  check("pipeline: DB row consumed via captured handoff (45/0.65s = 69.2)",
    handoffRate(45, slotHandoff, slotHandoff.at + 5000) === 69.2);
  check("state machine: cleared after idle (wasProc/samples/startAt)",
    slotMonitor.wasProc === false && slotMonitor.samples.length === 0 && slotMonitor.startAt === null);
  check("state machine: lastIdleT tracks idle polls", slotMonitor.lastIdleT === 800);

  // D2: no prior idle observation (server just started) → startEst = startAt.
  reset();
  proc(150, 10);
  proc(750, 30);
  idle(800);
  check("midpoint: no prior idle → fallback (elapsed 775−150 = 625)", slotHandoff.elapsedMs === 625);

  // D3: sanity guard — windows under 500ms rejected (background blips).
  reset();
  idle(100);
  proc(150, 5);
  idle(500);
  check("midpoint: <500ms window rejected (no hand-off cached)", slotHandoff.at === 0);

  // D4: samples accumulate on the active grid while processing.
  reset();
  idle(100);
  proc(150, 5);
  proc(200, 15);
  proc(250, 25);
  check("state machine: samples accumulate, startAt on first proc poll",
    slotMonitor.samples.length === 3 && slotMonitor.startAt === 150);
  check("state machine: promptTokens tracked", slotMonitor.promptTokens === 1000);
}

// ---------------------------------------------------------------------------
// Part E: dynamic bar-threshold resolution units (v1.3.9)
// ---------------------------------------------------------------------------
console.log("\n=== Part E: dynamic bar thresholds (v1.3.9) ===");
{
  const unitTmp = mkdtempSync(join(tmpdir(), "ctx-hud-unit-"));
  const cfgFixture = join(unitTmp, "config.yaml");
  const savedEnv = process.env.GOOSE_AUTO_COMPACT_THRESHOLD;
  const savedCfg = process.env.GOOSE_CONFIG_PATH;
  try {
    delete process.env.GOOSE_AUTO_COMPACT_THRESHOLD;
    process.env.GOOSE_CONFIG_PATH = join(unitTmp, "does-not-exist.yaml");

    check("default (unset) → 0.8 / red 80 / yellow 64",
      JSON.stringify(resolveBarThresholds()) ===
      JSON.stringify({ compactionThreshold: 0.8, dangerPct: 80, warnPct: 64 }));

    writeFileSync(cfgFixture, "GOOSE_AUTO_COMPACT_THRESHOLD: 0.75\n");
    process.env.GOOSE_CONFIG_PATH = cfgFixture;
    check("config 0.75 → red 75 / yellow 60",
      JSON.stringify(resolveBarThresholds()) ===
      JSON.stringify({ compactionThreshold: 0.75, dangerPct: 75, warnPct: 60 }));

    process.env.GOOSE_AUTO_COMPACT_THRESHOLD = "0.5";
    check("env 0.5 beats config 0.75 → red 50 / yellow 40",
      JSON.stringify(resolveBarThresholds()) ===
      JSON.stringify({ compactionThreshold: 0.5, dangerPct: 50, warnPct: 40 }));

    delete process.env.GOOSE_AUTO_COMPACT_THRESHOLD;
    writeFileSync(cfgFixture, "GOOSE_AUTO_COMPACT_THRESHOLD: 0\n");
    check("disabled (0) → legacy red 90 / yellow 72",
      JSON.stringify(resolveBarThresholds()) ===
      JSON.stringify({ compactionThreshold: 0, dangerPct: 90, warnPct: 72 }));

    writeFileSync(cfgFixture, "GOOSE_AUTO_COMPACT_THRESHOLD: 1.5\n");
    check("invalid value (1.5) ignored → default 80/64",
      JSON.stringify(resolveBarThresholds()) ===
      JSON.stringify({ compactionThreshold: 0.8, dangerPct: 80, warnPct: 64 }));

    writeFileSync(cfgFixture, "GOOSE_AUTO_COMPACT_THRESHOLD: banana\n");
    check("non-numeric value ignored → default 80/64",
      JSON.stringify(resolveBarThresholds()) ===
      JSON.stringify({ compactionThreshold: 0.8, dangerPct: 80, warnPct: 64 }));
  } finally {
    if (savedEnv === undefined) delete process.env.GOOSE_AUTO_COMPACT_THRESHOLD;
    else process.env.GOOSE_AUTO_COMPACT_THRESHOLD = savedEnv;
    if (savedCfg === undefined) delete process.env.GOOSE_CONFIG_PATH;
    else process.env.GOOSE_CONFIG_PATH = savedCfg;
    rmSync(unitTmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Part F: HUD pop-out claim (v1.4.0) — one popped-out HUD per session
// ---------------------------------------------------------------------------
console.log("\n=== Part F: hud_claim popped-out slot (v1.4.2) ===");
// Part A's fixture dir was deleted after Part B (rmSync tmp), so Part F
// builds its own fresh fixture (its stats polls need a live sessions.db).
const ftmp = mkdtempSync(join(tmpdir(), "ctx-hudF-"));
const fCpDir = join(ftmp, "custom_providers");
mkdirSync(fCpDir);
writeFileSync(join(fCpDir, "prov_a.json"), JSON.stringify({
  name: "custom_test_a",
  engine: "openai",
  base_url: "http://127.0.0.1:1/v1",
  models: [{ name: "test-model-big", context_limit: 123456 }],
}));
writeFileSync(join(fCpDir, "prov_b.json"), JSON.stringify({
  name: "custom_test_b",
  engine: "openai",
  base_url: "http://127.0.0.1:2/v1",
  models: [{ name: "other-model", context_limit: 424242 }],
}));
const fDbPath = join(ftmp, "sessions.db");
{
  const db = new DatabaseSync(fDbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT, session_type TEXT,
      provider_name TEXT, model_config_json TEXT,
      total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, accumulated_total_tokens INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT, created_timestamp INTEGER,
      input_tokens INTEGER, output_tokens INTEGER
    );
  `);
  const ins = db.prepare(`INSERT INTO sessions
    (id, name, session_type, provider_name, model_config_json,
     total_tokens, input_tokens, output_tokens, cache_read_tokens,
     accumulated_total_tokens, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const fnow = Date.now();
  ins.run("sess-old", "Old Chat", "user", "custom_test_a",
    JSON.stringify({ model_name: "test-model-big" }),
    10000, 9000, 1000, 8000, 99999, fnow - 600000);
  ins.run("sess-new", "New Chat", "user", "custom_test_b",
    JSON.stringify({ model_name: "other-model" }),
    20000, 18000, 2000, 15000, 88888, fnow - 1000);
  db.close();
}

{
  const c = await connectServer({
    GOOSE_SESSIONS_DB: fDbPath,
    GOOSE_CUSTOM_PROVIDERS_DIR: fCpDir,
  });
  const call = (name, args) => c.callTool({ name, arguments: args });
  const j = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);

  let r = j(await call("hud_claim", { instance_id: "inst-A" }));
  check("first instance claims the popped-out slot",
    r.ok === true && r.granted === true && r.pipClaim === "granted");

  r = j(await call("hud_claim", { instance_id: "inst-B" }));
  check("rapid second init (remount cascade) is denied while the claim is fresh",
    r.ok === true && r.granted === false && r.pipClaim === "denied");

  r = j(await call("hud_claim", { instance_id: "inst-A" }));
  check("holder re-claim refreshes (still granted)",
    r.ok === true && r.granted === true && r.pipClaim === "granted");

  r = j(await call("get_context_stats", { instance_id: "inst-B" }));
  check("stats carry pipClaim for a polling non-holder (denied)",
    r.sessionId === "sess-new" && r.pipClaim === "denied");

  r = j(await call("get_context_stats", { instance_id: "inst-A" }));
  check("stats carry pipClaim granted for the holder", r.pipClaim === "granted");

  r = j(await call("get_context_stats", { session_id: "sess-new" }));
  check("stats without instance_id stay untouched by the claim system",
    r.pipClaim === undefined);

  r = j(await call("hud_claim", {}));
  check("hud_claim without instance_id is a clean error",
    r.ok === false && !!r.error);
  await c.close();
}
{
  // Takeover (v1.4.2): a fresh init takes the popped-out slot once the
  // holder's claim is older than the takeover window; rapid claims — the
  // theme-switch remount cascade — are denied.
  const c = await connectServer({
    GOOSE_HUD_CLAIM_TAKEOVER_MS: "250",
    GOOSE_SESSIONS_DB: fDbPath,
    GOOSE_CUSTOM_PROVIDERS_DIR: fCpDir,
  });
  const call = (name, args) => c.callTool({ name, arguments: args });
  const j = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  let r = j(await call("hud_claim", { instance_id: "inst-A" }));
  check("takeover: A claims the popped-out slot", r.granted === true);
  r = j(await call("hud_claim", { instance_id: "inst-B" }));
  check("takeover: B denied while A's claim is fresh", r.granted === false);

  await sleep(450); // A's claim becomes older than the takeover window
  r = j(await call("hud_claim", { instance_id: "inst-B" }));
  check("takeover: B's later init takes the popped-out slot", r.granted === true);

  r = j(await call("get_context_stats", { instance_id: "inst-B" }));
  check("takeover: B's stats poll reports granted (B is now the holder)",
    r.pipClaim === "granted");
  r = j(await call("get_context_stats", { instance_id: "inst-A" }));
  check("takeover: displaced A degrades (its stats poll reports denied)",
    r.pipClaim === "denied");
  await c.close();
}

rmSync(ftmp, { recursive: true, force: true });
if (fails.length) {
  console.error("\nFAILURES:", fails);
  process.exit(1);
}
console.log("\nALL TESTS PASSED");
process.exit(0);

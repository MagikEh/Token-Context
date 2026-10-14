# Changelog

All notable changes to Token Context. The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.4.5] — 2026-10-14

### Refactor — code cleanup (no user-visible changes)

A zero-context-readability pass over `server.js`. All behaviour is unchanged — the full 82-check suite passes unmodified.

- **Sections reordered to dependency order** (top of file → bottom): SQLite access → context-window resolution → shared stats primitives → HUD claim broker → live `/slots` monitor → stats computation → MCP server → entry point. `computeStats` and `resolveContextWindow` no longer reference code defined below them, and the stats engine no longer sits under the "HUD pop-out claim" banner (it was always stats code).
- **Duplicated resets extracted**: the backend cache and decode timeline were both reset field-by-field at 4 and 2 sites respectively; they are now `clearBackendCache()` / `resetSlotTimeline()` with the invariant (per-model state) documented in one place.
- **Duplicated snapshot scans extracted**: `slotStateTransition`, `isAnySlotProcessing`, and `liveEstimate` each re-derived the same "processing slots" summary (count / max `n_decoded` / max prompt tokens); they now share `processingSummary()`.
- **Small dedups**: the await-window predicate (used twice in the poll loop) is `inAwaitWindow()`; tool-argument parsing in the call handler is `argStr()`; the percent-rounding helper is module-level `round2`.
- **Config reads are uniformly on-demand**: `GOOSE_LOCAL_MODEL_SETTINGS` context sizes were cached at module load while every other config read was fresh per stats call; they are now read on demand, so a config edit (or a config file briefly unreadable at startup) applies without an extension restart.
- **API surface trimmed**: `setSlotsModel` / `captureHandoff` were exported but consumed only internally — the exports exist for the test harness only, and that convention is now documented.
- **Docs**: the header env-var list now covers all knobs (grouped), the stale `1.4.3` server version constant is fixed (matched `package.json`), and WHY comments explain the decisions a maintainer would otherwise have to rediscover (freshness of config reads, completion-anchored dormancy in the monitor banner, the `liveEstimate` correlation guard).

## [1.4.4] — 2026-10-14

### Changed — completion-anchored polling (VRAM sleep fix)

`/slots` is **not** in llama.cpp's sleep-timer-exempt list (only `/health`, `/props`, `/models`, `/metrics` are), so *any* steady `/slots` polling — even a 1 Hz heartbeat — resets the `--sleep-idle-seconds` countdown and keeps ~23 GB of VRAM resident indefinitely.

The poll loop is now **completion-anchored**: it polls only for a bounded window after the last DB-completed response, then goes fully dormant (zero `/slots` traffic) so the backend's sleep timer can actually elapse and VRAM is freed.

- **50 ms** while a slot is decoding (tight hand-off boundary measurement).
- **100 ms** within `GOOSE_SLOT_AWAIT_MS` (default 120 s) of the last `usage_ledger` completion — catches tool-loop bursts and multi-turn exchanges.
- **Dormant** (no HTTP) beyond the await window. The HUD's 5 Hz stats polling reads the DB and refreshes the completion anchor, waking the monitor when a new response lands.
- The existing tiered cadence (settle → heartbeat) is retained as a sub-tier within the await window for routers without the silent backend bypass.
- Two new env vars: `GOOSE_SLOT_AWAIT_MS` (default 120 000) and `GOOSE_SLOT_DORMANT_POLL_MS` (default 5 000, the re-check interval while dormant — no network I/O).

Trade-off: the first response after a quiet gap (>120 s) loses the live tok/s dot and falls back to the DB whole-second rate. In practice the HUD is always polling stats at 5 Hz, so the anchor is always fresh for active sessions.

## [1.4.3] — 2026-10-13

### Fixed — live tok/s for llama.cpp in router mode (`--models-preset`)

Router mode — one `llama-server` port serving many models, loaded on demand — broke the live tok/s feed: a router refuses a bare `GET /slots` with HTTP 400 `"model name is missing"`, and per-model state lives at `GET /slots?model=<name>`. The monitor treated the 400 as a plain fetch failure, so it never saw a processing slot and the HUD stayed on the `last` (completed-response) rate.

- **Router detection**: a single-model llama-server always answers `/slots` with an array, so a JSON object response marks a model ROUTER — detected on the first poll, logged once to stderr.
- **Model-scoped polling**: from then on the request carries the tracked session's model (`/slots?model=<name>`), refreshed on every stats call; switching sessions/models discards the previous model's decode samples so its hand-off can't be attributed to the wrong session.
- **Graceful degradation**: a model-scoped request that comes back empty (model currently unloaded, router momentarily wedged) is not counted as a fetch failure; a session with no model name simply falls back to the idle feed.
- **Single-model servers unchanged**: the bare endpoint is still used as before, and a bare `/slots` that answers with a plain array clears the router flag if it was ever set.

### Changed — silent /slots polling (backend bypass + tiered cadence)

A router logs one line per PROXIED request, so the steady 10 Hz poll spammed the server log 10 lines/s even while idle. The monitor now talks to the model's **backend directly**: the router's router-local `GET /v1/models` catalog advertises each loaded model's backend host/port (in `status.args`), and once discovered the poll targets the backend's own `/slots` — verified silent. Routers without a usable catalog keep working via the router endpoint, whose cadence is now tiered: 50 ms decoding → 100 ms for `GOOSE_SLOT_SETTLE_MS` (default 10 s) after activity → `GOOSE_SLOT_HEARTBEAT_MS` (default 1 s) until the next activity. The backend cache is re-validated every `GOOSE_SLOT_REVALIDATE_MS` (default 60 s) because an evicted model's backend can stay alive-but-sleeping (`--sleep-idle-seconds`) with a stale port, and after 3 consecutive misses (LRU swap → new port).

Verified: full suite green (Part G now covers single-mode regression, router detection, catalog→URL extraction, the backend bypass, LRU-swap re-validation, and the measured settle→heartbeat cadence) plus live probes: the real router's `/v1/models` exposes the backend port, and direct backend `/slots` polls produced zero log lines.

Verified: full suite green (new Part G covers single-mode regression, router detection, model switching, unknown-model degradation) plus a live probe against a real 5-model router showing `n_decoded` incrementing per poll during a decode.

## [1.4.2] — 2026-09-28

### Changed — the popped-out state is a singleton, not the HUD itself

The v1.4.0 claim protocol fixed theme-switch spam, but the slot holder was fixed for good: a minimized (✕) or dead holder blocked new HUDs until its TTL expired. 1.4.2 makes the *state* — not a specific guest — the thing being held.

- **Takeover on fresh init**: a new self-initialization takes the slot over once the current holder's claim is older than `GOOSE_HUD_CLAIM_TAKEOVER_MS` (default 10 s). `/token-context` now pops a new HUD at any time — no hunting for the inline one.
- **Displaced holders degrade gracefully**: a guest that was `granted` at init but receives `denied` on a later poll (because a newer HUD took over) best-effort requests `inline` to close its own popped window, then renders the placeholder.
- **Rapid-successive-claim guard**: claims arriving in quick succession (a chat reload remounts every past HUD card within seconds on a theme switch) are all denied — a theme flip yields exactly one popped-out window, placeholders on the rest.
- **Polls are observation-only**: `get_context_stats` now carries the `instance_id` and reports `pipClaim` (`granted` / `denied`); polls never change the holder.
- **Fail-open**: if `hud_claim` is unavailable (older server), the guest falls back to the legacy unconditional pip request.

Verified live: full restart → one HUD pops; ✕ minimizes to inline; re-trigger → new HUD pops and the old one shows the placeholder; theme flips → still exactly one popped-out window.

## [1.4.0]

### Fixed — one popped-out HUD per session (theme-switch dedupe)

Switching the goose theme (light/dark/aura/system) reloads the chat and re-renders every historical tool result — and each one carries `_meta.ui.resourceUri`, so every past `show_context_hud` card re-boots its guest. Previously every re-boot unconditionally requested `ui/request-display-mode { mode: "pip" }`, so a chat with N past HUD triggers spawned N new "Playing in Picture-in-Picture" windows on each theme switch.

The MCP Apps protocol has no cross-instance coordination, so the *server* brokers a single popped-out slot per session:

- Each guest instance generates a random `instance_id` per window load and calls the `hud_claim` tool **at self-initialization, before** requesting pip. Only the instance granted at its own init ever requests pip; every other instance stays inline with a compact placeholder — "Token Context — HUD already pinned in this session" (`.dup`).
- Liveness TTL: dead holders are released after `GOOSE_HUD_CLAIM_TTL_MS` (default 3 s; test hook).
- The goose PiP window's close button only **minimizes** the HUD to inline (the guest stays alive and keeps polling) — the next `/token-context` init takes the slot over (see 1.4.2).

## [1.3.9]

- Context-bar triggers became **dynamic**: the red trigger sits exactly on the session's auto-compaction point (`GOOSE_AUTO_COMPACT_THRESHOLD`, goose default 80 %, read from the environment or a root key of `config.yaml`), and the yellow one sits at 80 % of it — both scale together for any context window. The legacy 90 % red point is kept when auto-compaction is disabled.

## [1.3.8] — [1.3.5]

- Context-bar zone tints (warm tint between the triggers, red tint from the red trigger to 100 %) painted on the empty track, with 1 px trigger-coloured ticks (amber at the warn trigger, red at the compaction point) that stay visible once the bar turns yellow/red; hover raises the zone tints to nearly full strength (rest softened to 18/22 %). Marker positions derive from the same `warnPct` / `dangerPct` as the colour toggles, so they can't drift.

## [1.3.4]

- Hand-off validation on a local llama.cpp setup with `GOOSE_TPS_OFFSET_MS=120`: on clean single-generation replies the HUD's idle last rate agrees with goose's footer to ~2 % (26.2 tokens/13.6 s → 19.3 vs 19.0 tok/s, +1.6 %). Messages that trigger tool calls mid-stream are not comparable — goose's footer spans the whole message including the tool-execution gap, while the hand-off measures only the final generation segment.

## [1.3.3]

- The slot state machine is now driven by the `/slots` poll loop itself (50 ms while decoding, 100 ms idle), and both boundaries of the hand-off window are estimated at the *midpoint* of their polling grid cells — removing the systematic grid bias (≈30 ms typical error: ~1 % on a 3 s reply, <0.3 % on long ones).

## [1.3.1]

- **Completion hand-off**: when a live slot goes idle at the end of a response, the monitor keeps the final decoded-token count and millisecond-resolution elapsed time. When the new `usage_ledger` row lands, the idle **last** rate is computed as the exact DB token count over that precise duration (instead of the DB's whole-second timestamps), so the HUD's idle rate closely matches goose's per-message tok/s footer. `stats.lastSource` reports which path was used (`handoff` vs `db`).

## [1.3.0] — live rates, live context bar, colour states

Root cause of the two reported bugs: goose writes `sessions.db` **only at response-completion boundaries** — during streaming the DB is completely blind, so a HUD that only reads the DB could never show a changing tok/s (the `usage_ledger` row doesn't exist yet) or an active streaming dot.

- **Live `/slots` monitor**: for local llama.cpp servers the server polls the model server's `/slots` endpoint on an adaptive cadence — 50 ms while a slot is `is_processing`, 100 ms when idle (URL derived from the custom provider's `base_url`; disable with `GOOSE_SLOTS_URL=""`, cadences via `GOOSE_SLOT_ACTIVE_POLL_MS` / `GOOSE_SLOT_POLL_MS`). While decoding it reports a live estimate from `next_token[0].n_decoded` (the model server's own output-token counter) over an 8 s rolling sample window. Because the slot is per-server, the estimate is only trusted while the slot's measured prompt size correlates with the tracked session's context size (±25 %, min 8 k tokens).
- **Pre-fetch context bar**: during a live stream the context bar shows a pre-fetched estimate — `~<prompt tokens + decoded so far>` (marked `(est)`) — so it climbs in real time as the response grows. When the response completes, the estimate stops being reported and the authoritative DB value snaps in.
- **tok/s states**: `live` (real-time decode rate, green pulsing dot) → `warming` (prompt phase, no decode yet) → `last` (idle: rate of the last completed response, muted) → 30 s rolling ledger fallback.
- **Context bar colours**: green `ok` below the warn trigger, amber `warn` between the triggers, red `danger` at/above the red trigger.

## [1.1.0]

- **Per-session stats**: each chat's HUD now reports on its own chat. Goose injects `AGENT_SESSION_ID` into the stdio extension process of the session the extension was added to, and the server uses it. `get_context_stats` also accepts an optional `session_id` argument (e.g. for checking other chats); if a specifically requested session can't be found, the HUD says "no active session" instead of silently showing another chat's numbers.
- **Custom provider context window**: the context window now comes from `models[*].context_limit` in `~/.config/goose/custom_providers/*.json`, matched by the session's provider name + model name (dir overridable via `GOOSE_CUSTOM_PROVIDERS_DIR`). `GOOSE_CONTEXT_WINDOW` still overrides everything; the old fallbacks (built-in model table, local config, 200000) remain for models without a custom provider entry.
- **Dark mode**: the guest mirrors the host's resolved theme as its own `color-scheme` (initial host context and live `host-context-changed` theme switches), so the host's `light-dark(...)` color variables resolve to the dark palette when goose is in dark mode.
- **PiP sizing / fullscreen→PiP scrollbar**: the guest paints its own themed background and reports a display-mode-aware size — natural content height in inline mode, and the fixed PiP frame (400×300) minus a few border pixels in pip/fullscreen — re-reporting whenever the display mode changes. Removes the stale oversized-iframe scrollbar and the gray double-height gap. (The PiP frame itself is a fixed 400×300 on the goose side; the HUD fills it rather than floating with margins.)

## [1.0.0]

- Initial release: HUD pinned in the PiP slot above the chat input, refreshed 5×/s by polling `get_context_stats`. Shows rolling tok/s over the last 30 s of completed responses, the session's used/window context gauge, and the input/output/cache-read footer. Reads `sessions.db` read-only (WAL); context window resolved from env var → built-in model table → local-provider config → 200000.

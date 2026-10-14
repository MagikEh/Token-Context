# Development

## Prerequisites

- **Node.js ≥ 22.5** (the server uses the built-in `node:sqlite`; `package.json` enforces this via `engines`).
- **No build step.** `server.js` is plain ESM, `index.html` is a static document. `npm install` only fetches `@modelcontextprotocol/sdk`; `node_modules/` is a runtime dependency and must stay in place (the server is launched directly as `node /path/to/server.js`).

## Tests

```sh
cd ~/.config/goose/extensions/token-context   # or wherever the repo lives
node test-client.mjs           # MCP server protocol smoke test
node test-hud-client.mjs       # HUD guest-script functional test (stub DOM + fake host)
```

**`test-client.mjs`** — drives the real MCP server over stdio and verifies:

- tool registration and schemas (`show_context_hud`, `get_context_stats`, `hud_claim`),
- `get_context_stats` output shape against the live `sessions.db`,
- the `ui://token-context/hud` resource (mimeType `text/html;profile=mcp-app`, CSP),
- **Part F: the claim protocol** — grant, rapid-successive-claim denial (the theme-switch remount cascade), holder re-claim refresh, poll-only-observation (`pipClaim` reports granted/denied per holder and is absent without `instance_id`), clean error for a missing `instance_id`, and the takeover path (denied while the holder's claim is fresh → taken over once it ages past `GOOSE_HUD_CLAIM_TAKEOVER_MS`, displaced holder degrades) (12/12).
- **Part G: the /slots monitor** — single-mode regression (bare `/slots`), router detection from the 400 "model name is missing" refusal and follow-through to `/slots?model=<name>`, model-switch isolation (one model's decode never leaks into another session's live feed), clean degradation for a session with no model name, catalog→backend-URL extraction (pure), the backend bypass (/slots traffic goes to the silent backend, not the logging router proxy), LRU-swap re-validation (dead backend + stale catalog → no fake live feed; a re-published port is followed), and the completion-anchored cadence (polls continue within the await window; zero `/slots` traffic after `GOOSE_SLOT_AWAIT_MS` expires — the sleep timer can elapse).

**`test-hud-client.mjs`** — loads the guest script from `index.html` into a stub DOM against a fake MCP App host and walks three end-to-end scenarios:

1. **granted** — self-init claims the slot and requests pip;
2. **denied** — self-init is refused, the guest renders the `.dup` placeholder and never requests pip;
3. **takeover** — a granted guest later polls as `denied` after a second instance takes the slot, degrades to the placeholder, and best-effort requests `inline`.

Both suites must exit 0. The protocol suite needs `node_modules` (it drives the real server through `@modelcontextprotocol/sdk`); the HUD suite uses Node built-ins only.

## Releases

Releases are git tags applied at commit time — there is no separate release step:

1. **Bump the version in two places**: `package.json` (`"version"`) and the `SERVER_VERSION` constant in `server.js` — they must match (the server advertises it in the MCP handshake).
2. **Changelog entry** in `docs/CHANGELOG.md` (Keep a Changelog format), newest first.
3. **Tag the last commit of that version's change-set** with an annotated tag (when a release spans several commits, tag the final one, not each commit):
   ```sh
   git tag -a vX.Y.Z <commit> -m "token-context vX.Y.Z — <one-line summary>"
   ```

Existing tags: `v1.4.0` (the initial commit, per project history), `v1.4.3`, `v1.4.4`, `v1.4.5`. `1.4.1`/`1.4.2` predate the tagged history and were never tagged.

Once a remote exists: `git push -u origin main --tags`.

## Reloading the extension after code changes

Goose keeps the stdio server process alive, so after editing `server.js` or `index.html`:

1. In the chat: sidebar → **Extensions** → toggle **Token Context** off, then on again (restarts the server with the new code and the session's `AGENT_SESSION_ID`).
2. Call `show_context_hud` again — the old mounted HUD stops polling once the extension is toggled off.
3. **For `index.html` changes specifically:** the host's guest webview can outlive an extension toggle, so a re-trigger may still show the *previous* document. To force a fresh load, fully quit and restart the goose application, then re-trigger the HUD.

**Recipe changes need no restart** — `recipes/show-hud.yaml` is re-read from disk on every invocation.

## Source map (quick orientation)

| Area | Where |
| --- | --- |
| MCP server setup, tools, `ui://` resource | `server.js` — `main()` and the `Server` registration block near the bottom |
| DB discovery + read-only open | `discoverDbPath()`, `openDb()` |
| Context-window resolution chain | `resolveContextWindow()` (+ `loadCustomProviders()`, `readLocalModelContextSizes()`) |
| Bar triggers (warn/danger from auto-compaction) | `resolveBarThresholds()` |
| Stats (used tokens, rolling/last/hand-off rates) | `computeStats()`, `rollingTps()`, `lastResponseTps()`, `handoffRate()` |
| Live `/slots` monitor + hand-off capture | `pollSlots()`, `slotStateTransition()`, `captureHandoff()`, `liveEstimate()` (per-model resets: `clearBackendCache()` / `resetSlotTimeline()`; shared snapshot scan: `processingSummary()`) |
| Claim broker (singleton pip slot) | `claimSlot()`, `refreshClaim()`, `claimKeyFor()` |
| Guest protocol client (init, claim, pip, polling) | `index.html` — `McpAppClient` and the `app` bootstrap |
| Guest rendering (tok/s states, bar, footer, placeholder) | `index.html` — `render()`, `setPipClaim()`, `positionMarkers()` |

## Housekeeping notes

- `recipes/show-hud.yaml` in this repo is the single recipe in use — `slash_commands` in `config.yaml` references it directly. (An earlier Recipe Library copy in `~/.config/goose/recipes/` no longer exists; if one is ever recreated, keep the repo file canonical.)
- `GOOSE_AUTO_COMPACT_THRESHOLD` (goose's own setting, e.g. `0.9` at the root of `config.yaml`) drives the red bar trigger — it is read by the server, not set by it.

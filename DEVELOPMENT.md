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
- **Part F: the claim protocol** — grant, deny-while-held, takeover after the claim ages past `GOOSE_HUD_CLAIM_TAKEOVER_MS`, rapid-successive-claim denial, TTL expiry, poll-only-observation (`pipClaim` reports never change the holder), and the displaced-holder path (11/11).

**`test-hud-client.mjs`** — loads the guest script from `index.html` into a stub DOM against a fake MCP App host and walks three end-to-end scenarios:

1. **granted** — self-init claims the slot and requests pip;
2. **denied** — self-init is refused, the guest renders the `.dup` placeholder and never requests pip;
3. **takeover** — a granted guest later polls as `denied` after a second instance takes the slot, degrades to the placeholder, and best-effort requests `inline`.

Both suites must exit 0; there are no external dependencies beyond Node itself.

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
| Live `/slots` monitor + hand-off capture | `pollSlots()`, `slotStateTransition()`, `captureHandoff()`, `liveEstimate()` |
| Claim broker (singleton pip slot) | `claimSlot()`, `refreshClaim()`, `claimKeyFor()` |
| Guest protocol client (init, claim, pip, polling) | `index.html` — `McpAppClient` and the `app` bootstrap |
| Guest rendering (tok/s states, bar, footer, placeholder) | `index.html` — `render()`, `setPipClaim()`, `positionMarkers()` |

## Housekeeping notes

- There are two copies of the recipe in use: the one in this repo (`recipes/show-hud.yaml`, referenced by `slash_commands` in `config.yaml`) and a Recipe Library copy in `~/.config/goose/recipes/`. They are semantically identical today (the only diff is quoting of the `version` field), but only the repo copy is versioned — keep the repo file canonical.
- `GOOSE_AUTO_COMPACT_THRESHOLD` (goose's own setting, e.g. `0.9` at the root of `config.yaml`) drives the red bar trigger — it is read by the server, not set by it.

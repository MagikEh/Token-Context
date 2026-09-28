// Functional test: run the HUD inline script against a stub DOM + fake goose host.
// The fake host mirrors real goose behavior: it answers ui/initialize with a
// hostContext, and after a ui/request-display-mode it pushes
// ui/notifications/host-context-changed with the *changed fields only*.
//
// v1.4.0: the fake host also answers the pop-out claim protocol
// (hud_claim + pipClaim in stats). Three scenarios:
//   1. granted  — normal boot: claim first, then pip (the usual case)
//   2. denied   — sibling instance holds the slot: placeholder, no pip
//   3. promotion — the popped HUD closes: the waiting instance inherits
//                  the slot on its next stats poll and pops out
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve index.html relative to this file so the suite runs from any checkout.
const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlSrc = readFileSync(join(__dirname, "index.html"), "utf8");
// Extract the inline HUD script straight from index.html (self-contained; no
// reliance on a separately-extracted /tmp file that can go stale).
const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error("no inline <script> found in index.html"); process.exit(1); }
const script = scriptMatch[1];

// ---- DOM stubs (fresh per scenario) ----
function makeClassList(set) {
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    contains: (c) => set.has(c),
  };
}
function makeDom() {
  const els = {};
  for (const id of ["hud", "dup", "dot", "model", "tpsRow", "ctxNum", "bar", "fill", "pct", "fIn", "fOut", "fCache", "fTotal", "zoneWarn", "zoneDanger", "tickWarn", "tickDanger"]) {
    const set = new Set();
    els[id] = {
      _classes: set,
      classList: makeClassList(set),
      style: { display: "", setProperty: () => {} },
      innerHTML: "",
      textContent: "",
      title: "",
    };
  }
  const metaScheme = {
    _attrs: {},
    setAttribute: function (k, v) { this._attrs[k] = v; },
    getAttribute: function (k) { return this._attrs[k]; },
  };
  const docElClasses = new Set();
  const setProps = [];
  const document = {
    getElementById: (id) => (id === "metaScheme" ? metaScheme : els[id] || null),
    documentElement: {
      classList: makeClassList(docElClasses),
      style: {
        colorScheme: "",
        setProperty: (k, v) => setProps.push([k, v]),
      },
    },
    body: { dataset: {}, scrollHeight: 250, addEventListener: () => {} },
  };
  return { els, metaScheme, docElClasses, setProps, document };
}

// ---- fake host (goose) — fresh per scenario ----
function makeHost(opts, deliver) {
  const hostMessages = []; // guest -> host messages
  let statsCalls = 0; // get_context_stats counter — drives the phased payloads
  // Mutable claim state — scenarios flip it to simulate the server:
  //   denyClaims    → hud_claim answers denied (a sibling holds the slot)
  //   statsPipClaim → pipClaim field in stats responses (live slot transfer)
  const state = { denyClaims: !!opts.denyClaims, statsPipClaim: opts.statsPipClaim ?? null };
  const fakeParent = {
    postMessage(msg) {
      hostMessages.push(msg);
      if (msg.id && msg.method === "ui/initialize") {
        deliver({ jsonrpc: "2.0", id: msg.id, result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "goose", version: "1.52.0" },
          hostCapabilities: { serverTools: {} },
          hostContext: {
            theme: "dark",
            styles: { variables: { "--color-background-secondary": "#2a2a2e", "--color-text-primary": "#fff" } },
            displayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen", "pip"],
          },
        }});
      } else if (msg.id && msg.method === "ui/request-display-mode") {
        deliver({ jsonrpc: "2.0", id: msg.id, result: { mode: msg.params.mode } });
        // Real goose behavior: display-mode change is announced back via
        // host-context-changed with only the changed fields.
        deliver({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { displayMode: msg.params.mode, containerDimensions: { width: 400, height: 300 } },
        });
      } else if (msg.id && msg.method === "tools/call") {
        const name = msg.params?.name;
        if (name === "hud_claim") {
          const granted = !state.denyClaims;
          const res = { ok: true, granted, pipClaim: granted ? "granted" : "denied" };
          deliver({ jsonrpc: "2.0", id: msg.id, result: {
            content: [{ type: "text", text: JSON.stringify(res) }],
            structuredContent: res,
          }});
          return;
        }
        if (name !== "get_context_stats") return;
        // Phase 1 (calls 1-5): idle / last-completed-response state (v1.3.0 shape,
        // live inactive, tpsMode "last"). Phase 2 (calls 6-9): LIVE decode with a
        // pre-fetch estimate that exceeds `used`. Phase 3 (calls 10+): LIVE prompt
        // phase (warming) with estTps 0. Windows are wide enough to absorb the
        // first ~800ms of polling (up to 5 calls) plus 700ms transition sleeps.
        statsCalls++;
        let stats;
        if (statsCalls <= 5) {
          stats = {
            ok: true, sessionId: "s1", sessionName: "Test", model: "unsloth/Qwen3.8-27B-GGUF",
            provider: "local", used: 119102, contextWindow: 200000, pct: 59.6,
            compactionThreshold: 0.8, warnPct: 64, dangerPct: 80,
            tps: 42.3, tpsMode: "last", lastTps: 42.3, tpsSamples: 3, isStreaming: false,
            live: { active: false, phase: null, estOut: 0, estTps: 0, sinceMs: 0, promptTokens: 0, source: "llama-slots" },
            input: 118932, output: 170, cacheRead: 118280, sessionTotal: 6080268,
          };
        } else if (statsCalls <= 9) {
          stats = {
            ok: true, sessionId: "s1", sessionName: "Test", model: "unsloth/Qwen3.8-27B-GGUF",
            provider: "local", used: 119102, contextWindow: 200000, pct: 59.6,
            compactionThreshold: 0.6, warnPct: 48, dangerPct: 60,
            tps: 47.5, tpsMode: "live", lastTps: 42.3, tpsSamples: 3, isStreaming: true,
            live: { active: true, phase: "decode", estOut: 1600, estTps: 47.5, sinceMs: 3000, promptTokens: 120000, source: "llama-slots" },
            input: 118932, output: 170, cacheRead: 118280, sessionTotal: 6080268,
          };
        } else {
          stats = {
            ok: true, sessionId: "s1", sessionName: "Test", model: "unsloth/Qwen3.8-27B-GGUF",
            provider: "local", used: 119102, contextWindow: 200000, pct: 59.6,
            compactionThreshold: 0.6, warnPct: 48, dangerPct: 60,
            tps: 0, tpsMode: "live", lastTps: 42.3, tpsSamples: 3, isStreaming: true,
            live: { active: true, phase: "prompt", estOut: 0, estTps: 0, sinceMs: 200, promptTokens: 120000, source: "llama-slots" },
            input: 118932, output: 170, cacheRead: 118280, sessionTotal: 6080268,
          };
        }
        if (state.statsPipClaim) stats.pipClaim = state.statsPipClaim;
        deliver({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: JSON.stringify(stats) }],
        }});
      }
    },
  };
  return { hostMessages, fakeParent, state, getStatsCalls: () => statsCalls };
}

// ---- run one guest instance in a sandbox ----
async function runGuest(opts, waitMs) {
  const dom = makeDom();
  const listeners = [];
  const window = {
    parent: null,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    innerWidth: 1024,
    innerHeight: 768,
  };
  const deliver = (ev) => {
    for (const [type, fn] of listeners) if (type === "message") fn({ data: ev });
  };
  const host = makeHost(opts, deliver);
  window.parent = host.fakeParent;
  const intervals = [];
  const sandbox = {
    window,
    document: dom.document,
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); intervals.push(id); return id; },
    clearInterval,
    JSON, Math, Number, Date, Promise,
  };
  sandbox.window.window = window;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: "hud.js" });
  await new Promise((r) => setTimeout(r, waitMs));
  return {
    dom, host, deliver,
    close: () => intervals.forEach(clearInterval),
  };
}

const fails = [];
const check = (name, cond) => { if (!cond) fails.push(name); console.log((cond ? "PASS" : "FAIL") + "  " + name); };

// ---------------------------------------------------------------------------
// Scenario 1: normal boot — claim granted (the usual single-HUD case)
// ---------------------------------------------------------------------------
console.log("=== Scenario 1: granted (normal boot) ===");
const s1 = await runGuest({ statsPipClaim: "granted" }, 800);
const { els, metaScheme, docElClasses, setProps, document } = s1.dom;
const hostMessages = s1.host.hostMessages;
const post = s1.deliver;

check("initialize sent with availableDisplayModes incl pip",
  hostMessages.some((m) => m.method === "ui/initialize" && m.params?.appCapabilities?.availableDisplayModes?.includes("pip")));
check("initialized notification sent", hostMessages.some((m) => m.method === "ui/notifications/initialized"));
check("requested pip display mode", hostMessages.some((m) => m.method === "ui/request-display-mode" && m.params?.mode === "pip"));
const statsCallsList = hostMessages.filter((m) => m.method === "tools/call" && m.params?.name === "get_context_stats");
check("polled get_context_stats >= 2 times", statsCallsList.length >= 2);
check("poll interval ~200ms (3+ calls in <1s)", statsCallsList.length >= 3);
check("host theme vars applied", setProps.some(([k]) => k === "--color-background-secondary"));

// v1.4.0: pop-out claim protocol
const claimIdx = hostMessages.findIndex((m) => m.method === "tools/call" && m.params?.name === "hud_claim");
const pipIdx = hostMessages.findIndex((m) => m.method === "ui/request-display-mode" && m.params?.mode === "pip");
check("hud_claim sent with a string instance id",
  claimIdx >= 0 && typeof hostMessages[claimIdx].params?.arguments?.instance_id === "string");
check("hud_claim precedes the pip request (claim gates the pop-out)",
  claimIdx >= 0 && pipIdx > claimIdx);
check("stats polls carry the instance id (liveness signal)",
  statsCallsList.length > 0 &&
  statsCallsList.every((m) => typeof m.params.arguments.instance_id === "string"));
check("granted: full HUD visible, placeholder hidden",
  els.hud.style.display !== "none" && els.dup.style.display === "none");

// Theme / color-scheme (bug 2: light content in dark goose)
check("color-scheme mirrors host theme (dark)", document.documentElement.style.colorScheme === "dark");
check("meta color-scheme updated to dark", metaScheme.getAttribute("content") === "dark");
check("body dataset theme dark", document.body.dataset.theme === "dark");

// Display-mode-aware sizing (bugs 1 + 5)
check("mode class applied: mode-pip", docElClasses.has("mode-pip"));
const sizeMsgs = hostMessages.filter((m) => m.method === "ui/notifications/size-changed");
check("size reported", sizeMsgs.length >= 1);
check("initial inline size = natural content height (250, no width)",
  sizeMsgs.some((m) => m.params?.height === 250 && m.params?.width === undefined));
check("pip size fills 400x300 frame minus border (396x296)",
  sizeMsgs.some((m) => m.params?.width === 396 && m.params?.height === 296));
check("last size report is the pip one", (() => {
  const last = sizeMsgs[sizeMsgs.length - 1];
  return last?.params?.width === 396 && last?.params?.height === 296;
})());

// Rendering — phase 1: idle, last-completed-response rate (v1.3.0)
check("idle: tps row shows last rate 42.3", els.tpsRow.innerHTML.includes("42.3"));
check("idle: LAST tag shown", /tps-tag">last/.test(els.tpsRow.innerHTML));
check("idle: dot NOT pulsing", !els.dot._classes.has("on"));
check("fill width 59.6%", els.fill.style.width === "59.6%");
check("ctx numbers rendered", els.ctxNum.innerHTML.includes("119.1k") && els.ctxNum.innerHTML.includes("200.0k"));
check("pct text", els.pct.textContent === "59.6% of context");
check("idle: bar in ok color state (<64 % warn)", els.bar._classes.has("ok") && !els.bar._classes.has("warn") && !els.bar._classes.has("danger"));
check("warn tick sits on the 64 % boundary", els.tickWarn.style.left === "64%");
check("danger tick sits on the 80 % boundary (compaction point)", els.tickDanger.style.left === "80%");
check("warn zone spans 64 %→80 %", els.zoneWarn.style.left === "64%" && els.zoneWarn.style.right === "20%");
check("danger zone spans 80 %→100 %", els.zoneDanger.style.left === "80%" && els.zoneDanger.style.right === "0%");
check("bar title documents the triggers", els.bar.title === "warns at 64% · auto-compaction at 80%");
check("footer totals", els.fTotal.textContent === "6.08M" && els.fIn.textContent === "118.9k");
check("model label set", els.model.textContent === "unsloth/Qwen3.8-27B-GGUF");

// Rendering — phase 2: LIVE decode (prefetch estimate > used → bar climbs)
await new Promise((r) => setTimeout(r, 700));
check("live: dot pulses (streaming)", els.dot._classes.has("on"));
check("live: tps row shows 47.5 with LIVE tag", els.tpsRow.innerHTML.includes("47.5") && /tps-tag">live/.test(els.tpsRow.innerHTML));
check("live: ctx shows ~ prefix with prefetched size (121.6k = 120000 prompt + 1600 decoded)",
  els.ctxNum.innerHTML.startsWith("~") && els.ctxNum.innerHTML.includes("121.6k"));
check("live: fill climbs to prefetched 60.8%", els.fill.style.width === "60.8%");
check("live: pct text marked (est)", els.pct.textContent === "60.8% of context (est)");
// v1.3.9: the session's compaction point moved (0.8 → 0.6) → markers follow
check("thresholds repositioned: warn tick 64 %→48 %", els.tickWarn.style.left === "48%");
check("thresholds repositioned: danger tick 80 %→60 %", els.tickDanger.style.left === "60%");
check("thresholds repositioned: zones 48 %→60 % and 60 %→100 %",
  els.zoneWarn.style.left === "48%" && els.zoneWarn.style.right === "40%" &&
  els.zoneDanger.style.left === "60%" && els.zoneDanger.style.right === "0%");
check("bar follows new triggers: 60.8 % (est) ≥ 60 % → danger",
  els.bar._classes.has("danger") && !els.bar._classes.has("warn") && !els.bar._classes.has("ok"));
check("bar title tracks new triggers", els.bar.title === "warns at 48% · auto-compaction at 60%");

// Rendering — phase 3: LIVE prompt phase → WARMING tag, 0.0 rate
await new Promise((r) => setTimeout(r, 700));
check("warming: WARMING tag shown", /tps-tag">warming/.test(els.tpsRow.innerHTML));
check("warming: 0.0 tok/s while prompt runs", els.tpsRow.innerHTML.includes("0.0"));
check("warming: prefetch continues (120.0k, est)", els.ctxNum.innerHTML.includes("120.0k") && els.pct.textContent === "60.0% of context (est)");

// Live theme switch (host-context-changed with only changed fields)
post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
await new Promise((r) => setTimeout(r, 50));
check("color-scheme follows live theme switch (light)", document.documentElement.style.colorScheme === "light");
check("meta color-scheme updated to light", metaScheme.getAttribute("content") === "light");
check("body dataset theme light", document.body.dataset.theme === "light");
check("still mode-pip after theme-only update", docElClasses.has("mode-pip"));

s1.close();

// ---------------------------------------------------------------------------
// Scenario 2: denied — a sibling instance already holds the slot
// (the theme-switch remount case: this guest must NOT pop a second window)
// ---------------------------------------------------------------------------
console.log("\n=== Scenario 2: denied (sibling holds the slot) ===");
const s2 = await runGuest({ denyClaims: true, statsPipClaim: "denied" }, 700);
check("denied instance never requests pip",
  !s2.host.hostMessages.some((m) => m.method === "ui/request-display-mode"));
check("denied instance never left inline mode", !s2.dom.docElClasses.has("mode-pip"));
check("denied instance shows the placeholder, hides the full HUD",
  s2.dom.els.dup.style.display === "" && s2.dom.els.hud.style.display === "none");
check("denied instance keeps polling stats (data loop stays up)",
  s2.host.getStatsCalls() >= 2);
s2.close();

// ---------------------------------------------------------------------------
// Scenario 3: takeover (v1.4.2) — this instance boots as the holder and
// pops out; a newer HUD init then takes the slot → on its next poll this
// instance degrades to the placeholder and asks the host for inline, but
// never re-requests pip (the pop-out request happens at self-init only).
// ---------------------------------------------------------------------------
console.log("\n=== Scenario 3: takeover (a newer HUD init takes the slot) ===");
const s3 = await runGuest({ statsPipClaim: "granted" }, 500);
check("holder at init: requested pip exactly once",
  s3.host.hostMessages.filter(
    (m) => m.method === "ui/request-display-mode" && m.params?.mode === "pip"
  ).length === 1);
// A newer instance called hud_claim → the server now reports this instance
// as no longer the holder.
s3.host.state.statsPipClaim = "denied";
await new Promise((r) => setTimeout(r, 600));
check("takeover: degraded to the placeholder on the next poll",
  s3.dom.els.hud.style.display === "none" && s3.dom.els.dup.style.display === "");
check("takeover: asked the host for inline and never re-requested pip",
  s3.host.hostMessages.some(
    (m) => m.method === "ui/request-display-mode" && m.params?.mode === "inline"
  ) &&
  s3.host.hostMessages.filter(
    (m) => m.method === "ui/request-display-mode" && m.params?.mode === "pip"
  ).length === 1);
s3.close();

// ---------------------------------------------------------------------------
// CSS source checks (shared, independent of the scenarios above)
// ---------------------------------------------------------------------------
// Accessibility: muted text must use the high-contrast local overrides
// (bug: host tertiary/secondary text was unreadable on the dark card).
check("accessible muted-text vars defined (color-mix toward primary)",
  /--hud-text-secondary:\s*color-mix\(in srgb,\s*var\(--color-text-secondary\) 55%,\s*var\(--color-text-primary\)\)/.test(htmlSrc)
  && /--hud-text-tertiary:\s*color-mix\(in srgb,\s*var\(--color-text-tertiary\) 30%,\s*var\(--color-text-primary\)\)/.test(htmlSrc));
check("title/model/footer/tps-unit use the accessible vars",
  /\.hud-title\s*{[^}]*--hud-text-tertiary/.test(htmlSrc)
  && /\.model\s*{[^}]*--hud-text-tertiary/.test(htmlSrc)
  && /\.foot\s*{[^}]*--hud-text-tertiary/.test(htmlSrc)
  && /\.tps-unit\s*{[^}]*--hud-text-secondary/.test(htmlSrc));
check("no raw low-contrast host text color used directly",
  !/color:\s*var\(--color-text-(secondary|tertiary)\)/.test(htmlSrc));

// v1.3.0: bar color states + tps tag styling
check("bar color states defined (ok/warn/danger, scoped to #fill)",
  /\.bar\.ok\s+#fill\s*{[^}]*--color-background-success/.test(htmlSrc)
  && /\.bar\.warn\s+#fill\s*{[^}]*--color-background-warning/.test(htmlSrc)
  && /\.bar\.danger\s+#fill\s*{[^}]*--color-background-danger/.test(htmlSrc));
check("tps-tag style defined (tertiary muted)",
  /\.tps-tag\s*{[^}]*--hud-text-tertiary/.test(htmlSrc));
// v1.3.6: trigger-coloured ticks + hover-reactive zone tints
check("trigger ticks colored (warn tick yellow, danger tick red)",
  /\.bar\s+\.tick-warn\s*{[^}]*--color-background-warning/.test(htmlSrc)
  && /\.bar\s+\.tick-danger\s*{[^}]*--color-background-danger/.test(htmlSrc));
check("zone tints subtle at rest (18/22 %), near-full on hover (85 %)",
  /\.bar\s+\.zone-warn\s*{[^}]*warning\) 18%,\s*transparent/.test(htmlSrc)
  && /\.bar\s+\.zone-danger\s*{[^}]*danger\) 22%,\s*transparent/.test(htmlSrc)
  && /\.bar:hover\s+\.zone-warn\s*{[^}]*warning\) 85%,\s*transparent/.test(htmlSrc)
  && /\.bar:hover\s+\.zone-danger\s*{[^}]*danger\) 85%,\s*transparent/.test(htmlSrc));
// v1.3.7: fill state colours must stay scoped to the fill element — an
// unscoped `.bar[.state] > span` rule would recolor the ticks/zones too.
check("fill state rules scoped to #fill (no leak into ticks/zones)",
  !/\.bar(\.ok|\.warn|\.danger)?\s*>\s*span/.test(htmlSrc)
  && /#fill\s*{[^}]*--color-background-info/.test(htmlSrc));
// v1.4.0: the duplicate-instance placeholder style must exist
check("placeholder style defined for denied instances",
  /\.dup\s*{[^}]*--hud-text-secondary/.test(htmlSrc)
  && /<div class="dup" id="dup"/.test(htmlSrc));

if (fails.length) { console.error("\nFAILURES:", fails); process.exit(1); }
console.log("\nALL TESTS PASSED");
process.exit(0);

export function renderPage(controlToken) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capability Manager</title>
<style>
  :root {
    color-scheme: light dark;
    --fg: #1f2328;
    --muted: #59636e;
    --line: #d1d9e0;
    --bg: #ffffff;
    --sunken: #f6f8fa;
    --ok: #1a7f37;
    --warn: #9a6700;
    --err: #cf222e;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f0f6fc; --muted:#9198a1; --line:#3d444d; --bg:#0d1117; --sunken:#151b23;
            --ok:#3fb950; --warn:#d29922; --err:#f85149; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size:18px; margin:0 0 2px; }
  .path { color:var(--muted); font-size:12px; font-family:ui-monospace, monospace;
          margin-bottom:16px; word-break:break-all; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
           gap:8px; margin-bottom:20px; }
  .stat { border:1px solid var(--line); border-radius:6px; padding:10px 12px; background:var(--sunken); }
  .stat b { display:block; font-size:20px; font-weight:600; }
  .stat span { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; margin-bottom:24px; }
  th { text-align:left; font-size:12px; color:var(--muted); font-weight:600;
       padding:6px 8px; border-bottom:1px solid var(--line); }
  td { padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
  code { font-family:ui-monospace, monospace; font-size:12px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px;
          border:1px solid var(--line); }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); }
  .empty { color:var(--muted); padding:24px; text-align:center; border:1px dashed var(--line);
           border-radius:6px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted);
       margin:0 0 8px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .grow { flex:1; min-width:180px; }
  button, select, input { font:inherit; color:var(--fg); background:var(--bg);
          border:1px solid var(--line); border-radius:6px; padding:5px 10px; }
  button { background:var(--sunken); cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--muted); }
  button:disabled, select:disabled, input:disabled { opacity:.5; cursor:not-allowed; }
  .toggle { min-width:74px; }
  .notice { border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:6px;
            padding:10px 12px; margin-bottom:16px; background:var(--sunken); font-size:13px; }
  .notice.err { border-left-color:var(--err); }
  .notice.ok { border-left-color:var(--ok); }
  .panel { border:1px solid var(--line); border-radius:6px; padding:12px;
           background:var(--sunken); margin-bottom:24px; }
  .panel .row + .row { margin-top:8px; }
  .score { color:var(--muted); font-variant-numeric:tabular-nums; }
  fieldset { border:0; margin:0; padding:0; }
</style>
</head>
<body>
<div id="root">
  <h1>Capability Manager</h1>
  <p class="path" id="path"></p>
  <div id="notice"></div>
  <div class="stats" id="stats"></div>

  <h2>Servers</h2>
  <div id="server-result"></div>
  <div id="servers"><p class="empty">Loading…</p></div>

  <h2>Add a server</h2>
  <div class="panel">
    <fieldset id="add-fields">
      <div class="row">
        <input class="grow" id="add-id" placeholder="server id (e.g. github)" autocomplete="off">
        <input class="grow" id="add-name" placeholder="display name (optional)" autocomplete="off">
        <select id="add-trust">
          <option value="untrusted">untrusted</option>
          <option value="trusted">trusted</option>
          <option value="blocked">blocked</option>
        </select>
      </div>
      <div class="row">
        <select id="add-type">
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
        <input class="grow" id="add-target" placeholder="command to run, e.g. npx" autocomplete="off">
        <input class="grow" id="add-args" placeholder="args, space separated (optional)" autocomplete="off">
        <button id="add-run">Add server</button>
      </div>
    </fieldset>
    <div id="add-result"></div>
  </div>

  <h2>Test search</h2>
  <div class="panel">
    <div class="row">
      <input class="grow" id="q" placeholder="Describe a task, e.g. open a pull request" autocomplete="off">
      <select id="q-server"><option value="">All servers</option></select>
      <button id="q-run">Search</button>
    </div>
    <div id="q-result"></div>
  </div>

  <h2>Recent invocations</h2>
  <div id="history"></div>
</div>
<script type="module">
const STATUS = { ready:"ok", error:"err", disabled:"warn", connecting:"warn", inactive:"" };
const TRUST = ["blocked", "untrusted", "trusted"];
const CONTROL_TOKEN = ${JSON.stringify(controlToken)};
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const $ = (id) => document.getElementById(id);

/**
 * True only when the hub is running and reachable. Every control is disabled
 * when it is false, because a write has nowhere to go — the canvas will not
 * fall back to editing the config file itself.
 */
let live = false;
let busy = false;

async function control(name, input) {
  if (busy) return { ok: false, error: "Another change is still in progress." };
  busy = true;
  try {
    const res = await fetch("/control/" + name, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-action-hub-canvas-token": CONTROL_TOKEN,
      },
      body: JSON.stringify(input),
    });
    return await res.json();
  } catch (cause) {
    return { ok: false, error: String(cause && cause.message || cause) };
  } finally {
    busy = false;
  }
}

function serverRows(servers) {
  if (servers.length === 0) {
    return '<p class="empty">No MCP servers configured yet.<br>Use the form below to add one.</p>';
  }
  return '<table><thead><tr><th>Server</th><th>Transport</th><th>Trust</th>' +
    '<th>Actions</th><th>Status</th><th></th></tr></thead><tbody>' +
    servers.map((s) => {
      const cls = s.enabled ? (STATUS[s.status] ?? "") : "warn";
      const label = s.enabled ? s.status : "disabled";
      const off = live ? "" : " disabled";
      const options = TRUST.map((t) =>
        '<option value="' + t + '"' + (t === s.trust ? " selected" : "") + '>' + t + '</option>'
      ).join("");
      return '<tr><td><b>' + esc(s.displayName) + '</b><br><code>' + esc(s.id) + '</code></td>' +
        '<td>' + esc(s.transport) + '</td>' +
        '<td><select data-trust="' + esc(s.id) + '"' + off + '>' + options + '</select></td>' +
        '<td>' + s.toolCount + '</td>' +
        '<td class="' + cls + '">' + esc(label) +
        (s.error ? '<br><span class="err">' + esc(s.error) + '</span>' : '') + '</td>' +
        '<td><button class="toggle" data-toggle="' + esc(s.id) + '" data-enabled="' +
        (s.enabled ? "1" : "0") + '"' + off + '>' +
        (s.enabled ? "Disable" : "Enable") + '</button></td></tr>';
    }).join("") + '</tbody></table>';
}

function historyRows(history) {
  if (history.length === 0) return '<p class="empty">No invocations recorded yet.</p>';
  return '<table><thead><tr><th>Action</th><th>Server</th><th>Duration</th>' +
    '<th>Result</th><th>When</th></tr></thead><tbody>' +
    history.map((h) =>
      '<tr><td><code>' + esc(h.actionId) + '</code></td>' +
      '<td>' + esc(h.serverId) + '</td>' +
      '<td>' + h.durationMs + ' ms</td>' +
      '<td class="' + (h.ok ? "ok" : "err") + '">' + (h.ok ? "ok" : "failed") + '</td>' +
      '<td>' + esc(h.startedAt) + '</td></tr>').join("") + '</tbody></table>';
}

function savings(context) {
  if (!context) return "—";
  const { eagerTokensEstimate: eager, hubTokensEstimate: hub } = context;
  if (!eager || eager <= hub) return "—";
  return Math.round((1 - hub / eager) * 100) + "%";
}

function searchResults(result) {
  if (!result) return "";
  if (!result.ok) return '<div class="notice err">' + esc(result.error) + '</div>';
  if (result.count === 0) {
    return '<div class="notice">No actions matched “' + esc(result.query) + '”.</div>';
  }
  // Schemas are deliberately absent: this shows exactly what the agent gets
  // back from search, and search never returns an inputSchema.
  return '<table><thead><tr><th>Action</th><th>Server</th><th>Summary</th>' +
    '<th>Score</th></tr></thead><tbody>' +
    result.results.map((r) =>
      '<tr><td><b>' + esc(r.name) + '</b><br><code>' + esc(r.id) + '</code></td>' +
      '<td>' + esc(r.serverId) + '</td>' +
      '<td>' + esc(r.summary) + '</td>' +
      '<td class="score">' + esc(r.score) + '</td></tr>').join("") + '</tbody></table>';
}

function report(node, result, success) {
  if (!result) { node.innerHTML = ""; return; }
  node.innerHTML = result.ok
    ? '<div class="notice ok">' + esc(success(result)) + '</div>'
    : '<div class="notice err">' + esc(result.error) + '</div>';
}

/**
 * Repaints the data regions only. The form inputs live outside them so that a
 * background poll never clears a half-typed query or resets a dropdown.
 */
async function paint() {
  let state;
  try {
    state = await fetch("/state").then((r) => r.json());
  } catch {
    // Losing the canvas's own server is not worth blanking the panel over;
    // the last good render stays on screen until the next poll succeeds.
    return;
  }

  live = state.hubAvailable === true;

  $("path").textContent = state.configPath ?? "";
  $("notice").innerHTML = live
    ? ""
    : '<div class="notice">Action Hub is not running, so this is a read-only view of the ' +
      'last saved configuration and catalog. Controls are disabled until the hub starts.</div>';

  $("stats").innerHTML =
    '<div class="stat"><b>' + state.servers.length + '</b><span>Servers</span></div>' +
    '<div class="stat"><b>' + state.actions + '</b><span>Actions indexed</span></div>' +
    '<div class="stat"><b>' + state.skills + '</b><span>Skills</span></div>' +
    '<div class="stat"><b>' + savings(state.context) + '</b><span>Context saved</span></div>';

  $("servers").innerHTML = serverRows(state.servers);
  $("history").innerHTML = historyRows(state.history);

  for (const node of document.querySelectorAll("#add-fields input, #add-fields select, #add-run, #q, #q-run")) {
    node.disabled = !live;
  }
  $("add-args").disabled = !live || $("add-type").value !== "stdio";

  const picker = $("q-server");
  const keep = picker.value;
  picker.innerHTML = '<option value="">All servers</option>' +
    state.servers.map((s) =>
      '<option value="' + esc(s.id) + '">' + esc(s.displayName) + '</option>').join("");
  picker.value = keep;
  picker.disabled = !live;
}

$("servers").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-toggle]");
  if (!button) return;
  button.disabled = true;
  const result = await control("set_server_enabled", {
    serverId: button.dataset.toggle,
    enabled: button.dataset.enabled !== "1",
  });
  report($("server-result"), result, (r) =>
    r.enabled
      ? 'Enabled "' + r.serverId + '" and indexed ' + r.indexed + ' action(s).' +
        (r.warning ? " Warning: " + r.warning : "")
      : 'Disabled "' + r.serverId + '" and removed its actions from the catalog.');
  await paint();
});

$("servers").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-trust]");
  if (!select) return;
  select.disabled = true;
  const result = await control("set_server_trust", {
    serverId: select.dataset.trust,
    trust: select.value,
  });
  report($("server-result"), result, (r) =>
    'Set "' + r.serverId + '" to ' + r.trust + '; re-tagged ' + r.retagged + ' action(s).');
  await paint();
});

async function runSearch() {
  const query = $("q").value.trim();
  if (!query) return;
  $("q-result").innerHTML = '<p class="empty">Searching…</p>';
  const result = await control("test_search", { query, serverId: $("q-server").value || undefined });
  $("q-result").innerHTML = searchResults(result);
}

$("q-run").addEventListener("click", runSearch);
$("q").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });

$("add-run").addEventListener("click", async () => {
  const type = $("add-type").value;
  const target = $("add-target").value.trim();
  const args = $("add-args").value.trim();

  const transport = type === "stdio"
    ? { type, command: target, args: args ? args.split(/\\s+/) : [] }
    : { type, url: target };

  const result = await control("add_server", {
    id: $("add-id").value.trim(),
    displayName: $("add-name").value.trim() || undefined,
    trust: $("add-trust").value,
    transport,
  });

  report($("add-result"), result, (r) =>
    'Added "' + r.serverId + '" and indexed ' + r.indexed + ' action(s).' +
    (r.warning ? " Warning: " + r.warning : ""));

  if (result.ok) {
    for (const id of ["add-id", "add-name", "add-target", "add-args"]) $(id).value = "";
  }
  await paint();
});

$("add-type").addEventListener("change", () => {
  $("add-target").placeholder = $("add-type").value === "stdio"
    ? "command to run, e.g. npx"
    : "endpoint URL, e.g. https://example.com/mcp";
  $("add-args").disabled = $("add-type").value !== "stdio" || !live;
});

paint();
setInterval(paint, 4000);
</script>
</body>
</html>`;
}

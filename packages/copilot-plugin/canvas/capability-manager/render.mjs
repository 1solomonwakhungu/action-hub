export function renderPage() {
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
</style>
</head>
<body>
<div id="root"><p class="empty">Loading…</p></div>
<script type="module">
const STATUS = { ready:"ok", error:"err", disabled:"warn", connecting:"warn", inactive:"" };
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

function serverRows(servers) {
  if (servers.length === 0) {
    return '<p class="empty">No MCP servers configured yet.<br>Add them to the config file above.</p>';
  }
  return '<table><thead><tr><th>Server</th><th>Transport</th><th>Trust</th>' +
    '<th>Actions</th><th>Status</th></tr></thead><tbody>' +
    servers.map((s) => {
      const cls = s.enabled ? (STATUS[s.status] ?? "") : "warn";
      const label = s.enabled ? s.status : "disabled";
      return '<tr><td><b>' + esc(s.displayName) + '</b><br><code>' + esc(s.id) + '</code></td>' +
        '<td>' + esc(s.transport) + '</td>' +
        '<td><span class="pill">' + esc(s.trust) + '</span></td>' +
        '<td>' + s.toolCount + '</td>' +
        '<td class="' + cls + '">' + esc(label) +
        (s.error ? '<br><span class="err">' + esc(s.error) + '</span>' : '') + '</td></tr>';
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

async function paint() {
  const state = await fetch("/state").then((r) => r.json());
  document.getElementById("root").innerHTML =
    '<h1>Capability Manager</h1>' +
    '<p class="path">' + esc(state.configPath) + '</p>' +
    '<div class="stats">' +
      '<div class="stat"><b>' + state.servers.length + '</b><span>Servers</span></div>' +
      '<div class="stat"><b>' + state.actions + '</b><span>Actions indexed</span></div>' +
      '<div class="stat"><b>' + state.skills + '</b><span>Skills</span></div>' +
      '<div class="stat"><b>' + savings(state.context) + '</b><span>Context saved</span></div>' +
    '</div>' +
    '<h2>Servers</h2>' + serverRows(state.servers) +
    '<h2>Recent invocations</h2>' + historyRows(state.history);
}

paint();
setInterval(paint, 4000);
</script>
</body>
</html>`;
}

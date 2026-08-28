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
    --panel-bg: #ffffff;
    --ok: #1a7f37;
    --ok-bg: #dafbe1;
    --warn: #9a6700;
    --warn-bg: #fff8c5;
    --err: #cf222e;
    --err-bg: #ffebe9;
    --info: #0969da;
    --info-bg: #ddf4ff;
    --accent: #0969da;
    --card-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #f0f6fc;
      --muted: #9198a1;
      --line: #3d444d;
      --bg: #0d1117;
      --sunken: #151b23;
      --panel-bg: #161b22;
      --ok: #3fb950;
      --ok-bg: #1a3a2a;
      --warn: #d29922;
      --warn-bg: #382c16;
      --err: #f85149;
      --err-bg: #3d1b1d;
      --info: #58a6ff;
      --info-bg: #172b4d;
      --accent: #2f81f7;
      --card-shadow: 0 1px 3px rgba(0,0,0,0.4);
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { margin-bottom: 16px; }
  h1 { font-size:20px; font-weight:700; margin:0 0 2px; }
  .path { color:var(--muted); font-size:12px; font-family:ui-monospace, monospace;
          word-break:break-all; margin: 4px 0 16px; }
  
  /* Tabs */
  .nav-tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:16px; flex-wrap:wrap; }
  .tab-btn { background:none; border:none; border-bottom:2px solid transparent; padding:8px 14px;
             color:var(--muted); font-weight:600; cursor:pointer; border-radius:4px 4px 0 0; font-size:13px; }
  .tab-btn:hover { color:var(--fg); background:var(--sunken); }
  .tab-btn.active { color:var(--accent); border-bottom-color:var(--accent); }

  /* Stats cards */
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:20px; }
  .stat { border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:var(--sunken); box-shadow:var(--card-shadow); }
  .stat b { display:block; font-size:22px; font-weight:700; color:var(--fg); }
  .stat span { color:var(--muted); font-size:12px; font-weight:500; }
  
  /* Tables */
  table { width:100%; border-collapse:collapse; margin-bottom:20px; }
  th { text-align:left; font-size:12px; color:var(--muted); font-weight:600;
       padding:8px 10px; border-bottom:1px solid var(--line); }
  td { padding:10px; border-bottom:1px solid var(--line); vertical-align:middle; font-size:13px; }
  code { font-family:ui-monospace, monospace; font-size:12px; }
  
  /* Badges & Pills */
  .badge { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.02em; }
  .badge.ready { background:var(--ok-bg); color:var(--ok); border:1px solid var(--ok); }
  .badge.connecting, .badge.reconnecting { background:var(--warn-bg); color:var(--warn); border:1px solid var(--warn); }
  .badge.degraded { background:var(--warn-bg); color:var(--warn); border:1px solid var(--warn); }
  .badge.unreachable, .badge.error { background:var(--err-bg); color:var(--err); border:1px solid var(--err); }
  .badge.disabled, .badge.inactive { background:var(--sunken); color:var(--muted); border:1px solid var(--line); }
  .badge.trust-trusted { background:var(--ok-bg); color:var(--ok); }
  .badge.trust-untrusted { background:var(--warn-bg); color:var(--warn); }
  .badge.trust-blocked { background:var(--err-bg); color:var(--err); }
  
  .latency { font-family:ui-monospace, monospace; font-size:11px; color:var(--muted); }
  .circuit { font-size:11px; font-weight:500; }
  .circuit.closed { color:var(--ok); }
  .circuit.open { color:var(--err); font-weight:700; }
  .circuit.half_open { color:var(--warn); }

  .empty { color:var(--muted); padding:32px; text-align:center; border:1px dashed var(--line);
           border-radius:8px; background:var(--sunken); }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
       margin:16px 0 10px; font-weight:700; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .grow { flex:1; min-width:180px; }
  
  /* Inputs & Buttons */
  button, select, input, textarea { font:inherit; color:var(--fg); background:var(--bg);
          border:1px solid var(--line); border-radius:6px; padding:6px 12px; }
  button { background:var(--sunken); cursor:pointer; font-weight:500; transition:all 0.15s ease; }
  button:hover:not(:disabled) { border-color:var(--muted); background:var(--bg); }
  button.primary { background:var(--accent); color:#ffffff; border-color:var(--accent); }
  button.primary:hover:not(:disabled) { opacity:0.9; }
  button:disabled, select:disabled, input:disabled, textarea:disabled { opacity:.5; cursor:not-allowed; }
  
  .notice { border:1px solid var(--line); border-left:4px solid var(--warn); border-radius:6px;
            padding:10px 14px; margin-bottom:16px; background:var(--sunken); font-size:13px; }
  .notice.err { border-left-color:var(--err); background:var(--err-bg); color:var(--err); }
  .notice.ok { border-left-color:var(--ok); background:var(--ok-bg); color:var(--ok); }
  .panel { border:1px solid var(--line); border-radius:8px; padding:16px;
           background:var(--panel-bg); margin-bottom:20px; box-shadow:var(--card-shadow); }
  .panel .row + .row { margin-top:10px; }

  /* Presets grid */
  .presets-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; margin-bottom:16px; }
  .preset-card { border:1px solid var(--line); border-radius:6px; padding:12px; background:var(--sunken); cursor:pointer; transition:all 0.15s ease; }
  .preset-card:hover { border-color:var(--accent); transform:translateY(-1px); }
  .preset-card b { display:block; font-size:13px; margin-bottom:4px; }
  .preset-card span { font-size:11px; color:var(--muted); display:block; line-height:1.3; }

  /* Analytics chart */
  .analytics-bar { height:24px; border-radius:12px; background:var(--line); overflow:hidden; display:flex; margin:8px 0 14px; }
  .analytics-fill { background:var(--ok); height:100%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:700; }
  .analytics-spent { background:var(--accent); height:100%; }

  /* Schema explorer */
  .schema-view { background:var(--sunken); border:1px solid var(--line); border-radius:6px; padding:10px; font-family:ui-monospace, monospace; font-size:11px; max-height:220px; overflow-y:auto; white-space:pre-wrap; }
  .action-item { border:1px solid var(--line); border-radius:6px; padding:12px; margin-bottom:8px; background:var(--panel-bg); }
  .action-header { display:flex; justify-content:space-between; align-items:center; cursor:pointer; }
  
  /* Search Results */
  .score-bar { height:6px; border-radius:3px; background:var(--line); overflow:hidden; width:80px; display:inline-block; vertical-align:middle; margin-left:6px; }
  .score-fill { height:100%; background:var(--accent); }

  .tab-content { display:none; }
  .tab-content.active { display:block; }
</style>
</head>
<body>
<div id="root">
  <header>
    <h1>Capability Manager</h1>
    <p class="path" id="path"></p>
    <div id="notice"></div>
    <div class="stats" id="stats"></div>
  </header>

  <div class="nav-tabs" id="tabs">
    <button class="tab-btn active" data-tab="servers">🖥️ Servers & Health</button>
    <button class="tab-btn" data-tab="search">🔍 Search Playground</button>
    <button class="tab-btn" data-tab="explorer">📦 Actions & Bundles</button>
    <button class="tab-btn" data-tab="analytics">📊 Token Analytics</button>
    <button class="tab-btn" data-tab="presets">⚡ Presets & Import</button>
    <button class="tab-btn" data-tab="history">📜 Invocations</button>
  </div>

  <!-- TAB: SERVERS & HEALTH -->
  <div id="tab-servers" class="tab-content active">
    <div class="row" style="margin-bottom:12px; justify-content:space-between;">
      <h2>Connected MCP Servers</h2>
      <div class="row">
        <button id="btn-check-health">🩺 Check Health & Latency</button>
      </div>
    </div>
    <div id="server-result"></div>
    <div id="servers"><p class="empty">Loading servers…</p></div>

    <h2>Add a Server</h2>
    <div class="panel">
      <fieldset id="add-fields">
        <div class="row">
          <input class="grow" id="add-id" placeholder="server id (e.g. github)" autocomplete="off">
          <input class="grow" id="add-name" placeholder="display name (optional)" autocomplete="off">
          <select id="add-trust">
            <option value="untrusted">untrusted (requires confirmation)</option>
            <option value="trusted">trusted (auto-approved)</option>
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
          <button class="primary" id="add-run">Add Server</button>
        </div>
      </fieldset>
      <div id="add-result"></div>
    </div>
  </div>

  <!-- TAB: SEARCH PLAYGROUND -->
  <div id="tab-search" class="tab-content">
    <h2>Interactive Retrieval Playground</h2>
    <div class="panel">
      <div class="row">
        <input class="grow" id="q" placeholder="Describe a task, e.g. open pull request or query customer table..." autocomplete="off">
        <select id="q-server"><option value="">All servers</option></select>
        <button class="primary" id="q-run">Search</button>
      </div>
      <div class="row" style="margin-top:10px; font-size:12px; color:var(--muted);">
        <label><input type="checkbox" id="q-schema" style="vertical-align:middle;"> Include JSON Schemas in result</label>
        <span style="margin-left:16px;">Results Limit:</span>
        <select id="q-limit" style="padding:2px 8px; font-size:12px;">
          <option value="5">5</option>
          <option value="10" selected>10</option>
          <option value="20">20</option>
        </select>
      </div>
      <div id="q-result" style="margin-top:16px;"></div>
    </div>
  </div>

  <!-- TAB: ACTIONS & BUNDLES EXPLORER -->
  <div id="tab-explorer" class="tab-content">
    <div class="row" style="justify-content:space-between; margin-bottom:12px;">
      <h2>Indexed Catalog Explorer</h2>
      <input id="explorer-filter" placeholder="Filter actions & bundles..." style="min-width:260px;" autocomplete="off">
    </div>
    
    <h3 style="font-size:13px; text-transform:uppercase; color:var(--muted); margin:12px 0 6px;">Compound Action Bundles</h3>
    <div id="bundles-list" style="margin-bottom:20px;"></div>

    <h3 style="font-size:13px; text-transform:uppercase; color:var(--muted); margin:12px 0 6px;">Individual Actions / Tools</h3>
    <div id="actions-list"></div>
  </div>

  <!-- TAB: TOKEN ANALYTICS -->
  <div id="tab-analytics" class="tab-content">
    <h2>Context Savings Analytics</h2>
    <div class="panel">
      <div id="analytics-content">
        <p class="empty">Calculating token savings…</p>
      </div>
    </div>
  </div>

  <!-- TAB: PRESETS & IMPORT -->
  <div id="tab-presets" class="tab-content">
    <h2>Quick Server Presets</h2>
    <div class="presets-grid" id="presets-container">
      <div class="preset-card" data-preset="github">
        <b>🐙 GitHub</b>
        <span>Pull requests, issues, commits, repositories</span>
      </div>
      <div class="preset-card" data-preset="linear">
        <b>⚡ Linear</b>
        <span>Issues, cycles, projects, issue tracking</span>
      </div>
      <div class="preset-card" data-preset="slack">
        <b>💬 Slack</b>
        <span>Channels, messages, notifications</span>
      </div>
      <div class="preset-card" data-preset="filesystem">
        <b>📁 Filesystem</b>
        <span>Local workspace file reading and writing</span>
      </div>
      <div class="preset-card" data-preset="sqlite">
        <b>🗄️ SQLite</b>
        <span>Direct database querying and schema inspection</span>
      </div>
      <div class="preset-card" data-preset="postgres">
        <b>🐘 Postgres</b>
        <span>PostgreSQL schema and query execution</span>
      </div>
      <div class="preset-card" data-preset="memory">
        <b>🧠 Memory Graph</b>
        <span>Knowledge graph memory and entities</span>
      </div>
      <div class="preset-card" data-preset="brave">
        <b>🔎 Brave Search</b>
        <span>Real-time web search and content discovery</span>
      </div>
    </div>

    <h2>Import Config (Claude Desktop / Cursor / VS Code)</h2>
    <div class="panel">
      <p style="font-size:13px; color:var(--muted); margin-top:0;">
        Paste your <code>claude_desktop_config.json</code> or VS Code <code>mcp.json</code> content below to import all MCP servers at once.
      </p>
      <textarea id="import-json" rows="6" style="width:100%; font-family:ui-monospace, monospace; font-size:12px; margin-bottom:10px;" placeholder='{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }'></textarea>
      <div class="row">
        <button class="primary" id="btn-import">📥 Import Servers</button>
      </div>
      <div id="import-result" style="margin-top:12px;"></div>
    </div>
  </div>

  <!-- TAB: INVOCATIONS HISTORY -->
  <div id="tab-history" class="tab-content">
    <h2>Recent Action Invocations</h2>
    <div id="history"></div>
  </div>
</div>

<script type="module">
const STATUS = {
  ready: "ready",
  connecting: "connecting",
  reconnecting: "reconnecting",
  degraded: "degraded",
  unreachable: "unreachable",
  error: "error",
  disabled: "disabled",
  inactive: "inactive"
};

const TRUST = ["blocked", "untrusted", "trusted"];
const CONTROL_TOKEN = ${JSON.stringify(controlToken)};
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const $ = (id) => document.getElementById(id);

let live = false;
let busy = false;
let currentState = null;

const PRESETS = {
  github: {
    id: "github",
    name: "GitHub",
    type: "stdio",
    target: "npx",
    args: "-y @modelcontextprotocol/server-github"
  },
  linear: {
    id: "linear",
    name: "Linear",
    type: "stdio",
    target: "npx",
    args: "-y mcp-server-linear"
  },
  slack: {
    id: "slack",
    name: "Slack",
    type: "stdio",
    target: "npx",
    args: "-y @modelcontextprotocol/server-slack"
  },
  filesystem: {
    id: "filesystem",
    name: "Filesystem",
    type: "stdio",
    target: "npx",
    args: "-y @modelcontextprotocol/server-filesystem ."
  },
  sqlite: {
    id: "sqlite",
    name: "SQLite",
    type: "stdio",
    target: "npx",
    args: "-y mcp-server-sqlite --db-path ./local.db"
  },
  postgres: {
    id: "postgres",
    name: "PostgreSQL",
    type: "stdio",
    target: "npx",
    args: "-y @modelcontextprotocol/server-postgres postgresql://localhost/mydb"
  },
  memory: {
    id: "memory",
    name: "Memory Graph",
    type: "stdio",
    target: "npx",
    args: "-y @modelcontextprotocol/server-memory"
  },
  brave: {
    id: "brave-search",
    name: "Brave Search",
    type: "stdio",
    target: "npx",
    args: "-y @modelcontextprotocol/server-brave-search"
  }
};

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

// TAB SWITCHING
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    const target = $("tab-" + btn.dataset.tab);
    if (target) target.classList.add("active");
  });
});

function serverRows(servers) {
  if (!servers || servers.length === 0) {
    return '<p class="empty">No MCP servers configured yet.<br>Use the form or quick presets to add one.</p>';
  }
  return '<table><thead><tr><th>Server</th><th>Transport</th><th>Trust Tier</th>' +
    '<th>Actions</th><th>Status & Health</th><th>Controls</th></tr></thead><tbody>' +
    servers.map((s) => {
      const statusKey = s.enabled ? (s.status || "inactive") : "disabled";
      const badgeCls = STATUS[statusKey] ?? "inactive";
      const off = live ? "" : " disabled";
      const latencyStr = s.latencyMs !== undefined ? s.latencyMs + ' ms' : '—';
      const circuitState = s.circuitBreaker ? s.circuitBreaker.state : 'closed';
      
      const options = TRUST.map((t) =>
        '<option value="' + t + '"' + (t === s.trust ? " selected" : "") + '>' + t + '</option>'
      ).join("");
      
      return '<tr>' +
        '<td><b>' + esc(s.displayName) + '</b><br><code>' + esc(s.id) + '</code></td>' +
        '<td><code>' + esc(s.transport) + '</code></td>' +
        '<td><select data-trust="' + esc(s.id) + '"' + off + '>' + options + '</select></td>' +
        '<td><b>' + (s.toolCount || 0) + '</b></td>' +
        '<td>' +
          '<span class="badge ' + badgeCls + '">' + esc(statusKey) + '</span>' +
          '<div style="margin-top:4px;" class="latency">Ping: <b>' + latencyStr + '</b> | Circuit: <span class="circuit ' + circuitState + '">' + circuitState + '</span></div>' +
          (s.error ? '<div class="err" style="font-size:11px; margin-top:2px;">' + esc(s.error) + '</div>' : '') +
        '</td>' +
        '<td>' +
          '<div class="row" style="gap:4px;">' +
            '<button class="toggle" data-toggle="' + esc(s.id) + '" data-enabled="' +
              (s.enabled ? "1" : "0") + '"' + off + '>' +
              (s.enabled ? "Disable" : "Enable") + '</button>' +
            '<button data-reconnect="' + esc(s.id) + '"' + off + ' title="Reconnect & health check">⚡ Reconnect</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }).join("") + '</tbody></table>';
}

function bundlesRows(bundles, filter) {
  if (!bundles || bundles.length === 0) {
    return '<p class="empty" style="padding:16px;">No Action Bundles defined.</p>';
  }
  const filtered = bundles.filter(b => !filter || b.displayName.toLowerCase().includes(filter) || b.description.toLowerCase().includes(filter));
  if (filtered.length === 0) return '<p class="empty" style="padding:12px;">No matching bundles.</p>';

  return filtered.map(b =>
    '<div class="action-item">' +
      '<div class="action-header">' +
        '<div><b>' + esc(b.displayName) + '</b> <code style="color:var(--muted);">[' + esc(b.id) + ']</code></div>' +
        '<div><span class="badge ready">' + ((b.actionIds && b.actionIds.length) || 0) + ' actions</span></div>' +
      '</div>' +
      '<p style="margin:6px 0 8px; font-size:12px; color:var(--muted);">' + esc(b.description) + '</p>' +
      '<div style="font-size:11px; color:var(--muted);">' +
        '<b>Included tools:</b> ' + (b.actionIds ? b.actionIds.map(a => '<code>' + esc(a) + '</code>').join(', ') : 'none') +
      '</div>' +
    '</div>'
  ).join("");
}

function actionsRows(actions, filter) {
  if (!actions || actions.length === 0) {
    return '<p class="empty" style="padding:16px;">No actions indexed in catalog.</p>';
  }
  const filtered = actions.filter(a => !filter || a.name.toLowerCase().includes(filter) || a.summary.toLowerCase().includes(filter) || a.serverId.toLowerCase().includes(filter));
  if (filtered.length === 0) return '<p class="empty" style="padding:12px;">No matching actions.</p>';

  return filtered.map(a =>
    '<div class="action-item">' +
      '<div class="action-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === \'none\' ? \'block\' : \'none\'">' +
        '<div><b>' + esc(a.name) + '</b> <span class="badge trust-' + esc(a.trust) + '">' + esc(a.trust) + '</span> <code style="color:var(--muted); margin-left:6px;">' + esc(a.serverId) + '</code></div>' +
        '<div style="font-size:11px; color:var(--accent);">View Schema ▾</div>' +
      '</div>' +
      '<div style="display:none; margin-top:8px;">' +
        '<p style="margin:4px 0 8px; font-size:12px;">' + esc(a.summary) + '</p>' +
        '<div class="schema-view">' + esc(JSON.stringify(a.inputSchema || {}, null, 2)) + '</div>' +
      '</div>' +
    '</div>'
  ).join("");
}

function renderAnalytics(state) {
  if (!state || !state.context) return '<p class="empty">No context usage data available.</p>';
  const ctx = state.context;
  const eager = ctx.eagerTokensEstimate || 0;
  const hub = ctx.hubTokensEstimate || 0;
  const saved = eager > hub ? eager - hub : 0;
  const pct = eager > 0 ? Math.round((saved / eager) * 100) : 0;

  return '<div style="margin-bottom:16px;">' +
    '<div style="display:flex; justify-content:space-between; font-weight:600; font-size:13px;">' +
      '<span>Action Hub Lazy Load Footprint: ' + hub.toLocaleString() + ' tokens</span>' +
      '<span style="color:var(--ok);">Net Saved: ' + saved.toLocaleString() + ' tokens (' + pct + '%)</span>' +
    '</div>' +
    '<div class="analytics-bar">' +
      '<div class="analytics-fill" style="width:' + pct + '%;">' + pct + '% Saved</div>' +
      '<div class="analytics-spent" style="width:' + (100 - pct) + '%;"></div>' +
    '</div>' +
    '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-top:16px;">' +
      '<div class="stat"><b>' + eager.toLocaleString() + '</b><span>Eager Full Schema Tokens</span></div>' +
      '<div class="stat"><b>' + hub.toLocaleString() + '</b><span>Lazy Load Active Tokens</span></div>' +
      '<div class="stat"><b style="color:var(--ok);">' + saved.toLocaleString() + '</b><span>Total Context Tokens Saved</span></div>' +
    '</div>' +
  '</div>';
}

function historyRows(history) {
  if (!history || history.length === 0) return '<p class="empty">No invocations recorded yet.</p>';
  return '<table><thead><tr><th>Action</th><th>Server</th><th>Duration</th>' +
    '<th>Result</th><th>When</th></tr></thead><tbody>' +
    history.map((h) =>
      '<tr><td><code>' + esc(h.actionId) + '</code></td>' +
      '<td>' + esc(h.serverId) + '</td>' +
      '<td>' + h.durationMs + ' ms</td>' +
      '<td><span class="badge ' + (h.ok ? "ready" : "error") + '">' + (h.ok ? "OK" : "FAILED") + '</span></td>' +
      '<td class="latency">' + esc(h.startedAt) + '</td></tr>').join("") + '</tbody></table>';
}

function searchResults(result) {
  if (!result) return "";
  if (!result.ok) return '<div class="notice err">' + esc(result.error) + '</div>';
  if (result.count === 0 && (!result.bundles || result.bundles.length === 0)) {
    return '<div class="notice">No tools or bundles matched “' + esc(result.query) + '”.</div>';
  }
  
  let html = '';
  if (result.bundles && result.bundles.length > 0) {
    html += '<h3 style="font-size:13px; margin:8px 0;">Matching Action Bundles (' + result.bundles.length + ')</h3>' +
      result.bundles.map(b =>
        '<div class="action-item" style="border-left:3px solid var(--accent);">' +
          '<b>' + esc(b.displayName) + '</b> <code style="color:var(--muted);">[' + esc(b.id) + ']</code>' +
          '<p style="margin:4px 0; font-size:12px; color:var(--muted);">' + esc(b.description) + '</p>' +
        '</div>'
      ).join('');
  }

  html += '<h3 style="font-size:13px; margin:12px 0 8px;">Ranked Candidate Actions (' + result.count + ')</h3>' +
    '<table><thead><tr><th>Action</th><th>Server</th><th>Summary</th><th>Relevance Score</th></tr></thead><tbody>' +
    result.results.map((r) => {
      const pct = Math.min(100, Math.round(r.score * 100));
      return '<tr>' +
        '<td><b>' + esc(r.name) + '</b><br><code>' + esc(r.id) + '</code></td>' +
        '<td><code>' + esc(r.serverId) + '</code></td>' +
        '<td>' + esc(r.summary) + (r.inputSchema ? '<div class="schema-view" style="margin-top:6px;">' + esc(JSON.stringify(r.inputSchema, null, 2)) + '</div>' : '') + '</td>' +
        '<td class="score"><b>' + esc(r.score) + '</b><div class="score-bar"><div class="score-fill" style="width:' + pct + '%;"></div></div></td>' +
      '</tr>';
    }).join("") + '</tbody></table>';

  return html;
}

function report(node, result, success) {
  if (!result) { node.innerHTML = ""; return; }
  node.innerHTML = result.ok
    ? '<div class="notice ok">' + esc(success(result)) + '</div>'
    : '<div class="notice err">' + esc(result.error) + '</div>';
}

async function paint() {
  let state;
  try {
    state = await fetch("/state").then((r) => r.json());
  } catch {
    return;
  }

  currentState = state;
  live = state.hubAvailable === true;

  $("path").textContent = state.configPath ?? "";
  $("notice").innerHTML = live
    ? ""
    : '<div class="notice">Action Hub is not running, so this is a read-only view of the ' +
      'last saved configuration and catalog. Controls are disabled until the hub starts.</div>';

  const savingsPct = state.context && state.context.eagerTokensEstimate > state.context.hubTokensEstimate
    ? Math.round((1 - state.context.hubTokensEstimate / state.context.eagerTokensEstimate) * 100) + "%"
    : "—";

  $("stats").innerHTML =
    '<div class="stat"><b>' + (state.servers ? state.servers.length : 0) + '</b><span>Servers</span></div>' +
    '<div class="stat"><b>' + (state.actions || 0) + '</b><span>Actions Indexed</span></div>' +
    '<div class="stat"><b>' + ((state.bundles && state.bundles.length) || 0) + '</b><span>Action Bundles</span></div>' +
    '<div class="stat"><b style="color:var(--ok);">' + savingsPct + '</b><span>Context Saved</span></div>';

  $("servers").innerHTML = serverRows(state.servers);
  $("history").innerHTML = historyRows(state.history);
  $("analytics-content").innerHTML = renderAnalytics(state);

  const filter = ($("explorer-filter").value || "").toLowerCase().trim();
  $("bundles-list").innerHTML = bundlesRows(state.bundles, filter);
  $("actions-list").innerHTML = actionsRows(state.actionsList, filter);

  for (const node of document.querySelectorAll("#add-fields input, #add-fields select, #add-run, #q, #q-run, #btn-check-health, #btn-import")) {
    node.disabled = !live;
  }
  $("add-args").disabled = !live || $("add-type").value !== "stdio";

  const picker = $("q-server");
  const keep = picker.value;
  picker.innerHTML = '<option value="">All servers</option>' +
    (state.servers || []).map((s) =>
      '<option value="' + esc(s.id) + '">' + esc(s.displayName) + '</option>').join("");
  picker.value = keep;
  picker.disabled = !live;
}

// EVENTS
$("servers").addEventListener("click", async (event) => {
  const toggleBtn = event.target.closest("[data-toggle]");
  if (toggleBtn) {
    toggleBtn.disabled = true;
    const result = await control("set_server_enabled", {
      serverId: toggleBtn.dataset.toggle,
      enabled: toggleBtn.dataset.enabled !== "1",
    });
    report($("server-result"), result, (r) =>
      r.enabled
        ? 'Enabled "' + r.serverId + '" and indexed ' + r.indexed + ' action(s).'
        : 'Disabled "' + r.serverId + '" and removed its actions from the catalog.');
    await paint();
    return;
  }

  const reconnectBtn = event.target.closest("[data-reconnect]");
  if (reconnectBtn) {
    reconnectBtn.disabled = true;
    const result = await control("reconnect_server", { serverId: reconnectBtn.dataset.reconnect });
    report($("server-result"), result, (r) =>
      'Reconnected "' + r.serverId + '" successfully (status: ' + r.health.status + ', ' + r.health.latencyMs + 'ms).');
    await paint();
  }
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

$("btn-check-health").addEventListener("click", async () => {
  $("btn-check-health").disabled = true;
  const result = await control("check_health", {});
  report($("server-result"), result, () => "Checked health and ping latency for all servers.");
  await paint();
});

async function runSearch() {
  const query = $("q").value.trim();
  if (!query) return;
  $("q-result").innerHTML = '<p class="empty">Searching catalog…</p>';
  const result = await control("test_search", {
    query,
    serverId: $("q-server").value || undefined,
    limit: parseInt($("q-limit").value, 10) || 10,
    includeSchema: $("q-schema").checked
  });
  $("q-result").innerHTML = searchResults(result);
}

$("q-run").addEventListener("click", runSearch);
$("q").addEventListener("keydown", (event) => { if (event.key === "Enter") runSearch(); });

$("explorer-filter").addEventListener("input", () => {
  if (currentState) {
    const filter = $("explorer-filter").value.toLowerCase().trim();
    $("bundles-list").innerHTML = bundlesRows(currentState.bundles, filter);
    $("actions-list").innerHTML = actionsRows(currentState.actionsList, filter);
  }
});

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

// PRESET CLICKS
document.querySelectorAll(".preset-card").forEach(card => {
  card.addEventListener("click", () => {
    const preset = PRESETS[card.dataset.preset];
    if (!preset) return;
    $("add-id").value = preset.id;
    $("add-name").value = preset.name;
    $("add-type").value = preset.type;
    $("add-target").value = preset.target;
    $("add-args").value = preset.args;
    $("add-args").disabled = !live;
    
    // Switch to servers tab and focus add button
    document.querySelector('.tab-btn[data-tab="servers"]').click();
    $("add-run").scrollIntoView({ behavior: "smooth" });
  });
});

// IMPORT CONFIG
$("btn-import").addEventListener("click", async () => {
  const rawText = $("import-json").value.trim();
  if (!rawText) return;
  try {
    const parsed = JSON.parse(rawText);
    $("btn-import").disabled = true;
    const result = await control("import_config", { config: parsed });
    report($("import-result"), result, (r) =>
      'Successfully imported ' + r.count + ' server(s): ' + r.imported.join(", ") +
      (r.errors ? ' (Warnings: ' + r.errors.join("; ") + ')' : ''));
    if (result.ok) {
      $("import-json").value = "";
    }
    await paint();
  } catch (err) {
    $("import-result").innerHTML = '<div class="notice err">Invalid JSON format: ' + esc(err.message) + '</div>';
  } finally {
    $("btn-import").disabled = false;
  }
});

paint();
setInterval(paint, 4000);
</script>
</body>
</html>`;
}

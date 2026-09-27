
process.on("SIGTERM", () => {});
const fs = require("node:fs");
const cp = require("node:child_process");
const net = require("node:net");
// A closed relay end must never wedge the anchor (intake finding): exit
// instead of blocking forever on EPIPE.
try {
  process.stdout.on("error", () => process.exit(0));
  process.stderr.on("error", () => process.exit(0));
} catch (err) {}
// fd 3 is a socketpair (libuv extra-stdio pipes are SOCK_STREAM): wrap it in
// a net.Socket so the control channel is EVENTED and never blocks the event
// loop (a blocking readSync here would freeze the workload 'exit' callback —
// the exact bug that hung the first smoke probe).
const control = new net.Socket({ fd: 3, readable: true, writable: true });
control.setEncoding("utf8");
const send = (obj) => { try { control.write(JSON.stringify(obj) + "\n"); } catch (err) {} };
send({ op: "ready" });
let workload = null;
let buf = "";
function handleLine(line) {
  let msg = null;
  try { msg = JSON.parse(line); } catch (err) { msg = null; }
  if (!msg) return;
  if (msg.op === "spawn" && !workload) {
    const wstdio = Array.isArray(msg.stdio) && msg.stdio.length === 3
      ? msg.stdio.map((s) => (s === "pipe" ? "pipe" : "ignore"))
      : ["ignore", "pipe", "pipe"];
    try {
      workload = cp.spawn(String(msg.cmd), msg.args || [], {
        env: msg.env, cwd: msg.cwd, stdio: wstdio, detached: false,
      });
    } catch (err) {
      send({ op: "spawn-error", error: String(err && err.message) });
      return;
    }
    workload.on("error", (err) => send({ op: "workload-error", error: String(err && err.message) }));
    workload.on("exit", (code, signal) => send({ op: "workload-exit", code, signal }));
    if (wstdio[0] === "pipe" && workload.stdin) process.stdin.pipe(workload.stdin);
    if (wstdio[1] === "pipe" && workload.stdout) workload.stdout.pipe(process.stdout);
    if (wstdio[2] === "pipe" && workload.stderr) workload.stderr.pipe(process.stderr);
    send({ op: "spawned", pid: workload.pid });
  } else if (msg.op === "exit") {
    process.exit(0);
  }
}
control.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    handleLine(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
  }
});
control.on("error", () => process.exit(0)); // parent vanished: no wedge
control.on("close", () => process.exit(0)); // parent gone: no wedge
process.on("disconnect", () => process.exit(0));

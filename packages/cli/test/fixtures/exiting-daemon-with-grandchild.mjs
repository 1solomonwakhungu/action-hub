// Daemon-start fixture: an "almost daemon" that spawns a same-group
// TERM-ignoring grandchild (durable setInterval keep-alive), records both
// PIDs to TREE_PIDS_FILE, then exits 3 after 200ms — before ever becoming
// ready. Proves a failed start kills the whole process group even when the
// direct child exited on its own.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

if (process.argv[2] === "child") {
  process.on("SIGTERM", () => {
    // Deliberately ignores SIGTERM; only a group signal can end it.
  });
  // Durable handle: keeps the event loop alive regardless of any pipe.
  setInterval(() => {}, 1000);
} else {
  const pidFile = process.env["TREE_PIDS_FILE"];
  appendFileSync(pidFile, `${process.pid}\n`);
  // NOT detached: the grandchild joins the daemon's process group.
  const grandchild = spawn(process.execPath, [import.meta.filename, "child"], {
    detached: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  grandchild.unref();
  appendFileSync(pidFile, `${grandchild.pid}\n`);
  setTimeout(() => process.exit(3), 200);
}

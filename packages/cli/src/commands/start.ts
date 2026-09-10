import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

export interface StartOptions {
  configPath?: string;
  port?: number;
}

export async function startCommand(options: StartOptions = {}): Promise<number> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Locate the copilot-mcp server entry point
  const possiblePaths = [
    resolve(__dirname, "../../copilot-plugin/server/dist/index.js"),
    resolve(__dirname, "../../../copilot-plugin/server/dist/index.js"),
  ];

  let serverScript: string | undefined;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      serverScript = p;
      break;
    }
  }

  if (!serverScript) {
    console.error("Could not locate @action-hub/copilot-mcp server build. Run `npm run build` first.");
    return 1;
  }

  const env = { ...process.env };
  if (options.configPath) {
    env["ACTION_HUB_CONFIG"] = options.configPath;
  }

  const child = spawn(process.execPath, [serverScript], {
    stdio: "inherit",
    env,
  });

  return new Promise((resolve) => {
    child.on("exit", (code) => {
      resolve(code ?? 0);
    });
  });
}

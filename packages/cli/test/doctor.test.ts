import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { doctorCommand } from "../dist/commands/doctor.js";

test("doctor output contains no secret sentinels from server config", async () => {
  const SENTINELS = [
    "DOCTOR_URL_USER_35",
    "DOCTOR_URL_PASS_35",
    "DOCTOR_URL_QUERY_35",
    "DOCTOR_ARG_TOKEN_35",
    "DOCTOR_ENV_VALUE_35",
  ];
  const tempDir = resolve(tmpdir(), `action-hub-doctor-test-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const cfgPath = join(tempDir, "servers.json");
  await writeFile(
    cfgPath,
    JSON.stringify({
      servers: [
        {
          id: "broken-http",
          transport: {
            type: "http",
            url: `https://DOCTOR_URL_USER_35:DOCTOR_URL_PASS_35@127.0.0.1:1/mcp?token=DOCTOR_URL_QUERY_35`,
          },
        },
        {
          id: "broken-stdio",
          transport: {
            type: "stdio",
            command: "node",
            // Echoes the configured env secret and exits 1, exercising the
            // sanitized child-stderr path and the error-string sanitizer.
            args: ["-e", "process.stderr.write('AUTH ' + process.env.API_TOKEN);process.exit(1);"],
            env: { API_TOKEN: "DOCTOR_ENV_VALUE_35" },
          },
        },
      ],
      bundles: [],
    }),
    "utf8",
  );

  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const code = await doctorCommand({ configPath: cfgPath, checkConnectivity: true });
    assert.equal(code, 1, "expected doctor to exit 1 with failing servers");
    const output = logs.join("\n");
    assert.match(output, /broken-http|broken-stdio/);
    for (const sentinel of SENTINELS) {
      assert.ok(!output.includes(sentinel), `sentinel ${sentinel} must never appear in doctor output`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(tempDir, { recursive: true, force: true });
  }
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { applyNodeMemoryLimit, type JsonSchema, type McpClient, type McpClientFactory, type ServerConfig } from "@action-hub/core";

const CLIENT_INFO = { name: "action-hub-cli", version: "0.1.0" } as const;

export const createSdkClientFactory: () => McpClientFactory = () => async (config: ServerConfig) => {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const transport = buildTransport(config);

  await client.connect(transport);

  return {
    async listTools() {
      const response = await client.listTools();
      return response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as JsonSchema | undefined,
      }));
    },

    async callTool(name: string, args: Record<string, unknown>) {
      const response = await client.callTool({ name, arguments: args });
      if (response.isError === true) {
        throw new Error(renderError(response.content));
      }
      return response.content;
    },

    async close() {
      await client.close();
    },
  } satisfies McpClient;
};

function buildTransport(config: ServerConfig) {
  if (config.transport.type === "stdio") {
    const { command, args, env, cwd } = config.transport;
    const limited = applyNodeMemoryLimit(
      command,
      args ?? [],
      { ...inheritableEnv(), ...(env ?? {}) },
      config.maxOldSpaceSizeMb,
    );
    return new StdioClientTransport({
      command: limited.command,
      args: limited.args,
      env: limited.env,
      cwd,
    });
  }

  const { url, headers } = config.transport;
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
}

function inheritableEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function renderError(content: unknown): string {
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isTextPart(part) ? part.text : ""))
      .filter((part) => part.length > 0)
      .join("\n");
    if (text.length > 0) return text;
  }
  return "Downstream tool reported an error";
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}


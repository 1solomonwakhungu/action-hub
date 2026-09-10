import type { JsonSchema, McpClient, ServerConfig } from "../dist/types.js";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

/** In-memory MCP client so the engine can be tested without spawning servers. */
export class FakeClient implements McpClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;

  readonly #tools: FakeTool[];
  readonly #responder: (name: string, args: Record<string, unknown>) => unknown;
  listError?: Error;
  listCalls = 0;

  constructor(
    tools: FakeTool[],
    responder: (name: string, args: Record<string, unknown>) => unknown = (name) => `ok:${name}`,
  ) {
    this.#tools = tools;
    this.#responder = responder;
  }

  async listTools(): Promise<FakeTool[]> {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    return this.#tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    return this.#responder(name, args);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Tracks how many times each server was actually connected. */
export function makeFactory(clients: Record<string, FakeClient>) {
  const activations: string[] = [];
  const factory = async (config: ServerConfig): Promise<McpClient> => {
    activations.push(config.id);
    const client = clients[config.id];
    if (!client) throw new Error(`No fake client for "${config.id}"`);
    return client;
  };
  return { factory, activations };
}

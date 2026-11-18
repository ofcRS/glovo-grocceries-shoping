import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ServerDeps } from "../../src/tools";

export async function connectedClient(deps?: Partial<ServerDeps>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(deps);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

export function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  if (!first || first.type !== "text" || first.text === undefined) throw new Error("no text content");
  return first.text;
}

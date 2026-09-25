import { test, expect } from "bun:test";
import { connectedClient, textOf } from "./helpers/mcp";

test("server lists ping and answers pong", async () => {
  const client = await connectedClient();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("ping");
  const res = await client.callTool({ name: "ping", arguments: {} });
  expect(textOf(res)).toBe("pong");
});

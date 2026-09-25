import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "grocery-mcp", version: "0.1.0" });

  server.registerTool(
    "ping",
    { description: "Health check for the grocery MCP server.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  return server;
}

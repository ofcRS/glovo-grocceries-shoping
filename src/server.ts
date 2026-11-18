import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./tools";

const server = createServer();
await server.connect(new StdioServerTransport());

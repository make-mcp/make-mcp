import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMakeMcpServer, type ServerOptions } from "./server.js";

export { createMakeMcpServer, SERVER_VERSION, type ServerOptions } from "./server.js";
export { testServer, type ServerTestResult, type TestServerOptions } from "./test-server.js";

export async function startStdioServer(options: ServerOptions = {}): Promise<void> {
  await createMakeMcpServer(options).connect(new StdioServerTransport());
}

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

// Installs the generated server's dependencies from npm; run with `npm run test:e2e` after `npm run build`.
const enabled = process.env.MAKE_MCP_E2E === "1";
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = mkdtempSync(join(tmpdir(), "make-mcp-run-"));

afterAll(() => rmSync(cache, { recursive: true, force: true }));

async function connect() {
  const client = new Client({ name: "make-mcp-e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "packages/cli/dist/index.js"), "run", "daisyUI", "--fixtures", join(root, "fixtures/http"), "--workspace", join(root, "fixtures/workspaces/daisyui")],
      env: { ...(process.env as Record<string, string>), MAKE_MCP_CACHE_DIR: cache },
      stderr: "pipe",
    }),
  );
  return client;
}

describe.skipIf(!enabled)("make-mcp run", () => {
  it("builds the project's version once and serves it over stdio", { timeout: 300_000 }, async () => {
    for (let round = 0; round < 2; round++) {
      const client = await connect();
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(["search_docs", "get_page", "list_topics", "get_component"]);
        const result = await client.callTool({ name: "get_component", arguments: { name: "button" } });
        expect((result.content as { text: string }[])[0]?.text).toContain("btn");
      } finally {
        await client.close();
      }
    }
    const builds = readdirSync(join(cache, "servers", "daisyui"));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatch(/^5\.7\.50-ts-/);
    expect(existsSync(join(cache, "servers", "daisyui", builds[0]!, "dist", "index.js"))).toBe(true);
  });

  it("survives parallel first starts of the same server", { timeout: 300_000 }, async () => {
    const cache2 = mkdtempSync(join(tmpdir(), "make-mcp-run-par-"));
    try {
      const prepare = () =>
        promisify(execFile)(
          process.execPath,
          [join(root, "packages/cli/dist/index.js"), "run", "daisyUI", "--prepare", "--fixtures", join(root, "fixtures/http"), "--workspace", join(root, "fixtures/workspaces/daisyui")],
          { env: { ...process.env, MAKE_MCP_CACHE_DIR: cache2 } },
        );
      await Promise.all([prepare(), prepare(), prepare()]);
      const entries = readdirSync(join(cache2, "servers", "daisyui"));
      expect(entries).toHaveLength(1);
      expect(existsSync(join(cache2, "servers", "daisyui", entries[0]!, "dist", "index.js"))).toBe(true);
    } finally {
      rmSync(cache2, { recursive: true, force: true });
    }
  });
});

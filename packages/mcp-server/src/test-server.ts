import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { needsRefresh, refreshDocs, type Fetcher, type Manifest } from "@make-mcp/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);

export interface ServerTestResult {
  ok: boolean;
  language: "ts" | "py";
  tools: string[];
  resources: number;
  resourceTemplates: number;
  sampleCall?: { tool: string; ok: boolean; preview: string };
  steps: string[];
  error?: string;
}

export interface TestServerOptions {
  apiFetcher: Fetcher;
  contentFetcher: Fetcher;
  /** Skip dependency installation (e.g. when node_modules already resolve). */
  skipInstall?: boolean;
}

/**
 * Installs, builds and starts a generated server over stdio, then lists its tools
 * and calls one read-only docs tool as a smoke test.
 */
export async function testServer(dir: string, options: TestServerOptions): Promise<ServerTestResult> {
  const language = existsSync(join(dir, "server.py")) ? "py" : "ts";
  const manifest = JSON.parse(readFileSync(join(dir, "data", "manifest.json"), "utf8")) as Manifest;
  const steps: string[] = [];
  const result: ServerTestResult = { ok: false, language, tools: [], resources: 0, resourceTemplates: 0, steps };

  try {
    if (needsRefresh(manifest)) {
      const refreshed = await refreshDocs(dir, { ...options, ifMissing: true });
      steps.push(refreshed.skipped ? "docs cache present" : `downloaded ${refreshed.pages} doc pages to local cache`);
      if (refreshed.failed.length) steps.push(`docs not downloaded: ${refreshed.failed.join(", ")}`);
    }

    if (!options.skipInstall) {
      if (language === "ts") {
        // Scripts are skipped: the postinstall refresh already ran above.
        await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dir });
        steps.push("npm install");
        await run("npm", ["run", "build"], { cwd: dir });
        steps.push("npm run build");
      } else {
        await run("uv", ["sync", "--quiet"], { cwd: dir });
        steps.push("uv sync");
      }
    }

    const client = new Client({ name: "make-mcp-test", version: "0.1.0" });
    const transport =
      language === "ts"
        ? new StdioClientTransport({
            command: process.execPath,
            args: [existsSync(join(dir, "dist/index.js")) ? join(dir, "dist/index.js") : join(dir, "src/index.ts")],
            stderr: "pipe",
          })
        : new StdioClientTransport({ command: "uv", args: ["run", "--no-sync", "--directory", dir, "server.py"], stderr: "pipe" });
    await client.connect(transport);
    steps.push("started over stdio");

    try {
      result.tools = (await client.listTools()).tools.map((t) => t.name);
      result.resources = (await client.listResources()).resources.length;
      result.resourceTemplates = (await client.listResourceTemplates()).resourceTemplates.length;

      if (result.tools.includes("list_topics")) {
        const call = await client.callTool({ name: "list_topics", arguments: {} });
        const text = (call.content as { type: string; text?: string }[])[0]?.text ?? "";
        result.sampleCall = { tool: "list_topics", ok: !call.isError, preview: text.slice(0, 300) };
      }
    } finally {
      await client.close();
    }

    result.ok = result.tools.length > 0 && (result.sampleCall?.ok ?? true);
  } catch (err) {
    const e = err as Error & { stderr?: string };
    result.error = `${e.message}${e.stderr ? `\n${e.stderr.slice(-2000)}` : ""}`;
  }
  return result;
}

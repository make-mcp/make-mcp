import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFixtureFetch,
  createPoliteFetch,
  detectContext,
  generateProject,
  resolveIntake,
  writeProject,
} from "@make-mcp/core";

// Needs network for `uv sync`; run with `npm run test:e2e`.
const enabled = process.env.MAKE_MCP_E2E === "1";
const fixtures = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const apiFetcher = createFixtureFetch(fixtures("http"));
const contentFetcher = createPoliteFetch(apiFetcher, { delayMs: 0 });
const outRoot = mkdtempSync(join(tmpdir(), "make-mcp-py-"));

afterAll(() => rmSync(outRoot, { recursive: true, force: true }));

async function generatePython(target: string, workspace: string, answers: Record<string, string>, env: Record<string, string> = {}, name?: string) {
  const findings = await detectContext({ target, workspaceRoot: fixtures(workspace), apiFetcher, contentFetcher });
  const outDir = join(outRoot, name ?? `${findings.slug}-${answers.tools ?? "default"}`);
  const resolved = resolveIntake(findings, { ...answers, language: "py", register: "none", outDir });
  const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: outRoot });
  writeProject(project);
  execFileSync("uv", ["sync", "--quiet", "--directory", project.outDir], { stdio: "inherit" });
  const client = new Client({ name: "make-mcp-e2e", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "uv",
      args: ["run", "--no-sync", "--directory", project.outDir, "server.py"],
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "pipe",
    }),
  );
  return { project, client };
}

const firstText = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]?.text ?? "";

async function waitForHealth(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(url).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

describe.skipIf(!enabled)("generated Python servers", () => {
  it("daisyUI docs server answers tools and resources", { timeout: 180_000 }, async () => {
    const { project, client } = await generatePython("daisyUI", "workspaces/daisyui", { mode: "docs" });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(project.tools);
      const result = await client.callTool({ name: "get_component", arguments: { name: "button" } });
      expect(firstText(result)).toContain("btn");
      // BM25 with prefix matching: "butt" finds the button page first.
      expect(firstText(await client.callTool({ name: "search_docs", arguments: { query: "butt" } }))).toMatch(/^.*path: components\/button/m);
      const refresh = spawnSync("uv", ["run", "--no-sync", "--directory", project.outDir, "server.py", "--refresh"], { encoding: "utf8" });
      expect(refresh.status).toBe(0);
      expect(refresh.stderr).toContain("documentation is embedded");
      const page = await client.readResource({ uri: "docs://daisyui/components/card" });
      expect((page.contents[0] as { text: string }).text).toContain("card");
    } finally {
      await client.close();
    }
  });

  it("Petstore API server lists the same tools as the TypeScript variant", { timeout: 180_000 }, async () => {
    const { project, client } = await generatePython("https://petstore3.example.com/openapi.yaml", "workspaces/empty", {});
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(project.tools);
      expect(tools.find((t) => t.name === "delete_pet")?.annotations?.destructiveHint).toBe(true);
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["api://swagger-petstore/pet/{petId}"]);
    } finally {
      await client.close();
    }
  });

  it("grouped Petstore server lists, describes and calls operations", { timeout: 180_000 }, async () => {
    const requests: string[] = [];
    const api = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 7, name: "Rex" }));
    });
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v3`;
    const { client } = await generatePython("https://petstore3.example.com/openapi.yaml", "workspaces/empty", { tools: "grouped" }, {
      SWAGGER_PETSTORE_BASE_URL: baseUrl,
    });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_operations", "describe_operation", "call_operation"]);
      expect(firstText(await client.callTool({ name: "list_operations", arguments: { query: "inventory" } }))).toContain("get_inventory – GET /store/inventory");
      const detail = JSON.parse(firstText(await client.callTool({ name: "describe_operation", arguments: { operation: "get_pet_by_id" } })));
      expect(detail.arguments.required).toEqual(["petId"]);
      const call = await client.callTool({ name: "call_operation", arguments: { operation: "get_pet_by_id", arguments: { petId: 7 } } });
      expect(firstText(call)).toContain('"name": "Rex"');
      expect(requests).toEqual(["GET /api/v3/pet/7"]);
    } finally {
      await client.close();
      api.close();
    }
  });

  it("serves legacy SSE behind MCP_AUTH_TOKEN", { timeout: 180_000 }, async () => {
    const { project, client } = await generatePython("daisyUI", "workspaces/daisyui", { mode: "docs" }, {}, "daisyui-sse");
    await client.close();
    const port = 39_000 + Math.floor(Math.random() * 1000);
    const child = spawn("uv", ["run", "--no-sync", "--directory", project.outDir, "server.py"], {
      env: { ...process.env, MCP_TRANSPORT: "sse", PORT: String(port), MCP_AUTH_TOKEN: "secret" },
      stdio: "ignore",
    });
    try {
      await waitForHealth(`http://127.0.0.1:${port}/healthz`);
      expect((await fetch(`http://127.0.0.1:${port}/sse`)).status).toBe(401);
      const sse = new Client({ name: "make-mcp-e2e-sse", version: "0.0.0" });
      const headers = { authorization: "Bearer secret" };
      await sse.connect(
        new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
          eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) },
          requestInit: { headers },
        }),
      );
      const { tools } = await sse.listTools();
      expect(tools.map((t) => t.name)).toContain("search_docs");
      await sse.close();
    } finally {
      child.kill();
    }
  });
});

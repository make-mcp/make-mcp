import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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

async function generatePython(target: string, workspace: string, answers: Record<string, string>) {
  const findings = await detectContext({ target, workspaceRoot: fixtures(workspace), apiFetcher, contentFetcher });
  const resolved = resolveIntake(findings, { ...answers, language: "py", register: "none", outDir: join(outRoot, findings.slug) });
  const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: outRoot });
  writeProject(project);
  execFileSync("uv", ["sync", "--quiet", "--directory", project.outDir], { stdio: "inherit" });
  const client = new Client({ name: "make-mcp-e2e", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "uv", args: ["run", "--no-sync", "--directory", project.outDir, "server.py"], stderr: "pipe" }));
  return { project, client };
}

describe.skipIf(!enabled)("generated Python servers", () => {
  it("daisyUI docs server answers tools and resources", { timeout: 180_000 }, async () => {
    const { project, client } = await generatePython("daisyUI", "workspaces/daisyui", { mode: "docs" });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(project.tools);
      const result = await client.callTool({ name: "get_component", arguments: { name: "button" } });
      expect((result.content as { text: string }[])[0]?.text).toContain("btn");
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
});

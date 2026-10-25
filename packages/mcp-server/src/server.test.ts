import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFetchers } from "@make-mcp/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { createMakeMcpServer } from "./server.js";
import { testServer } from "./test-server.js";

const fixtures = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const fetchers = createFetchers({ fixturesDir: fixtures("http") });
// Inside the repo so the generated server resolves its dependencies from the root node_modules.
const workspace = mkdtempSync(join(fileURLToPath(new URL("../", import.meta.url)), ".e2e-ws-"));
cpSync(fixtures("workspaces/daisyui"), workspace, { recursive: true });

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

async function connect() {
  const server = createMakeMcpServer({ fetchers, defaultWorkspace: workspace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "agent", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const parse = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;

describe("make-mcp server flow (daisyUI)", async () => {
  const client = await connect();

  it("advertises the workflow tools and prompt", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "detect_context",
      "submit_answers",
      "preview_plan",
      "generate_server",
      "test_server",
      "register_server",
    ]);
    const prompt = await client.getPrompt({ name: "create_mcp", arguments: { target: "daisyui" } });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain("detect_context");
    expect(client.getInstructions()).toContain("Wait for an explicit");
  });

  let sessionId = "";
  let outDir = "";

  it("detects context and asks only what is unknown", async () => {
    const result = parse(await client.callTool({ name: "detect_context", arguments: { target: "daisyUI" } }));
    sessionId = result.sessionId as string;
    expect((result.findings as { version: { value: string } }).version.value).toBe("5.7.50");
    expect((result.questions as { id: string }[]).map((q) => q.id)).toEqual(["mode", "register"]);
  });

  it("refuses to preview while questions are open", async () => {
    const result = await client.callTool({ name: "preview_plan", arguments: { sessionId } });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: "INTAKE_INCOMPLETE", missing: ["mode", "register"] });
  });

  it("accepts answers by label and previews the plan", async () => {
    const answered = parse(await client.callTool({ name: "submit_answers", arguments: { sessionId, answers: { mode: "Look up knowledge", register: "project" } } }));
    expect(answered.ready).toBe(true);
    const preview = await client.callTool({ name: "preview_plan", arguments: { sessionId } });
    expect((preview.content as { text: string }[])[0]!.text).toContain("Target:      daisyUI 5.7.50");
  });

  it("generates, smoke-tests and registers after showing the diff", async () => {
    const generated = parse(await client.callTool({ name: "generate_server", arguments: { sessionId } }));
    outDir = generated.outDir as string;
    expect(generated.tools).toEqual(["search_docs", "get_page", "list_topics", "get_component"]);
    expect(generated.contentMode).toBe("embedded");

    const smoke = await testServer(outDir, { ...fetchers, skipInstall: true });
    expect(smoke).toMatchObject({ ok: true, tools: ["search_docs", "get_page", "list_topics", "get_component"] });

    const dryRun = parse(await client.callTool({ name: "register_server", arguments: { sessionId } }));
    expect(dryRun.applied).toBe(false);
    expect(existsSync(join(workspace, ".mcp.json"))).toBe(false);
    expect(dryRun.after).toContain('"daisyui"');

    const applied = parse(await client.callTool({ name: "register_server", arguments: { sessionId, apply: true } }));
    expect(applied.applied).toBe(true);
    const config = JSON.parse(readFileSync(join(workspace, ".mcp.json"), "utf8"));
    expect(config.mcpServers.daisyui.args[0]).toBe(join(outDir, "dist", "index.js"));
  });

  it("reports unknown sessions as structured errors", async () => {
    const result = await client.callTool({ name: "preview_plan", arguments: { sessionId: "nope" } });
    expect(parse(result)).toMatchObject({ error: "SESSION_NOT_FOUND" });
  });
});

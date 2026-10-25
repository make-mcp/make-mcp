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
      "extract_api",
      "submit_extraction",
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
    expect((result.questions as { id: string }[]).map((q) => q.id)).toEqual(["bundle"]);
  });

  it("refuses to preview while questions are open", async () => {
    const result = await client.callTool({ name: "preview_plan", arguments: { sessionId } });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: "INTAKE_INCOMPLETE", missing: ["bundle", "mode", "register"] });
  });

  it("accepts answers by label and previews the plan", async () => {
    const answered = parse(await client.callTool({ name: "submit_answers", arguments: { sessionId, answers: { bundle: "single", mode: "Look up knowledge", register: "project" } } }));
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

describe("make-mcp server flow (API extracted from prose docs)", async () => {
  const client = await connect();
  let sessionId = "";

  it("asks whether to extract the API and says so in the plan", async () => {
    const detected = parse(await client.callTool({ name: "detect_context", arguments: { target: "https://notes.example.com/", workspace: fixtures("workspaces/empty") } }));
    sessionId = detected.sessionId as string;
    const answered = parse(
      await client.callTool({
        name: "submit_answers",
        arguments: { sessionId, answers: { mode: "api", version: "latest", docsSource: "Extract from the docs", auth: "none", language: "ts", register: "none", outDir: join(workspace, "notes-mcp") } },
      }),
    );
    expect(answered.ready).toBe(true);
    const preview = (await client.callTool({ name: "preview_plan", arguments: { sessionId } })).content as { text: string }[];
    expect(preview[0]!.text).toContain("extract_api");
  });

  it("refuses to generate before the extraction", async () => {
    const result = await client.callTool({ name: "generate_server", arguments: { sessionId } });
    expect(parse(result)).toMatchObject({ error: "INTAKE_INCOMPLETE" });
  });

  it("hands out pages, validates the agent's JSON and generates", async () => {
    const task = parse(await client.callTool({ name: "extract_api", arguments: { sessionId } }));
    expect(task.instructions).toContain("Never invent endpoints");
    const pages = task.pages as { path: string; title: string }[];
    const pathOf = (title: string) => pages.find((p) => p.title === title)!.path;

    const invalid = await client.callTool({ name: "submit_extraction", arguments: { sessionId, taskId: task.taskId, result: { operations: [{ method: "get" }] } } });
    expect(parse(invalid)).toMatchObject({ error: "SPEC_INVALID" });

    const summary = parse(
      await client.callTool({
        name: "submit_extraction",
        arguments: {
          sessionId,
          taskId: task.taskId,
          result: JSON.stringify({
            baseUrl: "https://api.notes.example.com/v1",
            auth: { type: "apiKey", in: "header", name: "X-Api-Key" },
            operations: [
              { method: "GET", path: "/notes", summary: "List notes", source: { page: pathOf("List notes"), quote: "`GET /notes` returns your notes" } },
              { method: "GET", path: "/users", summary: "List users", source: { page: pathOf("List notes"), quote: "GET /users returns users" } },
            ],
          }),
        },
      }),
    );
    expect(summary.accepted).toEqual(["GET /notes – List notes"]);
    expect((summary.rejected as { path: string }[]).map((r) => r.path)).toEqual(["/users"]);
    expect(summary.remainingTasks).toEqual([]);

    const done = parse(await client.callTool({ name: "extract_api", arguments: { sessionId } }));
    expect(done.done).toBe(true);

    const generated = parse(await client.callTool({ name: "generate_server", arguments: { sessionId } }));
    expect(generated.tools).toEqual(["list_notes"]);
    expect((generated.envVars as { name: string }[]).map((v) => v.name)).toEqual(["NOTES_API_KEY", "NOTES_BASE_URL"]);
  });
});

describe("make-mcp server flow (whole project)", async () => {
  const client = await connect();

  it("offers one server for the project's libraries and previews it", async () => {
    const detected = parse(await client.callTool({ name: "detect_context", arguments: { target: "daisyUI", workspace: fixtures("workspaces/project") } }));
    expect((detected.findings as { projectLibraries: string[] }).projectLibraries).toEqual(["@acme/internal", "acme-ui"]);
    expect((detected.questions as { id: string }[]).map((q) => q.id)).toEqual(["bundle"]);

    const answered = parse(
      await client.callTool({ name: "submit_answers", arguments: { sessionId: detected.sessionId, answers: { bundle: "Whole project", register: "none" } } }),
    );
    expect(answered.ready).toBe(true);
    const preview = (await client.callTool({ name: "preview_plan", arguments: { sessionId: detected.sessionId } })).content as { text: string }[];
    expect(preview[0]!.text).toContain("one docs server for 2 libraries");
    expect(preview[0]!.text).toContain("acme-ui 2.0.0");
  });

  it("starts with the whole project for target \".\"", async () => {
    const detected = parse(await client.callTool({ name: "detect_context", arguments: { target: ".", workspace: fixtures("workspaces/project") } }));
    expect((detected.findings as { libraries: { name: string }[] }).libraries.map((l) => l.name)).toEqual(["acme-ui", "daisyui"]);
    expect((detected.questions as { id: string }[]).map((q) => q.id)).toEqual(["register"]);
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { detectContext } from "../discover/detect.js";
import { isMakeMcpError } from "../errors.js";
import { createFixtureFetch } from "../fetch/fixture-fetch.js";
import { createPoliteFetch } from "../fetch/polite-fetch.js";
import { finishExtraction, generateProject, startExtraction, writeProject } from "../generate/project.js";
import { nextQuestions } from "../intake/questions.js";
import { resolveIntake } from "../intake/resolve.js";
import type { DocCorpus } from "../ir/index.js";
import { createLlmFromEnv, runExtraction, splitResults, type LlmClient } from "./llm.js";
import { canonicalPath, parseModelJson, planExtraction, validateExtraction, type ExtractionResult } from "./prose-api.js";

const fixtures = (path: string) => fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url));
const e2eRoot = fileURLToPath(new URL("../../.e2e/", import.meta.url));
const apiFetcher = createFixtureFetch(fixtures("http"));
const contentFetcher = createPoliteFetch(apiFetcher, { delayMs: 0 });
const now = () => new Date("2026-10-25T10:00:00Z");

/** Stands in for the agent's model: answers like a decent LLM, plus two invented operations. */
function fakeLlm(): LlmClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    label: "fake",
    prompts,
    async complete({ user }) {
      prompts.push(user);
      const pathOf = (title: string) => new RegExp(`=== page: (\\S+) \\(${title}\\) ===`).exec(user)?.[1] ?? "missing";
      const result: ExtractionResult = {
        baseUrl: "https://api.notes.example.com/v1",
        auth: { type: "apiKey", in: "header", name: "X-Api-Key" },
        operations: [
          {
            method: "get",
            path: "/notes",
            summary: "List notes",
            params: [
              { name: "limit", in: "query", type: "integer", description: "at most this many notes" },
              { name: "tag", in: "query", type: "string" },
            ],
            source: { page: pathOf("List notes"), quote: "`GET /notes` returns your notes, newest first." },
          },
          {
            method: "post",
            path: "/notes",
            summary: "Create a note",
            body: {
              fields: [
                { name: "title", type: "string", required: true },
                { name: "body", type: "string", required: true },
                { name: "tags", type: "array" },
              ],
            },
            source: { page: pathOf("Create a note"), quote: "Send a `POST /notes` request with a JSON body:" },
          },
          { method: "get", path: "/notes/:id", summary: "Get a note", source: { page: pathOf("Get a note"), quote: "`GET /notes/:id` returns one note." } },
          {
            method: "delete",
            path: "/notes/{id}",
            summary: "Delete a note",
            source: { page: pathOf("Delete a note"), quote: "`DELETE /notes/{id}` deletes a note permanently." },
          },
          // Invented: neither quote nor path exist.
          { method: "get", path: "/admin/users", summary: "List admin users", source: { page: pathOf("List notes"), quote: "Lists all admin users of the account." } },
          // Real quote, wrong method.
          { method: "patch", path: "/notes/{id}", summary: "Update a note", source: { page: pathOf("Get a note"), quote: "`GET /notes/:id` returns one note." } },
        ],
      };
      return `Here you go:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``;
    },
  };
}

describe("canonicalPath and parseModelJson", () => {
  it("normalizes path parameter syntaxes and full URLs", () => {
    expect(canonicalPath("/notes/:id")).toBe("/notes/{id}");
    expect(canonicalPath("/notes/<noteId>/")).toBe("/notes/{noteId}");
    expect(canonicalPath("https://api.x.com/v1/notes?limit=1")).toBe("/v1/notes");
    expect(canonicalPath("notes")).toBeUndefined();
    expect(canonicalPath("/v1/things/{id}:cancel")).toBe("/v1/things/{id}:cancel");
    expect(canonicalPath("/items:search")).toBe("/items:search");
  });

  it("reads JSON wrapped in prose or code fences", () => {
    expect(parseModelJson('Sure! {"operations": []} Done.')).toEqual({ operations: [] });
    expect(parseModelJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(() => parseModelJson("I could not find any endpoints.")).toThrow(/not valid JSON/);
  });
});

describe("Acme Notes: API from prose documentation", async () => {
  afterAll(() => api.close());
  const requests: { method?: string; url?: string; key?: string | string[]; body: string }[] = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], body });
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: "n1" }));
    });
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));

  const findings = await detectContext({ target: "https://notes.example.com/", workspaceRoot: fixtures("workspaces/empty"), apiFetcher, contentFetcher });

  it("offers extraction when there is no OpenAPI spec", () => {
    expect(findings.openapi).toBeUndefined();
    const docsQuestion = nextQuestions(findings, { mode: "api" }).find((q) => q.id === "docsSource");
    expect(docsQuestion?.default).toBe("extract");
    expect(docsQuestion?.options.map((o) => o.value)).toEqual(["extract", "none"]);
  });

  const resolved = resolveIntake(findings, { mode: "api", version: "latest", docsSource: "extract", auth: "none", language: "ts", register: "none", outDir: join(e2eRoot, "notes-mcp") });
  const { corpus, plan } = await startExtraction(resolved, { apiFetcher, contentFetcher, now });

  it("batches API pages and the context pages for auth and base URL", () => {
    expect(resolved).toMatchObject({ apiSource: "docs", docs: [] });
    const titles = plan.tasks.flatMap((t) => t.pages.map((p) => p.title));
    expect(titles.slice(0, 2).sort()).toEqual(["Acme Notes API", "Authentication"].sort());
    expect(titles).toEqual(expect.arrayContaining(["List notes", "Create a note", "Get a note", "Delete a note"]));
    expect(titles).not.toContain("Changelog");
  });

  const llm = fakeLlm();
  const results = await runExtraction(plan, llm);
  const { spec, validated } = finishExtraction(resolved, corpus, results, now);

  it("keeps documented operations and rejects invented ones", () => {
    expect(llm.prompts[0]).toContain("Never invent endpoints");
    expect(spec.endpoints.map((e) => `${e.id} ${e.method.toUpperCase()} ${e.path}`)).toEqual([
      "list_notes GET /notes",
      "create_note POST /notes",
      "get_note GET /notes/{id}",
      "delete_note DELETE /notes/{id}",
    ]);
    expect(validated.rejected.map((r) => `${r.method} ${r.path}: ${r.reason.split(" on page")[0]}`)).toEqual([
      "GET /admin/users: quote not found",
      "PATCH /notes/{id}: PATCH is not documented for this path",
    ]);
    expect(spec.baseUrl).toBe("https://api.notes.example.com/v1");
    expect(spec.auth).toEqual([{ type: "apiKey", in: "header", name: "X-Api-Key", envVar: "NOTES_API_KEY" }]);
    const create = spec.endpoints.find((e) => e.id === "create_note")!;
    expect(create.body?.schema).toMatchObject({ required: ["title", "body"] });
    expect(spec.endpoints.find((e) => e.id === "get_note")!.params).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  });

  it("refuses to generate before the extraction", async () => {
    const err = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now }).catch((e: unknown) => e);
    expect(isMakeMcpError(err, "INTAKE_INCOMPLETE")).toBe(true);
  });

  it("generates a server whose tools call the documented API", async () => {
    const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now, extractedApi: spec, corpus });
    writeProject(project);
    expect(project.tools).toEqual(["list_notes", "create_note", "get_note", "delete_note"]);
    expect(project.files["README.md"]).toContain("extracted from the prose documentation");

    const client = new Client({ name: "make-mcp-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(project.outDir, "src/index.ts")],
        env: {
          ...(process.env as Record<string, string>),
          NOTES_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`,
          NOTES_API_KEY: "k-123",
        },
        stderr: "pipe",
      }),
    );
    try {
      const result = await client.callTool({ name: "create_note", arguments: { body: { title: "Hi", body: "there" } } });
      expect(result.isError).toBeFalsy();
      expect(requests).toEqual([{ method: "POST", url: "/v1/notes", key: "k-123", body: '{"title":"Hi","body":"there"}' }]);
    } finally {
      await client.close();
    }
  });
});

describe("planExtraction", () => {
  const page = (path: string, markdown: string) => ({ path, title: path, kind: "page" as const, markdown, sourceUrl: `https://x/${path}` });

  it("skips documentation without an HTTP API", () => {
    const corpus: DocCorpus = { title: "ui", pages: [page("button", "Use `btn btn-primary` for buttons.")], sources: [] };
    expect(planExtraction(corpus).tasks).toEqual([]);
  });

  it("splits large API references into bounded batches", () => {
    const pages = Array.from({ length: 6 }, (_, i) => page(`p${i}`, `GET /items/${i} returns an item.\n${"x".repeat(900)}`));
    const plan = planExtraction({ title: "big", pages, sources: [] }, { maxCharsPerTask: 2000, maxTasks: 2 });
    expect(plan.tasks.map((t) => t.pages.length)).toEqual([2, 2]);
    expect(plan.skippedPages).toBe(2);
  });

  it("validates only against the cited page", () => {
    const corpus: DocCorpus = { title: "t", pages: [page("a", "GET /a lists A."), page("b", "Nothing here.")], sources: [] };
    const result = validateExtraction([{ operations: [{ method: "get", path: "/a", summary: "List A", source: { page: "b", quote: "GET /a lists A." } }] }], corpus);
    expect(result.operations).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("quote not found on page b");
  });
});

describe("createLlmFromEnv", () => {
  it("picks a provider from the environment", () => {
    expect(createLlmFromEnv({})).toBeUndefined();
    expect(createLlmFromEnv({ ANTHROPIC_API_KEY: "k" })?.label).toBe("Anthropic claude-sonnet-5-5");
    expect(createLlmFromEnv({ MAKE_MCP_LLM_BASE_URL: "http://localhost:11434/v1", MAKE_MCP_LLM_MODEL: "qwen3" })?.label).toBe("qwen3 via localhost:11434");
    expect(() => createLlmFromEnv({ OPENAI_API_KEY: "k" })).toThrow(/MAKE_MCP_LLM_MODEL/);
  });
});

describe("validation guards against steering and invented details", () => {
  const page = (path: string, markdown: string) => ({ path, title: path, kind: "page" as const, markdown, sourceUrl: `https://docs.example.com/${path}` });
  const corpus: DocCorpus = {
    title: "t",
    pages: [
      page("users", "`GET /users/{id}` returns a user. You can delete your account in the settings.\nAPI: https://api.example.com/v2"),
      page("auth", "Send `X-Api-Key`. Tokens: https://auth.example.com/oauth/token – mirror: https://evil.example.net/token and https://evil.example.net/v2"),
    ],
    sources: [{ kind: "website", url: "https://docs.example.com/", fetchedAt: "2026-10-25T00:00:00Z" }],
  };
  const quote = "`GET /users/{id}` returns a user.";

  it("needs the method next to the path, not just somewhere in the prose", () => {
    const result = validateExtraction(
      [{ operations: [{ method: "delete", path: "/users/{id}", summary: "Delete user", source: { page: "users", quote } }] }],
      corpus,
    );
    expect(result.rejected[0]?.reason).toMatch(/DELETE is not documented for this path/);
  });

  it("rejects reserved or undocumented header parameters", () => {
    const op = (name: string) => ({ method: "get" as const, path: "/users/{id}", summary: "Get user", params: [{ name, in: "header" as const }], source: { page: "users", quote } });
    const result = validateExtraction([{ operations: [op("Authorization"), op("X-Forwarded-For")] }], corpus);
    expect(result.operations).toEqual([]);
    expect(result.rejected).toHaveLength(2);
  });

  it("only keeps base and token URLs on the documentation's own site", () => {
    const foreign = validateExtraction(
      [{ baseUrl: "https://evil.example.net/v2", auth: { type: "oauth2", tokenUrl: "https://evil.example.net/token" }, operations: [] }],
      corpus,
    );
    expect(foreign.baseUrl).toBeUndefined();
    expect(foreign.auth).toEqual({ type: "oauth2" });
    expect(foreign.notes.join(" ")).toMatch(/not on the documentation's site/);

    const own = validateExtraction(
      [{ baseUrl: "https://api.example.com/v2", auth: { type: "oauth2", tokenUrl: "https://auth.example.com/oauth/token" }, operations: [] }],
      corpus,
    );
    expect(own).toMatchObject({ baseUrl: "https://api.example.com/v2", auth: { tokenUrl: "https://auth.example.com/oauth/token" } });
  });

  it("ignores API key names that are not in the docs", () => {
    expect(validateExtraction([{ auth: { type: "apiKey", name: "key" }, operations: [] }], corpus).auth).toBeUndefined();
    expect(validateExtraction([{ auth: { type: "apiKey", name: "X-Api-Key" }, operations: [] }], corpus).auth?.name).toBe("X-Api-Key");
  });
});

describe("runExtraction", () => {
  it("keeps results aligned with their batches when one batch fails", async () => {
    const page = (path: string) => ({ path, title: path, kind: "page" as const, markdown: `GET /${path} returns it.\n${"x".repeat(900)}`, sourceUrl: "https://x/" });
    const plan = planExtraction({ title: "t", pages: [page("a"), page("b"), page("c")], sources: [] }, { maxCharsPerTask: 1000 });
    expect(plan.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    let call = 0;
    const llm: LlmClient = {
      label: "flaky",
      async complete({ user }) {
        call++;
        // The second batch never yields valid JSON, even on retry.
        if (user.includes("=== page: b ")) return "sorry, no idea";
        return JSON.stringify({ operations: [{ method: "get", path: `/${user.includes("=== page: a ") ? "a" : "c"}`, summary: "Get it", source: { page: "x", quote: "returns it." } }] });
      },
    };
    const results = await runExtraction(plan, llm);
    expect(results.map((r) => r?.operations[0]?.path)).toEqual(["/a", undefined, "/c"]);
    expect(splitResults(plan, results).failed).toEqual(["t2"]);
    expect(call).toBe(4);
  });
});


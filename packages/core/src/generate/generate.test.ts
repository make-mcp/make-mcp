import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { detectContext } from "../discover/detect.js";
import { isMakeMcpError } from "../errors.js";
import { createFixtureFetch } from "../fetch/fixture-fetch.js";
import { createPoliteFetch } from "../fetch/polite-fetch.js";
import { resolveIntake } from "../intake/resolve.js";
import { generateProject, hostPath, writeProject, zipProject } from "./project.js";
import { applyRegistration, planRegistration } from "./register.js";

const fixtures = (path: string) => fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url));
// Generated into the repo so the server resolves @modelcontextprotocol/sdk and minisearch from the root node_modules.
const e2eRoot = fileURLToPath(new URL("../../.e2e/", import.meta.url));
const apiFetcher = createFixtureFetch(fixtures("http"));
const contentFetcher = createPoliteFetch(apiFetcher, { delayMs: 0 });
const now = () => new Date("2026-10-25T10:00:00Z");

afterAll(() => {
  if (!process.env.MAKE_MCP_KEEP_E2E) rmSync(e2eRoot, { recursive: true, force: true });
});

async function connect(dir: string, env: Record<string, string> = {}) {
  const client = new Client({ name: "make-mcp-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(dir, "src/index.ts")],
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "pipe",
    }),
  );
  return client;
}

const firstText = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? "";

describe("daisyUI docs server (TypeScript)", async () => {
  const findings = await detectContext({ target: "daisyUI", workspaceRoot: fixtures("workspaces/daisyui"), apiFetcher, contentFetcher });
  const resolved = resolveIntake(findings, { mode: "docs", register: "none", outDir: join(e2eRoot, "daisyui-mcp") });
  const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now });
  writeProject(project);

  it("embeds the MIT-licensed docs and attributes the source", () => {
    expect(project.manifest.docs?.contentMode).toBe("embedded");
    expect(Object.keys(project.files).sort()).toEqual(
      [".gitignore", "Dockerfile", "README.md", "data/corpus.json", "data/manifest.json", "package.json", "src/index.ts", "tsconfig.json"].sort(),
    );
    expect(project.tools).toEqual(["search_docs", "get_page", "list_topics", "get_component"]);
    const readme = project.files["README.md"]!;
    expect(readme).toContain("**License of the documentation:** MIT");
    expect(readme).toContain("https://daisyui.com/llms.txt @ 5.7.x");
    expect(readme).toContain('"command": "node"');
    expect(JSON.parse(project.files["package.json"]!).scripts).not.toHaveProperty("postinstall");
  });

  it("answers search_docs and get_component offline", async () => {
    const client = await connect(project.outDir);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(project.tools);

      const search = firstText(await client.callTool({ name: "search_docs", arguments: { query: "button" } }));
      expect(search).toContain("path: components/button");

      const button = firstText(await client.callTool({ name: "get_component", arguments: { name: "Button" } }));
      expect(button).toContain("btn");

      const miss = await client.callTool({ name: "get_component", arguments: { name: "buton" } });
      expect(miss.isError).toBe(true);
      expect(firstText(miss)).toContain("Did you mean: Button");

      const resource = await client.readResource({ uri: "docs://daisyui/components/card" });
      expect((resource.contents[0] as { text: string }).text).toContain("card");
    } finally {
      await client.close();
    }
  });

  it("zips the project under a single root folder", () => {
    const zip = zipProject(project);
    expect(zip.byteLength).toBeGreaterThan(1000);
  });

  it("refuses to overwrite foreign directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "make-mcp-foreign-"));
    writeFileSync(join(dir, "keep.txt"), "mine");
    let caught: unknown;
    try {
      writeProject({ ...project, outDir: dir });
    } catch (err) {
      caught = err;
    }
    expect(isMakeMcpError(caught, "OUTPUT_NOT_EMPTY")).toBe(true);
  });
});

describe("Petstore API server (TypeScript)", async () => {
  const findings = await detectContext({
    target: "https://petstore3.example.com/openapi.yaml",
    workspaceRoot: fixtures("workspaces/empty"),
    apiFetcher,
    contentFetcher,
  });
  const resolved = resolveIntake(findings, { language: "ts", register: "none", outDir: join(e2eRoot, "petstore-mcp") });
  const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now });
  writeProject(project);

  it("generates one tool per operation plus env placeholders", () => {
    expect(project.tools).toEqual(["add_pet", "update_pet", "find_pets_by_status", "get_pet_by_id", "delete_pet", "get_inventory"]);
    expect(project.envVars.map((v) => v.name)).toEqual([
      "SWAGGER_PETSTORE_ACCESS_TOKEN",
      "SWAGGER_PETSTORE_API_KEY",
      "SWAGGER_PETSTORE_BASE_URL",
      "SWAGGER_PETSTORE_API_VERSION",
    ]);
    expect(project.files[".env.example"]).toContain("SWAGGER_PETSTORE_API_KEY=");
  });

  it("exposes tools with annotations and resource templates", async () => {
    const client = await connect(project.outDir);
    try {
      const { tools } = await client.listTools();
      const del = tools.find((t) => t.name === "delete_pet")!;
      expect(del.annotations?.destructiveHint).toBe(true);
      expect(tools.find((t) => t.name === "add_pet")!.inputSchema.required).toEqual(["body"]);
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["api://swagger-petstore/pet/{petId}"]);
    } finally {
      await client.close();
    }
  });
});

describe("Petstore API server with grouped tools (TypeScript)", async () => {
  const findings = await detectContext({
    target: "https://petstore3.example.com/openapi.yaml",
    workspaceRoot: fixtures("workspaces/empty"),
    apiFetcher,
    contentFetcher,
  });
  const resolved = resolveIntake(findings, { language: "ts", register: "none", tools: "grouped", outDir: join(e2eRoot, "petstore-grouped-mcp") });
  const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now });
  writeProject(project);

  const requests: string[] = [];
  const api = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 7, name: "Rex" }));
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  afterAll(() => api.close());
  const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/v3`;

  it("exposes three meta tools and documents them", () => {
    expect(project.manifest.toolMode).toBe("grouped");
    expect(project.tools).toEqual(["list_operations", "describe_operation", "call_operation"]);
    expect(project.files["README.md"]).toContain("`call_operation`");
  });

  it("lists, describes and calls operations", async () => {
    const client = await connect(project.outDir, { SWAGGER_PETSTORE_BASE_URL: baseUrl });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(project.tools);
      expect(tools.find((t) => t.name === "call_operation")!.annotations?.destructiveHint).toBe(true);

      const list = firstText(await client.callTool({ name: "list_operations", arguments: { tag: "pet" } }));
      expect(list).toContain("get_pet_by_id – GET /pet/{petId}");
      expect(list).not.toContain("get_inventory");

      const detail = JSON.parse(firstText(await client.callTool({ name: "describe_operation", arguments: { operation: "get_pet_by_id" } })));
      expect(detail.arguments.required).toEqual(["petId"]);

      const call = await client.callTool({ name: "call_operation", arguments: { operation: "get_pet_by_id", arguments: { petId: 7 } } });
      expect(call.isError).toBeFalsy();
      expect(firstText(call)).toContain('"name": "Rex"');
      expect(requests).toEqual(["GET /api/v3/pet/7"]);

      const unknown = await client.callTool({ name: "call_operation", arguments: { operation: "nope" } });
      expect(unknown.isError).toBe(true);

      const traversal = await client.callTool({ name: "call_operation", arguments: { operation: "get_pet_by_id", arguments: { petId: ".." } } });
      expect(traversal.isError).toBe(true);
      expect(firstText(traversal)).toContain('Invalid path parameter "petId"');
      expect(requests).toEqual(["GET /api/v3/pet/7"]);
    } finally {
      await client.close();
    }
  });
});

describe("registration", () => {
  const ws = mkdtempSync(join(tmpdir(), "make-mcp-reg-"));
  const base = {
    workspaceRoot: ws,
    name: "petstore",
    run: { command: "node", args: ["/x/dist/index.js"] },
    envVars: [
      { name: "P_API_KEY", description: "", secret: true },
      { name: "P_BASE_URL", description: "", secret: false },
    ],
  };

  it("merges into an existing .mcp.json without dropping other servers", () => {
    writeFileSync(join(ws, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const plan = planRegistration({ ...base, scope: "project", client: "claude-code" });
    applyRegistration(plan);
    const config = JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8"));
    expect(Object.keys(config.mcpServers)).toEqual(["other", "petstore"]);
    expect(config.mcpServers.petstore.env).toEqual({ P_API_KEY: "${P_API_KEY:-}" });
  });

  it("writes Cursor config with its env syntax", () => {
    mkdirSync(join(ws, ".cursor"), { recursive: true });
    const plan = planRegistration({ ...base, scope: "project", client: "cursor" });
    applyRegistration(plan);
    expect(JSON.parse(readFileSync(join(ws, ".cursor/mcp.json"), "utf8")).mcpServers.petstore.env).toEqual({ P_API_KEY: "${env:P_API_KEY}" });
  });

  it("returns a command for global scope instead of editing user files", () => {
    const plan = planRegistration({ ...base, scope: "global", client: "claude-code" });
    expect(plan.file).toBeUndefined();
    expect(plan.command).toBe("claude mcp add --scope user -e P_API_KEY=… petstore -- node /x/dist/index.js");
  });

  it("refuses to clobber invalid JSON", () => {
    const broken = mkdtempSync(join(tmpdir(), "make-mcp-reg-broken-"));
    writeFileSync(join(broken, ".mcp.json"), "{ nope");
    expect(() => planRegistration({ ...base, workspaceRoot: broken, scope: "project", client: "claude-code" })).toThrow(/not valid JSON/);
  });
});

describe("hostPath", () => {
  it("maps container paths below the workspace to the host mount", () => {
    process.env.MAKE_MCP_HOST_WORKSPACE = "/Users/me/shop";
    try {
      expect(hostPath("/workspace/mcp-servers/x-mcp/dist/index.js", "/workspace")).toBe("/Users/me/shop/mcp-servers/x-mcp/dist/index.js");
      expect(hostPath("/tmp/elsewhere", "/workspace")).toBe("/tmp/elsewhere");
    } finally {
      delete process.env.MAKE_MCP_HOST_WORKSPACE;
    }
    expect(hostPath("/workspace/a", "/workspace")).toBe("/workspace/a");
  });
});

describe("Cloud Run deployment templates", async () => {
  const findings = await detectContext({
    target: "https://petstore3.example.com/openapi.yaml",
    workspaceRoot: fixtures("workspaces/empty"),
    apiFetcher,
    contentFetcher,
  });
  const resolved = resolveIntake(findings, { language: "ts", register: "none", transport: "http", outDir: join(e2eRoot, "petstore-http-mcp") });
  const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now });
  writeProject(project);

  it("adds a Knative service with Secret Manager references and a Skaffold config", () => {
    expect(resolved.deploy).toBe("cloudrun");
    const service = parseYaml(project.files["deploy/cloudrun/service.yaml"]!);
    expect(service).toMatchObject({ apiVersion: "serving.knative.dev/v1", kind: "Service", metadata: { name: "swagger-petstore-mcp" } });
    const container = service.spec.template.spec.containers[0];
    expect(container.env.map((e: { name: string; valueFrom: { secretKeyRef: { name: string } } }) => `${e.name}=${e.valueFrom.secretKeyRef.name}`)).toEqual([
      "MCP_AUTH_TOKEN=swagger-petstore-mcp-auth-token",
      "SWAGGER_PETSTORE_ACCESS_TOKEN=swagger-petstore-mcp-swagger-petstore-access-token",
      "SWAGGER_PETSTORE_API_KEY=swagger-petstore-mcp-swagger-petstore-api-key",
    ]);
    expect(service.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"]).toBe("0");
    expect(parseYaml(project.files["skaffold.yaml"]!)).toMatchObject({ manifests: { rawYaml: ["deploy/cloudrun/service.yaml"] }, deploy: { cloudrun: {} } });
    expect(project.files["README.md"]).toContain("## Deploy to Google Cloud Run");
    expect(project.files["README.md"]).toContain("--set-secrets MCP_AUTH_TOKEN=swagger-petstore-mcp-auth-token:latest,SWAGGER_PETSTORE_ACCESS_TOKEN=");
  });

  it("refuses to listen publicly without MCP_AUTH_TOKEN", () => {
    const result = spawnSync(process.execPath, [join(project.outDir, "src/index.ts")], {
      env: { ...process.env, MCP_TRANSPORT: "http", HOST: "0.0.0.0", PORT: "0", MCP_AUTH_TOKEN: "" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to listen on 0.0.0.0 without MCP_AUTH_TOKEN");
  });

  it("has no deployment files for stdio servers", async () => {
    const stdio = resolveIntake(findings, { language: "ts", register: "none", outDir: join(e2eRoot, "petstore-stdio-mcp") });
    expect(stdio.deploy).toBe("none");
    const files = (await generateProject(stdio, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now })).files;
    expect(Object.keys(files)).not.toContain("skaffold.yaml");
  });
});

describe("Dockerfile for docs that must not be redistributed", async () => {
  const findings = await detectContext({ target: "daisyUI", workspaceRoot: fixtures("workspaces/daisyui"), apiFetcher, contentFetcher });
  const resolved = { ...resolveIntake(findings, { mode: "docs", register: "none", outDir: join(e2eRoot, "daisyui-restricted-mcp") }), license: "LicenseRef-Proprietary" };

  it.each(["ts", "py"] as const)("downloads the docs while building the %s image", async (language) => {
    const project = await generateProject({ ...resolved, language }, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now });
    expect(project.manifest.docs?.contentMode).toBe("fetch-on-install");
    expect(project.files["data/corpus.json"]).toBeUndefined();
    expect(project.files.Dockerfile).toContain("refresh .");
    expect(project.files.Dockerfile).toContain("Keep the image in a private registry");
  });
});

describe("generated HTTP server without a token", async () => {
  const findings = await detectContext({ target: "daisyUI", workspaceRoot: fixtures("workspaces/daisyui"), apiFetcher, contentFetcher });
  const resolved = resolveIntake(findings, { mode: "docs", register: "none", outDir: join(e2eRoot, "daisyui-http-mcp") });
  const project = await generateProject(resolved, { apiFetcher, contentFetcher, workspaceRoot: e2eRoot, now });
  writeProject(project);

  it("only answers local callers (no DNS rebinding from web pages)", { timeout: 30_000 }, async () => {
    const port = 41_000 + Math.floor(Math.random() * 1000);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [join(project.outDir, "src/index.ts")], {
      env: { ...process.env, MCP_TRANSPORT: "http", PORT: String(port), HOST: "127.0.0.1", MCP_AUTH_TOKEN: "" },
      stdio: "ignore",
    });
    try {
      for (let i = 0; i < 50; i++) {
        if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const post = (headers: Record<string, string>) =>
        new Promise<number>((done) => {
          const req = request(
            { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
            (res) => {
              res.resume();
              done(res.statusCode ?? 0);
            },
          );
          req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
        });
      expect(await post({ host: "attacker.example:" + port })).toBe(401);
      expect(await post({ host: `127.0.0.1:${port}`, origin: "https://attacker.example" })).toBe(401);
      expect(await post({ host: `localhost:${port}` })).toBe(200);
    } finally {
      child.kill();
    }
  });
});


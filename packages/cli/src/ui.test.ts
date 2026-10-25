import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFetchers } from "@make-mcp/core";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { startUi } from "./ui.js";

const fixtures = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
// Inside the repo so a generated server could resolve its dependencies from the root node_modules.
const workspace = mkdtempSync(join(fileURLToPath(new URL("../", import.meta.url)), ".e2e-ws-"));
cpSync(fixtures("workspaces/daisyui"), workspace, { recursive: true });

const ui = await startUi({ fetchers: createFetchers({ fixturesDir: fixtures("http") }), workspace, port: 0, token: "t".repeat(48) });
const base = ui.url.split("#")[0]!;

afterAll(async () => {
  await ui.close();
  rmSync(workspace, { recursive: true, force: true });
});

const api = (name: string, body: unknown = {}, headers: Record<string, string> = { "x-make-mcp-token": ui.token }) =>
  fetch(`${base}api/${name}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("make-mcp ui", () => {
  it("serves the page with a strict CSP and puts the token in the fragment", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain("make-mcp");
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=t{48}$/);
  });

  it("rejects calls without the token or from another origin", async () => {
    expect((await api("info", {}, {})).status).toBe(401);
    expect((await api("info", {}, { "x-make-mcp-token": "x".repeat(48) })).status).toBe(401);
    expect((await api("info", {}, { "x-make-mcp-token": ui.token, origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${base}api/zip?session=x`)).status).toBe(401);
    expect((await api("nope")).status).toBe(404);
  });

  it("runs the intake and generates a downloadable server", async () => {
    const info = await (await api("info")).json();
    expect(info).toMatchObject({ workspace, container: false });

    const detected = await (await api("detect", { target: "daisyUI" })).json();
    expect(detected.findings.version.value).toBe("5.7.50");
    expect(detected.questions.map((q: { id: string }) => q.id)).toEqual(["bundle"]);

    const answered = await (await api("answer", { sessionId: detected.sessionId, answers: { bundle: "single", mode: "docs", register: "none" } })).json();
    expect(answered.ready).toBe(true);

    const plan = await (await api("preview", { sessionId: detected.sessionId })).json();
    expect(plan).toMatchObject({ needsExtraction: false });
    expect(plan.summary).toContain("daisyUI 5.7.50");

    const generated = await (await api("generate", { sessionId: detected.sessionId })).json();
    expect(generated.tools).toEqual(["search_docs", "get_page", "list_topics", "get_component"]);

    const zip = await fetch(`${base}api/zip?session=${detected.sessionId}&t=${ui.token}`);
    expect(zip.headers.get("content-disposition")).toContain("daisyui-mcp.zip");
    expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer())))).toContain("daisyui-mcp/data/corpus.json");
  });

  it("rejects answers that are not strings", async () => {
    const detected = await (await api("detect", { target: "daisyUI" })).json();
    const res = await api("answer", { sessionId: detected.sessionId, answers: { mode: 1 } });
    expect(res.status).toBe(400);
  });

  it("explains errors as JSON", async () => {
    const res = await api("preview", { sessionId: "unknown" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "SESSION_NOT_FOUND" });
  });
});

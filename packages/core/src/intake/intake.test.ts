import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applySourceAnswers, detectContext, refineFindings } from "../discover/detect.js";
import { isMakeMcpError } from "../errors.js";
import { createFixtureFetch } from "../fetch/fixture-fetch.js";
import { createPoliteFetch } from "../fetch/polite-fetch.js";
import { nextQuestions, normalizeAnswers } from "./questions.js";
import { resolveIntake, summarizeIntake } from "./resolve.js";

const fixtures = (path: string) => fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url));
const apiFetcher = createFixtureFetch(fixtures("http"));
const contentFetcher = createPoliteFetch(apiFetcher, { delayMs: 0 });

describe("daisyUI in a workspace", async () => {
  const findings = await detectContext({ target: "daisyUI", workspaceRoot: fixtures("workspaces/daisyui"), apiFetcher, contentFetcher });

  it("detects package, exact version, license, repo tag and llms.txt", () => {
    expect(findings.packageName).toBe("daisyui");
    expect(findings.version).toEqual({ value: "5.7.50", confidence: "high", source: "package-lock.json" });
    expect(findings.license?.value).toBe("MIT");
    expect(findings.repositoryUrl?.value).toBe("https://github.com/saadeghi/daisyui");
    expect(findings.repoTag).toBe("v5.7.50");
    expect(findings.docsCandidates.map((d) => d.kind)).toEqual(["llms-txt", "repo-docs", "website", "readme"]);
    expect(findings.notes).toEqual([]);
  });

  it("asks only about purpose and registration", () => {
    expect(nextQuestions(findings, {}).map((q) => q.id)).toEqual(["bundle"]);
    expect(nextQuestions(findings, { bundle: "single" }).map((q) => q.id)).toEqual(["mode", "register"]);
  });

  it("accepts option labels and resolves", () => {
    const answers = normalizeAnswers(findings, {}, { bundle: "Only daisyUI", mode: "Look up knowledge", register: "This project" });
    expect(answers).toEqual({ bundle: "single", mode: "docs", register: "project" });
    expect(nextQuestions(findings, answers)).toEqual([]);
    const resolved = resolveIntake(findings, answers);
    expect(resolved).toMatchObject({
      slug: "daisyui",
      envPrefix: "DAISYUI",
      mode: "docs",
      version: "5.7.50",
      license: "MIT",
      language: "ts",
      outDir: "mcp-servers/daisyui-mcp",
    });
    expect(summarizeIntake(resolved)).toContain("embedded in the server");
  });

  it("refuses to resolve while questions are open", () => {
    let caught: unknown;
    try {
      resolveIntake(findings, {});
    } catch (err) {
      caught = err;
    }
    expect(isMakeMcpError(caught, "INTAKE_INCOMPLETE")).toBe(true);
  });

  it("moves version-exact repo docs first when llms.txt describes another major", async () => {
    const v4 = await detectContext({ target: "daisyui", workspaceRoot: fixtures("workspaces/empty"), apiFetcher, contentFetcher });
    const refined = { ...v4, version: { value: "4.12.24", confidence: "high" as const, source: "test" } };
    expect(refined.docsCandidates[0]?.kind).toBe("llms-txt");
    const withCode = await applySourceAnswers(refined, { codeSource: "https://github.com/saadeghi/daisyui" }, { apiFetcher, contentFetcher });
    expect(withCode.repoTag).toBe("v4.12.24");
  });
});

describe("Petstore by URL in an empty workspace", async () => {
  const findings = await detectContext({
    target: "https://petstore3.example.com/openapi.yaml",
    workspaceRoot: fixtures("workspaces/empty"),
    apiFetcher,
    contentFetcher,
  });

  it("recognizes the OpenAPI spec", () => {
    expect(findings.slug).toBe("swagger-petstore");
    expect(findings.mode).toMatchObject({ value: "api", confidence: "high" });
    expect(findings.openapi).toMatchObject({ endpointCount: 6, authTypes: ["oauth2", "apiKey"] });
  });

  it("asks for language and registration only", () => {
    expect(nextQuestions(findings, {}).map((q) => q.id)).toEqual(["language", "register"]);
  });

  it("resolves non-interactively with defaults", () => {
    const resolved = resolveIntake(findings, {}, { useDefaults: true });
    expect(resolved).toMatchObject({ mode: "api", language: "ts", register: "project", openapiUrl: "https://petstore3.example.com/openapi.yaml" });
  });
});

describe("unknown target without sources", async () => {
  const findings = await detectContext({ target: "internal-billing", workspaceRoot: fixtures("workspaces/empty"), apiFetcher, contentFetcher });

  it("asks where docs and code live", () => {
    expect(nextQuestions(findings, {}).map((q) => q.id)).toEqual(["docsSource", "codeSource", "version", "mode"]);
  });

  it("uses a local code path as docs source", async () => {
    const refined = await applySourceAnswers(findings, { codeSource: fixtures("workspaces/daisyui") }, { apiFetcher, contentFetcher });
    expect(refined.docsCandidates[0]?.kind).toBe("local-docs");
  });
});

describe("whole-project server", async () => {
  const workspaceRoot = fixtures("workspaces/project");
  const findings = await detectContext({ target: "daisyUI", workspaceRoot, apiFetcher, contentFetcher });

  it("offers the other dependencies, without build tooling", () => {
    expect(findings.projectDeps).toEqual([
      { name: "@acme/internal", registry: "npm" },
      { name: "acme-ui", registry: "npm" },
    ]);
    expect(findings.projectName).toBe("acme-app");
    const [bundle] = nextQuestions(findings, {});
    expect(bundle).toMatchObject({ id: "bundle", default: "single", allowFreeText: true });
    expect(bundle!.options[1]!.description).toContain("daisyui, @acme/internal, acme-ui");
  });

  it("detects every library after the answer and skips per-target questions", async () => {
    const answers = normalizeAnswers(findings, {}, { bundle: "Whole project" });
    const refined = await refineFindings(findings, answers, ["bundle"], { apiFetcher, contentFetcher });
    expect(refined.members?.map((m) => [m.target, m.version?.value])).toEqual([
      ["daisyUI", "5.7.50"],
      ["acme-ui", "2.0.0"],
    ]);
    expect(nextQuestions(refined, answers).map((q) => q.id)).toEqual(["register"]);
    // The private workspace package ("workspace:*") has no docs and is left out with a note instead of failing.
    expect(refined.notes).toContain("@acme/internal: no documentation found – left out of the project server.");
    const resolved = resolveIntake(refined, { ...answers, register: "none" });
    expect(resolved).toMatchObject({ slug: "acme-app-libs", mode: "docs", outDir: "mcp-servers/acme-app-libs-mcp", target: "acme-app libraries" });
    expect(resolved.libraries?.map((l) => [l.name, l.version, l.license])).toEqual([
      ["daisyui", "5.7.50", "MIT"],
      ["acme-ui", "2.0.0", "MIT"],
    ]);
    expect(summarizeIntake(resolved)).toContain("one docs server for 2 libraries");
  });

  it("goes back to a single server when the answer changes", async () => {
    const answers = normalizeAnswers(findings, {}, { bundle: "project" });
    const refined = await refineFindings(findings, answers, ["bundle"], { apiFetcher, contentFetcher });
    const single = await refineFindings(refined, { bundle: "single" }, ["bundle"], { apiFetcher, contentFetcher });
    expect(single.members).toBeUndefined();
  });

  it("starts with the whole project for target \".\"", async () => {
    const project = await detectContext({ target: ".", workspaceRoot, apiFetcher, contentFetcher });
    expect(project.bundle?.value).toBe("project");
    // The first dependency is a private workspace package; the first published library becomes the target.
    expect(project.packageName).toBe("acme-ui");
    expect(project.projectDeps?.map((d) => d.name)).toEqual(["@acme/internal", "daisyui"]);
    expect(nextQuestions(project, {}).map((q) => q.id)).toEqual(["register"]);
  });

  it("refuses a resolve before the libraries are detected", () => {
    let caught: unknown;
    try {
      resolveIntake(findings, { bundle: "project", register: "none" });
    } catch (err) {
      caught = err;
    }
    expect(isMakeMcpError(caught, "INTAKE_INCOMPLETE")).toBe(true);
  });
});

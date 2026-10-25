import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogAnswers, catalogName, CatalogEntrySchema, fetchCatalogIndex, searchCatalog } from "./catalog.js";
import { detectContext } from "./discover/detect.js";
import { isMakeMcpError } from "./errors.js";
import { createFixtureFetch } from "./fetch/fixture-fetch.js";
import { createPoliteFetch } from "./fetch/polite-fetch.js";
import { nextQuestions } from "./intake/questions.js";
import { resolveIntake } from "./intake/resolve.js";

const fixtures = (path: string) => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const apiFetcher = createFixtureFetch(fixtures("http"));
const contentFetcher = createPoliteFetch(apiFetcher, { delayMs: 0 });
const workspaceRoot = fixtures("workspaces/empty");

describe("catalog entries", () => {
  it("validates names and only accepts intake answers that make sense to share", () => {
    const base = { name: "x", title: "X", description: "d", target: "x", maintainers: ["me"] };
    expect(CatalogEntrySchema.parse(base)).toMatchObject({ tags: [], answers: {} });
    expect(CatalogEntrySchema.safeParse({ ...base, name: "Bad Name" }).success).toBe(false);
    expect(CatalogEntrySchema.safeParse({ ...base, maintainers: [] }).success).toBe(false);
    // Paths on someone's machine and registration choices are personal, not catalog data.
    expect(CatalogEntrySchema.parse({ ...base, answers: { outDir: "/home/x", register: "global", mode: "docs" } }).answers).toEqual({ mode: "docs" });
  });

  it("recognises explicit references", () => {
    expect(catalogName("catalog:daisyui")).toBe("daisyui");
    expect(catalogName("daisyui")).toBeUndefined();
  });

  it("searches the index by name, description and tags", async () => {
    const index = (await fetchCatalogIndex(apiFetcher))!;
    expect(searchCatalog(index, "css").map((e) => e.name)).toEqual(["daisyui"]);
    expect(searchCatalog(index, "").length).toBe(2);
  });
});

describe("detectContext with the catalog", () => {
  it("applies an entry's sources and mode, while the user keeps the last word", async () => {
    const findings = await detectContext({ target: "catalog:notes", workspaceRoot, apiFetcher, contentFetcher });
    expect(findings.catalog?.name).toBe("notes");
    expect(findings.target).toBe("Acme Notes");
    expect(findings.mode).toEqual({ value: "api", confidence: "high", source: "community catalog" });
    expect(findings.docsCandidates[0]?.kind).toBe("llms-full-txt");
    expect(findings.notes).toContain("The base URL is stated in the docs; set NOTES_API_KEY.");

    const answers = catalogAnswers(findings, { register: "none" });
    expect(answers).toMatchObject({ mode: "api", docsSource: "extract", auth: "none", register: "none" });
    expect(nextQuestions(findings, answers).map((q) => q.id)).toEqual(["version"]);
    expect(resolveIntake(findings, { ...answers, version: "latest" })).toMatchObject({ apiSource: "docs", language: "ts" });
    expect(catalogAnswers(findings, { mode: "both" }).mode).toBe("both");
  });

  it("looks up plain names too and ignores missing entries", async () => {
    expect((await detectContext({ target: "notes", workspaceRoot, apiFetcher, contentFetcher })).catalog?.name).toBe("notes");
    expect((await detectContext({ target: "daisyUI", workspaceRoot: fixtures("workspaces/daisyui"), apiFetcher, contentFetcher })).catalog).toBeUndefined();
  });

  it("fails clearly for an unknown explicit entry", async () => {
    const err = await detectContext({ target: "catalog:nope", workspaceRoot, apiFetcher, contentFetcher }).catch((e: unknown) => e);
    expect(isMakeMcpError(err, "SOURCE_NOT_FOUND")).toBe(true);
  });
});

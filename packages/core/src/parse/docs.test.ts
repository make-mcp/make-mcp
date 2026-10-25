import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Fetcher } from "../fetch/types.js";
import { loadDocCorpus } from "./docs-corpus.js";
import { parseLlmsTxt } from "./llms-txt.js";
import { splitMarkdown } from "./markdown-split.js";
import { isRepoDocFile, matchVersionTag, parseRepoUrl } from "./repo-docs.js";

const daisyLlms = readFileSync(new URL("../../../../fixtures/http/files/daisyui-llms.txt", import.meta.url), "utf8");

function stub(routes: Record<string, { body: string; contentType?: string }>): Fetcher {
  return async (url) => {
    const route = routes[url];
    return {
      url,
      status: route ? 200 : 404,
      ok: !!route,
      contentType: route?.contentType ?? "text/plain",
      headers: {},
      body: route?.body ?? "",
    };
  };
}

describe("parseLlmsTxt", () => {
  it("recognizes daisyUI's full-content llms.txt and its declared version", () => {
    const parsed = parseLlmsTxt(daisyLlms, "https://daisyui.com/llms.txt");
    expect(parsed.isIndex).toBe(false);
    expect(parsed.declaredVersion).toBe("5.7.x");
    expect(parsed.title).toBe("daisyUI 5");
  });

  it("recognizes the llmstxt.org index format", () => {
    const parsed = parseLlmsTxt(
      "# Lib\n\n> Summary\n\n## Docs\n\n- [Install](/docs/install.md): setup\n- [Button](/docs/button.md)\n- [Card](https://lib.dev/docs/card.md)\n",
      "https://lib.dev/llms.txt",
    );
    expect(parsed.isIndex).toBe(true);
    expect(parsed.links[0]).toEqual({ title: "Install", url: "https://lib.dev/docs/install.md", description: "setup", section: "Docs" });
  });
});

describe("splitMarkdown", () => {
  const pages = splitMarkdown(daisyLlms, { sourceUrl: "https://daisyui.com/llms.txt" });

  it("splits the component section into component pages", () => {
    const button = pages.find((p) => p.path === "components/button");
    expect(button?.kind).toBe("component");
    expect(button?.title).toBe("Button");
    expect(button?.section).toBe("daisyUI components");
    expect(button?.markdown).toContain("btn");
    expect(pages.filter((p) => p.kind === "component").map((p) => p.title)).toEqual(
      expect.arrayContaining(["Accordion", "Alert", "Calendar", "Card"]),
    );
  });

  it("keeps regular sections as pages and ignores headings inside code fences", () => {
    expect(pages.find((p) => p.path === "overview")?.title).toBe("daisyUI 5");
    expect(pages.some((p) => p.path === "daisyui-5-colors/daisyui-color-names")).toBe(true);
    const paths = pages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("loadDocCorpus", () => {
  it("falls back to the next source and records provenance", async () => {
    const fetcher = stub({ "https://daisyui.com/llms.txt": { body: daisyLlms } });
    const corpus = await loadDocCorpus(
      [
        { kind: "llms-full-txt", url: "https://daisyui.com/llms-full.txt" },
        { kind: "llms-txt", url: "https://daisyui.com/llms.txt" },
      ],
      { contentFetcher: fetcher, apiFetcher: fetcher, title: "daisyUI", version: "5.7.50", license: "MIT", now: () => new Date("2026-10-25T00:00:00Z") },
    );
    expect(corpus.pages.length).toBeGreaterThan(10);
    expect(corpus.sources).toEqual([
      { kind: "llms-txt", url: "https://daisyui.com/llms.txt", fetchedAt: "2026-10-25T00:00:00.000Z", ref: "5.7.x" },
    ]);
  });

  it("follows links of an index-style llms.txt", async () => {
    const fetcher = stub({
      "https://lib.dev/llms.txt": { body: "# Lib\n## Components\n- [Button](https://lib.dev/button.md)\n- [Card](https://lib.dev/card.md)\n- [Modal](https://lib.dev/modal.md)\n" },
      "https://lib.dev/button.md": { body: "# Button\nUse `btn`." },
      "https://lib.dev/card.md": { body: "<html><main><h1>Card</h1><p>Use card.</p></main></html>", contentType: "text/html" },
    });
    const corpus = await loadDocCorpus([{ kind: "llms-txt", url: "https://lib.dev/llms.txt" }], {
      contentFetcher: fetcher,
      apiFetcher: fetcher,
      title: "Lib",
    });
    expect(corpus.pages.map((p) => [p.path, p.kind])).toEqual([
      ["components/button", "component"],
      ["components/card", "component"],
    ]);
    expect(corpus.pages[1]?.markdown).toContain("# Card");
  });
});

describe("repo helpers", () => {
  it.each([
    ["git+https://github.com/saadeghi/daisyui.git", { host: "github", owner: "saadeghi", repo: "daisyui" }],
    ["https://github.com/org/repo/tree/main/packages/x", { host: "github", owner: "org", repo: "repo" }],
    ["github:org/repo", { host: "github", owner: "org", repo: "repo" }],
    ["https://gitlab.com/org/repo", undefined],
  ])("parseRepoUrl(%s)", (input, expected) => {
    expect(parseRepoUrl(input)).toEqual(expected);
  });

  it("matches version tags", () => {
    expect(matchVersionTag("5.0.43", ["v5.0.43", "v5.0.42"])).toBe("v5.0.43");
    expect(matchVersionTag("1.2.0", ["pkg@1.2.0"], "pkg")).toBe("pkg@1.2.0");
    expect(matchVersionTag("9.9.9", ["v1.0.0"])).toBeUndefined();
  });

  it.each([
    ["packages/docs/src/routes/(routes)/components/button/+page.md", true],
    ["README.md", true],
    ["docs/CHANGELOG.md", false],
    ["src/index.ts", false],
    ["node_modules/docs/x.md", false],
  ])("isRepoDocFile(%s) = %s", (path, expected) => {
    expect(isRepoDocFile(path)).toBe(expected);
  });
});

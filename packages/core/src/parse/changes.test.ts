import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFixtureFetch } from "../fetch/fixture-fetch.js";
import { compareVersions, loadChanges, loadChangesResult, parseChangelog, tagVersion } from "./changes.js";

const fetcher = createFixtureFetch(fileURLToPath(new URL("../../../../fixtures/http", import.meta.url)));

describe("release tags", () => {
  it("reads plain and package-prefixed tags", () => {
    expect(tagVersion("v1.2.3")).toEqual({ version: "1.2.3", prefixed: false });
    expect(tagVersion("2.0")).toEqual({ version: "2.0", prefixed: false });
    expect(tagVersion("svelte@5.1.0", "svelte")).toEqual({ version: "5.1.0", prefixed: true });
    expect(tagVersion("@sveltejs/kit@2.8.0", "@sveltejs/kit")).toEqual({ version: "2.8.0", prefixed: true });
    expect(tagVersion("kit-v2.8.0", "@sveltejs/kit")).toEqual({ version: "2.8.0", prefixed: true });
    expect(tagVersion("other@1.0.0", "svelte")).toBeUndefined();
    expect(tagVersion("nightly")).toBeUndefined();
  });

  it("orders versions semantically", () => {
    expect(["2.10.0", "2.9.1", "2.10.0-rc.1", "10.0"].sort(compareVersions)).toEqual(["2.9.1", "2.10.0-rc.1", "2.10.0", "10.0"]);
    expect(compareVersions("1.2.3.10", "1.2.3.9")).toBeGreaterThan(0);
  });
});

describe("CHANGELOG files", () => {
  it("splits at the version heading level and keeps dates", () => {
    const entries = parseChangelog(
      [
        "# Changelog",
        "## [2.1.0] - 2026-06-01",
        "### Added",
        "- ghost variant",
        "### 2.1 migration notes",
        "nothing to do",
        "## 2.0.0",
        "- renamed tokens",
        "",
        "[2.1.0]: https://github.com/acme/acme-ui/compare/v2.0.0...v2.1.0",
        "[2.0.0]: https://github.com/acme/acme-ui/releases/tag/v2.0.0",
      ].join("\n"),
      "https://github.com/acme/acme-ui/blob/HEAD/CHANGELOG.md",
    );
    expect(entries.map((e) => [e.version, e.date])).toEqual([
      ["2.1.0", "2026-06-01"],
      ["2.0.0", undefined],
    ]);
    expect(entries[0]!.markdown).toContain("2.1 migration notes");
    expect(entries[1]!.markdown).toBe("- renamed tokens");
  });
});

describe("loadChanges", () => {
  it("uses GitHub releases: no drafts, no pre-releases, oldest first", async () => {
    const entries = await loadChanges({ host: "github", owner: "acme", repo: "acme-ui" }, "acme-ui", fetcher, { version: "2.0.0" });
    expect(entries.map((e) => e.version)).toEqual(["1.9.0", "2.0.0", "2.1.0", "3.0.0"]);
    expect(entries[2]).toMatchObject({ title: "Ghost buttons", date: "2026-06-01", sourceUrl: "https://github.com/acme/acme-ui/releases/tag/v2.1.0" });
  });

  it("keeps pre-releases for a pre-release target and returns [] without data", async () => {
    const pre = await loadChanges({ host: "github", owner: "acme", repo: "acme-ui" }, "acme-ui", fetcher, { version: "2.1.0-beta.1" });
    expect(pre.map((e) => e.version)).toContain("2.1.0-beta.1");
    expect(await loadChanges({ host: "github", owner: "nobody", repo: "nothing" }, undefined, fetcher)).toEqual([]);
  });

  it("reports a GitHub rate limit instead of silently returning nothing", async () => {
    const limited = await loadChangesResult({ host: "github", owner: "limited", repo: "lib" }, "lib", fetcher);
    expect(limited).toEqual({ entries: [], rateLimited: true });
  });
});

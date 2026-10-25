import { describe, expect, it } from "vitest";
import { isMakeMcpError } from "../errors.js";
import { createPoliteFetch } from "./polite-fetch.js";
import { parseRobots } from "./robots.js";
import type { Fetcher, FetchResult } from "./types.js";

function stubFetcher(routes: Record<string, Partial<FetchResult>>): Fetcher {
  return async (url) => {
    const route = routes[url];
    const status = route?.status ?? (route ? 200 : 404);
    return {
      url,
      status,
      ok: status < 300,
      contentType: "text/plain",
      headers: route?.headers ?? {},
      body: route?.body ?? "",
    };
  };
}

describe("parseRobots", () => {
  const robots = parseRobots(
    [
      "User-agent: AhrefsBot",
      "Disallow: /",
      "",
      "User-agent: *",
      "Disallow: /private/",
      "Allow: /private/public",
      "Disallow: /*.pdf$",
    ].join("\n"),
  );

  it.each([
    ["/docs/button", true],
    ["/private/x", false],
    ["/private/public/y", true],
    ["/file.pdf", false],
    ["/file.pdf?x=1", true],
  ])("%s allowed=%s", (path, expected) => {
    expect(robots.isAllowed(path)).toBe(expected);
  });

  it("prefers the group for our product token", () => {
    const policy = parseRobots("User-agent: make-mcp\nDisallow: /\n\nUser-agent: *\nAllow: /");
    expect(policy.isAllowed("/docs")).toBe(false);
  });
});

describe("createPoliteFetch", () => {
  it("refuses robots-disallowed paths", async () => {
    const fetcher = createPoliteFetch(
      stubFetcher({ "https://ex.com/robots.txt": { body: "User-agent: *\nDisallow: /secret" } }),
      { delayMs: 0 },
    );
    await expect(fetcher("https://ex.com/secret/a")).rejects.toSatisfy((e) => isMakeMcpError(e, "ROBOTS_DISALLOWED"));
  });

  it("honours tdmrep.json and the tdm-reservation header", async () => {
    const fetcher = createPoliteFetch(
      stubFetcher({
        "https://ex.com/.well-known/tdmrep.json": { body: '[{"location":"/books/*","tdm-reservation":1}]' },
        "https://ex.com/books/a": { body: "x" },
        "https://ex.com/news": { body: "x", headers: { "tdm-reservation": "1" } },
        "https://ex.com/docs": { body: "ok" },
      }),
      { delayMs: 0 },
    );
    await expect(fetcher("https://ex.com/books/a")).rejects.toSatisfy((e) => isMakeMcpError(e, "ROBOTS_DISALLOWED"));
    await expect(fetcher("https://ex.com/news")).rejects.toSatisfy((e) => isMakeMcpError(e, "ROBOTS_DISALLOWED"));
    expect((await fetcher("https://ex.com/docs")).body).toBe("ok");
  });
});

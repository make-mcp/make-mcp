import { isMakeMcpError } from "../errors.js";
import type { Fetcher } from "../fetch/types.js";
import type { DocPage } from "../ir/index.js";
import { extractLinks, htmlTitle, htmlToMarkdown } from "./html.js";
import { slugify } from "./markdown-split.js";

export interface CrawlOptions {
  fetcher: Fetcher;
  maxPages?: number;
  maxDepth?: number;
}

function scopePrefix(start: URL): string {
  return start.pathname.endsWith("/") ? start.pathname : start.pathname.replace(/[^/]*$/, "");
}

function inScope(url: URL, start: URL, prefix: string): boolean {
  return url.origin === start.origin && url.pathname.startsWith(prefix) && !/\.(png|jpe?g|gif|svg|pdf|zip|css|js)$/i.test(url.pathname);
}

async function sitemapUrls(start: URL, prefix: string, fetcher: Fetcher): Promise<string[]> {
  try {
    const res = await fetcher(`${start.origin}/sitemap.xml`, { accept: "application/xml,text/xml" });
    if (!res.ok) return [];
    return [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
      .map((m) => m[1] ?? "")
      .filter((u) => {
        try {
          return inScope(new URL(u), start, prefix);
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function pagePath(url: URL, prefix: string): string {
  const rel = url.pathname.slice(prefix.length).replace(/\/$/, "").replace(/\.html?$/, "");
  return rel ? rel.split("/").map(slugify).join("/") : "index";
}

/**
 * Same-origin crawl below the start URL's directory. Prefers the sitemap,
 * falls back to breadth-first link following. Pages blocked by robots/TDM are skipped.
 */
export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<DocPage[]> {
  const maxPages = options.maxPages ?? 50;
  const maxDepth = options.maxDepth ?? 2;
  const start = new URL(startUrl);
  const prefix = scopePrefix(start);
  const pages: DocPage[] = [];
  const seen = new Set<string>();

  const fromSitemap = await sitemapUrls(start, prefix, options.fetcher);
  const queue: { url: string; depth: number }[] = [
    { url: start.href, depth: 0 },
    ...fromSitemap.map((url) => ({ url, depth: maxDepth })),
  ];

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);

    let res;
    try {
      res = await options.fetcher(next.url, { accept: "text/html" });
    } catch (err) {
      if (isMakeMcpError(err, "ROBOTS_DISALLOWED") || isMakeMcpError(err, "FETCH_FAILED")) continue;
      throw err;
    }
    if (!res.ok || !res.contentType.includes("html")) continue;

    const url = new URL(res.url);
    const markdown = htmlToMarkdown(res.body);
    if (markdown.length >= 100) {
      pages.push({
        path: pagePath(url, prefix),
        title: htmlTitle(res.body) ?? url.pathname,
        kind: /\/components?\//.test(url.pathname) ? "component" : "page",
        markdown,
        sourceUrl: url.href,
      });
    }

    if (next.depth < maxDepth) {
      for (const link of extractLinks(res.body, url.href)) {
        const linkUrl = new URL(link);
        if (inScope(linkUrl, start, prefix) && !seen.has(linkUrl.href)) queue.push({ url: linkUrl.href, depth: next.depth + 1 });
      }
    }
  }

  const usedPaths = new Set<string>();
  return pages.map((page) => {
    let path = page.path;
    for (let i = 2; usedPaths.has(path); i++) path = `${page.path}-${i}`;
    usedPaths.add(path);
    return { ...page, path };
  });
}

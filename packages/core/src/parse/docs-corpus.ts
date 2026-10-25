import { isMakeMcpError } from "../errors.js";
import type { Fetcher } from "../fetch/types.js";
import type { DocCorpus, DocPage, SourceKind, SourceRef } from "../ir/index.js";
import { crawlSite } from "./html-crawler.js";
import { htmlTitle, htmlToMarkdown } from "./html.js";
import { parseLlmsTxt } from "./llms-txt.js";
import { slugify, splitMarkdown } from "./markdown-split.js";
import { loadLocalDocs } from "./local-docs.js";
import { loadRepoDocs, parseRepoUrl } from "./repo-docs.js";

export interface DocsSource {
  kind: Extract<SourceKind, "llms-txt" | "llms-full-txt" | "website" | "repo-docs" | "local-docs" | "readme">;
  url: string;
  /** Git ref for repo-docs. */
  ref?: string;
}

export interface LoadCorpusOptions {
  /** Polite fetcher (robots/TDM) for website content. */
  contentFetcher: Fetcher;
  /** Plain fetcher for APIs such as GitHub. */
  apiFetcher: Fetcher;
  title: string;
  version?: string;
  license?: string;
  maxPages?: number;
  now?: () => Date;
}

async function loadLinkedPages(
  links: { title: string; url: string; section?: string }[],
  options: LoadCorpusOptions,
  maxPages: number,
): Promise<DocPage[]> {
  const pages: DocPage[] = [];
  for (const link of links.slice(0, maxPages)) {
    let res;
    try {
      res = await options.contentFetcher(link.url, { accept: "text/markdown,text/plain,text/html;q=0.8" });
    } catch (err) {
      if (isMakeMcpError(err, "ROBOTS_DISALLOWED") || isMakeMcpError(err, "FETCH_FAILED")) continue;
      throw err;
    }
    if (!res.ok) continue;
    const isHtml = res.contentType.includes("html");
    const markdown = isHtml ? htmlToMarkdown(res.body) : res.body.trim();
    if (!markdown) continue;
    const section = link.section ? slugify(link.section) : undefined;
    pages.push({
      path: section ? `${section}/${slugify(link.title)}` : slugify(link.title),
      title: (isHtml ? htmlTitle(res.body) : undefined) ?? link.title,
      ...(link.section ? { section: link.section } : {}),
      kind: /component/i.test(link.section ?? "") ? "component" : "page",
      markdown,
      sourceUrl: res.url,
    });
  }
  return pages;
}

function dedupePaths(pages: DocPage[]): DocPage[] {
  const used = new Set<string>();
  return pages.map((page) => {
    let path = page.path;
    for (let i = 2; used.has(path); i++) path = `${page.path}-${i}`;
    used.add(path);
    return { ...page, path };
  });
}

/** One downloaded file split into sections costs no extra requests, so it may hold far more pages than a crawl. */
const MAX_SPLIT_PAGES = 5000;

/** Loads documentation from the first source that yields pages; later sources are fallbacks. */
export async function loadDocCorpus(sources: DocsSource[], options: LoadCorpusOptions): Promise<DocCorpus> {
  const maxPages = options.maxPages ?? 200;
  const now = (options.now ?? (() => new Date()))().toISOString();

  for (const source of sources) {
    let pages: DocPage[] = [];
    let ref = source.ref;
    let limit = maxPages;

    if (source.kind === "llms-txt" || source.kind === "llms-full-txt" || source.kind === "readme") {
      const res = await options.contentFetcher(source.url, { accept: "text/markdown,text/plain" });
      if (!res.ok) continue;
      const parsed = parseLlmsTxt(res.body, res.url);
      ref ??= parsed.declaredVersion;
      if (parsed.isIndex) pages = await loadLinkedPages(parsed.links, options, maxPages);
      else {
        // maxPages bounds the number of requests; a single llms-full.txt is already downloaded in full.
        pages = splitMarkdown(res.body, { sourceUrl: res.url, fallbackTitle: options.title });
        limit = Math.max(maxPages, MAX_SPLIT_PAGES);
      }
    } else if (source.kind === "website") {
      pages = await crawlSite(source.url, { fetcher: options.contentFetcher, maxPages: Math.min(maxPages, 50) });
    } else if (source.kind === "repo-docs") {
      const repo = parseRepoUrl(source.url);
      if (repo && source.ref) pages = await loadRepoDocs(repo, { fetcher: options.apiFetcher, ref: source.ref, maxFiles: maxPages });
    } else if (source.kind === "local-docs") {
      pages = loadLocalDocs(source.url, maxPages);
    }

    if (pages.length === 0) continue;
    const sourceRef: SourceRef = { kind: source.kind, url: source.url, fetchedAt: now, ...(ref ? { ref } : {}) };
    return {
      title: options.title,
      ...(options.version ? { version: options.version } : {}),
      ...(options.license ? { license: options.license } : {}),
      pages: dedupePaths(pages.slice(0, limit)),
      sources: [sourceRef],
    };
  }

  return {
    title: options.title,
    ...(options.version ? { version: options.version } : {}),
    ...(options.license ? { license: options.license } : {}),
    pages: [],
    sources: [],
  };
}

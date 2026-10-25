import { stripFrontmatter } from "./markdown-split.js";

export interface LlmsTxtLink {
  title: string;
  url: string;
  description?: string;
  section?: string;
}

export interface LlmsTxt {
  title?: string;
  /** Version the file declares about itself (frontmatter `metadata.version` / `version`). */
  declaredVersion?: string;
  /** True for the llmstxt.org index format (mostly link lists), false for full-content files. */
  isIndex: boolean;
  links: LlmsTxtLink[];
}

const LINK_LINE = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/;

export function parseLlmsTxt(text: string, baseUrl: string): LlmsTxt {
  const { data, body } = stripFrontmatter(text);
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const rawVersion = metadata.version ?? data.version;
  const declaredVersion = typeof rawVersion === "string" || typeof rawVersion === "number" ? String(rawVersion) : undefined;

  const links: LlmsTxtLink[] = [];
  let title: string | undefined;
  let section: string | undefined;
  let fence = false;
  let contentLines = 0;

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      contentLines++;
      continue;
    }
    if (fence || !line.trim()) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      if (heading[1].length === 1 && !title) title = heading[2].trim();
      else section = heading[2].trim();
      continue;
    }
    if (line.startsWith(">")) continue;
    contentLines++;
    const link = LINK_LINE.exec(line);
    if (link?.[1] && link[2]) {
      try {
        links.push({
          title: link[1].trim(),
          url: new URL(link[2], baseUrl).href,
          ...(link[3] ? { description: link[3].trim() } : {}),
          ...(section ? { section } : {}),
        });
      } catch {
        // ignore malformed link targets
      }
    }
  }

  const isIndex = links.length >= 3 && links.length / Math.max(contentLines, 1) >= 0.6;
  return { ...(title ? { title } : {}), ...(declaredVersion ? { declaredVersion } : {}), isIndex, links };
}

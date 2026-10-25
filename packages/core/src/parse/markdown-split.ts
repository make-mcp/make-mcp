import { parse as parseYaml } from "yaml";
import type { DocPage } from "../ir/index.js";

interface Heading {
  level: number;
  title: string;
  /** Line index of the heading itself. */
  line: number;
}

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function stripFrontmatter(markdown: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  } catch {
    // Not YAML after all; keep the text as content.
    return { data: {}, body: markdown };
  }
  return { data, body: markdown.slice(match[0].length) };
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

function findHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch?.[1]) {
      if (!fence) fence = fenceMatch[1];
      else if (line.trim().startsWith(fence)) fence = undefined;
      return;
    }
    if (fence) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h?.[1] && h[2]) headings.push({ level: h[1].length, title: h[2].trim(), line: index });
  });
  return headings;
}

export interface SplitOptions {
  sourceUrl: string;
  /** Title used when the document has no H1. */
  fallbackTitle?: string;
  /** H2 sections larger than this with >= 3 H3 children are split into H3 pages. */
  splitThreshold?: number;
}

/**
 * Splits one large Markdown document (e.g. a full-content llms.txt) into pages:
 * intro → `overview`, each H2 → page, and big H2 sections with many H3s
 * (typically "Components") → one page per H3, marked as `component` when applicable.
 */
export function splitMarkdown(markdown: string, options: SplitOptions): DocPage[] {
  const threshold = options.splitThreshold ?? 6000;
  const { body } = stripFrontmatter(markdown);
  const lines = body.split(/\r?\n/);
  const headings = findHeadings(lines);
  const text = (from: number, to: number) => lines.slice(from, to).join("\n").trim();

  const h1 = headings.find((h) => h.level === 1);
  const docTitle = h1?.title ?? options.fallbackTitle ?? "Overview";
  const h2s = headings.filter((h) => h.level === 2);
  const pages: DocPage[] = [];
  const usedPaths = new Set<string>();

  const push = (page: Omit<DocPage, "path" | "sourceUrl">, pathBase: string) => {
    let path = pathBase;
    for (let i = 2; usedPaths.has(path); i++) path = `${pathBase}-${i}`;
    usedPaths.add(path);
    pages.push({ ...page, path, sourceUrl: options.sourceUrl });
  };

  if (h2s.length === 0) {
    const content = text(0, lines.length);
    if (content) push({ title: docTitle, kind: "page", markdown: content }, slugify(docTitle));
    return pages;
  }

  const intro = text(0, h2s[0]!.line);
  if (intro.replace(/^#\s+.*$/m, "").trim()) push({ title: docTitle, kind: "page", markdown: intro }, "overview");

  h2s.forEach((h2, i) => {
    const end = h2s[i + 1]?.line ?? lines.length;
    const section = text(h2.line, end);
    const h3s = headings.filter((h) => h.level === 3 && h.line > h2.line && h.line < end);

    if (h3s.length >= 3 && section.length > threshold) {
      const isComponentSection = /component/i.test(h2.title);
      const sectionSlug = isComponentSection ? "components" : slugify(h2.title);
      const lead = text(h2.line, h3s[0]!.line);
      if (lead.replace(/^##\s+.*$/m, "").trim()) {
        push({ title: h2.title, kind: "page", markdown: lead }, sectionSlug);
      }
      h3s.forEach((h3, j) => {
        const subEnd = h3s[j + 1]?.line ?? end;
        push(
          {
            title: h3.title,
            section: h2.title,
            kind: isComponentSection ? "component" : "page",
            markdown: text(h3.line, subEnd),
          },
          `${sectionSlug}/${slugify(h3.title)}`,
        );
      });
    } else {
      push({ title: h2.title, kind: "page", markdown: section }, slugify(h2.title));
    }
  });

  return pages;
}

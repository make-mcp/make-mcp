import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "nav", "header", "footer", "aside", "noscript", "iframe", "form"]);

function extractMain(html: string): string {
  for (const tag of ["main", "article"]) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html);
    if (match?.[1]) return match[1];
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return body?.[1] ?? html;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function htmlTitle(html: string): string | undefined {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const title = h1 ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const clean = title?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return clean ? decodeEntities(clean) : undefined;
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(extractMain(html)).trim();
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)/gi)) {
    try {
      const url = new URL(decodeEntities(match[1] ?? ""), baseUrl);
      url.hash = "";
      if (url.protocol === "http:" || url.protocol === "https:") links.add(url.href);
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...links];
}

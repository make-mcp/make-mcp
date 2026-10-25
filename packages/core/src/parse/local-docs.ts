import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createWorkspace } from "../fs/workspace.js";
import type { DocPage } from "../ir/index.js";
import { slugify, stripFrontmatter } from "./markdown-split.js";
import { isRepoDocFile } from "./repo-docs.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".venv", "__pycache__"]);

/** Reads Markdown docs from a local checkout the user pointed us to (confined to that directory). */
export function loadLocalDocs(root: string, maxFiles = 200): DocPage[] {
  const ws = createWorkspace(root);
  const files: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 8 || files.length >= maxFiles * 4) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, depth + 1);
      else files.push(relative(ws.root, full).split("\\").join("/"));
    }
  };
  walk(ws.root, 0);

  const used = new Set<string>();
  return files
    .filter(isRepoDocFile)
    .slice(0, maxFiles)
    .flatMap((file) => {
      const { data, body } = stripFrontmatter(readFileSync(ws.resolve(file), "utf8"));
      if (body.trim().length < 50) return [];
      const title = (typeof data.title === "string" ? data.title : undefined) ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? file;
      const base = file.replace(/\.(md|mdx)$/i, "").split("/").map(slugify).join("/");
      let path = base;
      for (let i = 2; used.has(path); i++) path = `${base}-${i}`;
      used.add(path);
      return [
        {
          path,
          title,
          kind: /(^|\/)components?\//i.test(file) ? ("component" as const) : ("page" as const),
          markdown: body.trim(),
          sourceUrl: `file://${join(ws.root, file)}`,
        },
      ];
    });
}

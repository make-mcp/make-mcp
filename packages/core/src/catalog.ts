import { z } from "zod";
import type { Fetcher } from "./fetch/types.js";
import { IntakeAnswersSchema, type Findings, type IntakeAnswers } from "./intake/types.js";

/**
 * Community catalog (github.com/make-mcp/catalog): curated answers per target – where the docs or spec live,
 * which mode, which tags – never copied documentation. An entry only pre-fills the intake; detection still runs,
 * so the version always comes from the user's project and licenses are handled on the user's machine.
 */

export const CATALOG_URL = "https://raw.githubusercontent.com/make-mcp/catalog/main";

export const CatalogAnswersSchema = IntakeAnswersSchema.pick({
  mode: true,
  docsSource: true,
  codeSource: true,
  auth: true,
  scope: true,
  language: true,
  transport: true,
  tools: true,
});

export const CatalogEntrySchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  title: z.string().min(1),
  description: z.string().min(1).max(300),
  /** What detection starts from: a package name or a docs/OpenAPI URL. */
  target: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** GitHub handles of the people who keep the entry working. */
  maintainers: z.array(z.string()).min(1),
  answers: CatalogAnswersSchema.default({}),
  notes: z.string().optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogIndexSchema = z.object({
  entries: z.array(CatalogEntrySchema.pick({ name: true, title: true, description: true, target: true, tags: true })),
});
export type CatalogIndex = z.infer<typeof CatalogIndexSchema>;

const catalogBase = () => (process.env.MAKE_MCP_CATALOG_URL ?? CATALOG_URL).replace(/\/$/, "");
const catalogDisabled = () => process.env.MAKE_MCP_CATALOG === "off";

/** `catalog:daisyui` → `daisyui`; anything else is not a catalog reference. */
export function catalogName(target: string): string | undefined {
  return /^catalog:([a-z0-9][a-z0-9-]*)$/i.exec(target.trim())?.[1]?.toLowerCase();
}

async function fetchJson(url: string, fetcher: Fetcher): Promise<unknown> {
  try {
    const res = await fetcher(url, { accept: "application/json" });
    return res.ok ? JSON.parse(res.body) : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCatalogIndex(fetcher: Fetcher): Promise<CatalogIndex | undefined> {
  if (catalogDisabled()) return undefined;
  const parsed = CatalogIndexSchema.safeParse(await fetchJson(`${catalogBase()}/index.json`, fetcher));
  return parsed.success ? parsed.data : undefined;
}

export async function fetchCatalogEntry(name: string, fetcher: Fetcher): Promise<CatalogEntry | undefined> {
  if (catalogDisabled() || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;
  const parsed = CatalogEntrySchema.safeParse(await fetchJson(`${catalogBase()}/entries/${name}.json`, fetcher));
  return parsed.success ? parsed.data : undefined;
}

/** Entry for a user-typed target: `catalog:name` explicitly, or the normalised name ("daisyUI" → daisyui). */
export async function findCatalogEntry(target: string, fetcher: Fetcher): Promise<CatalogEntry | undefined> {
  const explicit = catalogName(target);
  if (explicit) return fetchCatalogEntry(explicit, fetcher);
  if (/^https?:\/\//i.test(target)) return undefined;
  const name = target
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return name ? fetchCatalogEntry(name, fetcher) : undefined;
}

export function searchCatalog(index: CatalogIndex, query: string): CatalogIndex["entries"] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return index.entries.filter((e) => {
    const haystack = [e.name, e.title, e.description, ...e.tags].join(" ").toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** Catalog answers as defaults: anything the user already answered wins. */
export function catalogAnswers(findings: Findings, answers: IntakeAnswers): IntakeAnswers {
  return { ...(findings.catalog?.answers ?? {}), ...answers };
}

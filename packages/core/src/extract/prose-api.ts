import { z } from "zod";
import type { ApiSpec, AuthScheme, DocCorpus, DocPage, Endpoint, Param } from "../ir/index.js";
import { endpointId, uniqueIds } from "../parse/openapi.js";

/**
 * Extracting an API from prose documentation is the one step that needs an LLM. make-mcp never calls
 * one itself in agent mode: it hands the coding agent small batches of pages plus a JSON schema and
 * validates what comes back. Every operation must quote the page it came from; operations whose
 * method, path or quote cannot be found in that page are rejected, so invented endpoints do not
 * reach the generated server.
 */

const METHOD = z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["get", "post", "put", "patch", "delete", "head", "options"]));
const FIELD_TYPE = z.enum(["string", "integer", "number", "boolean", "array", "object"]);

export const ExtractedParamSchema = z.object({
  name: z.string().min(1),
  in: z.enum(["path", "query", "header"]),
  required: z.boolean().optional(),
  type: FIELD_TYPE.optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export const ExtractedFieldSchema = z.object({
  name: z.string().min(1),
  type: FIELD_TYPE.optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

export const ExtractedOperationSchema = z.object({
  method: METHOD,
  path: z.string().min(1).describe("Path relative to the base URL, path parameters as {name}"),
  summary: z.string().min(1).describe("Short imperative summary, e.g. 'Create a note'"),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  params: z.array(ExtractedParamSchema).optional(),
  body: z
    .object({
      contentType: z.string().optional(),
      required: z.boolean().optional(),
      fields: z.array(ExtractedFieldSchema).optional(),
    })
    .optional(),
  source: z.object({
    page: z.string().describe("The `path` of the page the operation is documented on"),
    quote: z.string().min(8).max(400).describe("Verbatim excerpt from that page showing the method and path"),
  }),
});
export type ExtractedOperation = z.infer<typeof ExtractedOperationSchema>;

export const ExtractionResultSchema = z.object({
  baseUrl: z.string().optional().describe("Base URL of the API if the pages state it"),
  auth: z
    .object({
      type: z.enum(["none", "apiKey", "bearer", "basic", "oauth2"]),
      in: z.enum(["header", "query", "cookie"]).optional(),
      name: z.string().optional().describe("Header or query parameter name for API keys"),
      tokenUrl: z.string().optional(),
    })
    .optional(),
  operations: z.array(ExtractedOperationSchema),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export const EXTRACTION_INSTRUCTIONS = [
  "Extract the HTTP API operations documented in the pages below.",
  "Report only operations the pages explicitly document with an HTTP method and a path. Never invent endpoints, parameters or fields.",
  "For every operation copy a short verbatim quote (max 300 characters) from the page that shows its method and path, and give that page's `path` as source.page.",
  "Use {name} for path parameters, paths relative to the base URL (e.g. /notes/{id}).",
  "Fill baseUrl and auth only if the pages state them.",
  'Answer with JSON matching the schema only. If the pages document no HTTP API, answer {"operations": []}.',
].join("\n");

export const extractionJsonSchema = () => z.toJSONSchema(ExtractionResultSchema, { io: "input" });

export interface ExtractionTask {
  id: string;
  pages: Pick<DocPage, "path" | "title" | "markdown">[];
}

export interface ExtractionPlan {
  tasks: ExtractionTask[];
  /** Pages that look like API reference, by descending signal strength. */
  candidatePages: number;
  /** Pages left out because of maxTasks. */
  skippedPages: number;
}

const API_SIGNALS: [RegExp, number][] = [
  [/\b(GET|POST|PUT|PATCH|DELETE)\b[`*\s]+(?:https?:\/\/[^\s`]+)?\/[A-Za-z0-9{:<_-]/g, 3],
  [/\bcurl\s/g, 2],
  [/\b(endpoint|request body|query parameter|status code|response)\b/gi, 0.25],
];

/** Short pages about authentication or the base URL rarely name an endpoint but are needed for auth and baseUrl. */
const CONTEXT_SIGNAL = /authenticat|authoriz|api[ -]?key|bearer|base url|https?:\/\/api\./i;
const CONTEXT_MAX_CHARS = 4_000;

function apiSignal(markdown: string): number {
  return API_SIGNALS.reduce((score, [re, weight]) => score + (markdown.match(re)?.length ?? 0) * weight, 0);
}

export interface PlanOptions {
  maxCharsPerTask?: number;
  maxTasks?: number;
}

/** Picks pages that look like API reference and packs them into LLM-sized batches. */
export function planExtraction(corpus: DocCorpus, options: PlanOptions = {}): ExtractionPlan {
  const maxChars = options.maxCharsPerTask ?? 24_000;
  const maxTasks = options.maxTasks ?? 20;
  const candidates = corpus.pages
    .map((page, order) => {
      const score = apiSignal(page.markdown);
      const context = score < 3 && page.markdown.length <= CONTEXT_MAX_CHARS && CONTEXT_SIGNAL.test(page.markdown);
      // Context pages go first so every batch's model sees auth and base URL early.
      return { page, order, score: context ? Number.MAX_SAFE_INTEGER : score, relevant: score >= 3 || context };
    })
    .filter((c) => c.relevant)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const tasks: ExtractionTask[] = [];
  let current: ExtractionTask["pages"] = [];
  let size = 0;
  let skipped = 0;
  const flush = () => {
    if (current.length) tasks.push({ id: `t${tasks.length + 1}`, pages: current });
    current = [];
    size = 0;
  };
  for (const { page } of candidates) {
    const markdown = page.markdown.length > maxChars ? `${page.markdown.slice(0, maxChars)}\n…` : page.markdown;
    if (size + markdown.length > maxChars) flush();
    if (tasks.length >= maxTasks) {
      skipped++;
      continue;
    }
    current.push({ path: page.path, title: page.title, markdown });
    size += markdown.length;
  }
  if (tasks.length < maxTasks) flush();
  else skipped += current.length;
  return { tasks, candidatePages: candidates.length, skippedPages: skipped };
}

/** The user message for one batch; the same text works for the agent and for the CLI's own LLM call. */
export function renderTask(task: ExtractionTask): string {
  return [
    EXTRACTION_INSTRUCTIONS,
    "",
    "JSON schema:",
    JSON.stringify(extractionJsonSchema()),
    "",
    ...task.pages.flatMap((p) => [`=== page: ${p.path} (${p.title}) ===`, p.markdown, ""]),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation against the source pages
// ---------------------------------------------------------------------------

const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_>|\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** `/notes/:id`, `/notes/<id>` and `/notes/{noteId}` all become `/notes/{}`. */
const pathShape = (path: string) =>
  path
    .toLowerCase()
    .replace(/\{[^}/]+\}|:[a-z_][\w-]*|<[^>/]+>/g, "{}")
    .replace(/\/+$/, "") || "/";

/** Every path-like token in the page, plus each suffix starting at a slash (covers full URLs and versioned prefixes). */
function pathShapesIn(markdown: string): Set<string> {
  const shapes = new Set<string>();
  for (const token of markdown.match(/\/[A-Za-z0-9_\-{}:<>.~/]*/g) ?? []) {
    const clean = token.replace(/[.,]+$/, "");
    for (let i = 0; i < clean.length; i++) if (clean[i] === "/" && clean[i + 1] !== "/") shapes.add(pathShape(clean.slice(i)));
  }
  return shapes;
}

/** Converts `:id` / `<id>` to `{id}` and strips scheme/host if the model returned a full URL. */
export function canonicalPath(raw: string): string | undefined {
  let path = raw.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return undefined;
    }
  }
  path = path
    .split(/[?#]/)[0]!
    .replace(/:([A-Za-z_][\w-]*)/g, "{$1}")
    .replace(/<([^>/]+)>/g, "{$1}");
  if (!path.startsWith("/")) return undefined;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export interface Rejection {
  method: string;
  path: string;
  reason: string;
}

export interface ValidatedExtraction {
  operations: ExtractedOperation[];
  rejected: Rejection[];
  baseUrl?: string;
  auth?: ExtractionResult["auth"];
  notes: string[];
}

/** Keeps only operations whose method, path and quote are found on the cited page; de-duplicates by method + path. */
export function validateExtraction(results: ExtractionResult[], corpus: DocCorpus): ValidatedExtraction {
  const pages = new Map(corpus.pages.map((p) => [p.path, p]));
  const pageText = new Map<string, string>();
  const pageShapes = new Map<string, Set<string>>();
  const textOf = (page: DocPage) => {
    if (!pageText.has(page.path)) pageText.set(page.path, normalizeText(page.markdown));
    return pageText.get(page.path)!;
  };
  const shapesOf = (page: DocPage) => {
    if (!pageShapes.has(page.path)) pageShapes.set(page.path, pathShapesIn(page.markdown));
    return pageShapes.get(page.path)!;
  };

  const operations: ExtractedOperation[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];

  for (const op of results.flatMap((r) => r.operations)) {
    const reject = (reason: string) => rejected.push({ method: op.method.toUpperCase(), path: op.path, reason });
    const page = pages.get(op.source.page) ?? corpus.pages.find((p) => p.title === op.source.page);
    if (!page) {
      reject(`cited page "${op.source.page}" does not exist`);
      continue;
    }
    const path = canonicalPath(op.path);
    if (!path) {
      reject("path is not a relative path");
      continue;
    }
    if (!textOf(page).includes(normalizeText(op.source.quote))) {
      reject(`quote not found on page ${page.path}`);
      continue;
    }
    if (!shapesOf(page).has(pathShape(path))) {
      reject(`path not found on page ${page.path}`);
      continue;
    }
    if (!new RegExp(`\\b${op.method}\\b`, "i").test(page.markdown)) {
      reject(`method ${op.method.toUpperCase()} not mentioned on page ${page.path}`);
      continue;
    }
    const key = `${op.method} ${pathShape(path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    operations.push({ ...op, path });
  }

  // Base URL and auth are only taken over when the documentation itself states them.
  const corpusText = corpus.pages.map((p) => p.markdown).join("\n");
  let baseUrl: string | undefined;
  for (const candidate of results.map((r) => r.baseUrl?.trim().replace(/\/+$/, "")).filter((u): u is string => Boolean(u))) {
    if (/^https?:\/\/\S+$/i.test(candidate) && corpusText.includes(candidate)) {
      baseUrl = candidate;
      break;
    }
    notes.push(`Ignored base URL ${candidate}: not found in the documentation.`);
  }
  const auth = results.map((r) => r.auth).find((a) => a && a.type !== "none" && (!a.name || corpusText.includes(a.name)));

  return { operations, rejected, ...(baseUrl ? { baseUrl } : {}), ...(auth ? { auth } : {}), notes };
}

// ---------------------------------------------------------------------------
// Conversion to the IR
// ---------------------------------------------------------------------------

function paramSchema(type: string | undefined, values: string[] | undefined): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: type ?? "string" };
  if (type === "array") schema.items = { type: "string" };
  if (values?.length) schema.enum = values;
  return schema;
}

/** Short imperative summaries ("Create a note") make better tool names than method + path. */
function summaryId(summary: string): string | undefined {
  const words = summary
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => !/^(a|an|the)$/i.test(w));
  return words.length >= 2 && words.length <= 6 ? words.join("_") : undefined;
}

function toEndpoint(op: ExtractedOperation): Endpoint {
  const params: Param[] = (op.params ?? []).map((p) => ({
    name: p.name,
    in: p.in,
    required: p.in === "path" ? true : (p.required ?? false),
    ...(p.description ? { description: p.description } : {}),
    schema: paramSchema(p.type, p.enum),
  }));
  for (const [, name] of op.path.matchAll(/\{([^}]+)\}/g)) {
    if (name && !params.some((p) => p.in === "path" && p.name === name)) params.push({ name, in: "path", required: true, schema: { type: "string" } });
  }

  const fields = op.body?.fields ?? [];
  const requiredFields = fields.filter((f) => f.required).map((f) => f.name);
  const body = op.body
    ? {
        contentType: op.body.contentType ?? "application/json",
        required: op.body.required ?? requiredFields.length > 0,
        schema: fields.length
          ? {
              type: "object",
              properties: Object.fromEntries(
                fields.map((f) => [f.name, { ...paramSchema(f.type, undefined), ...(f.description ? { description: f.description } : {}) }]),
              ),
              ...(requiredFields.length ? { required: requiredFields } : {}),
            }
          : { type: "object", additionalProperties: true },
      }
    : undefined;

  return {
    id: endpointId(op.method, op.path, summaryId(op.summary)),
    method: op.method,
    path: op.path,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    params,
    ...(body ? { body } : {}),
    tags: op.tags ?? [],
    deprecated: false,
    resource: op.method === "get" && !params.some((p) => p.in === "query") && !body,
  };
}

function authScheme(auth: ValidatedExtraction["auth"], envPrefix: string): AuthScheme[] {
  switch (auth?.type) {
    case "apiKey":
      return [{ type: "apiKey", in: auth.in ?? "header", name: auth.name ?? "X-API-Key", envVar: `${envPrefix}_API_KEY` }];
    case "bearer":
      return [{ type: "bearer", envVar: `${envPrefix}_TOKEN` }];
    case "basic":
      return [{ type: "basic", userEnvVar: `${envPrefix}_USERNAME`, passwordEnvVar: `${envPrefix}_PASSWORD` }];
    case "oauth2":
      return [
        {
          type: "oauth2",
          ...(auth.tokenUrl ? { tokenUrl: auth.tokenUrl } : {}),
          scopes: [],
          tokenEnvVar: `${envPrefix}_ACCESS_TOKEN`,
          clientIdEnvVar: `${envPrefix}_CLIENT_ID`,
          clientSecretEnvVar: `${envPrefix}_CLIENT_SECRET`,
        },
      ];
    default:
      return [];
  }
}

export interface ExtractedSpecOptions {
  title: string;
  version: string;
  envPrefix: string;
  fetchedAt: string;
}

export function extractionToSpec(validated: ValidatedExtraction, corpus: DocCorpus, options: ExtractedSpecOptions): ApiSpec {
  const source = corpus.sources[0];
  return {
    title: options.title,
    specVersion: options.version,
    baseUrl: validated.baseUrl ?? "",
    versionStrategy: { type: "none" },
    auth: authScheme(validated.auth, options.envPrefix),
    endpoints: uniqueIds(validated.operations.map(toEndpoint)),
    source: {
      kind: source?.kind ?? "website",
      url: source?.url ?? "",
      fetchedAt: options.fetchedAt,
      ...(source?.ref ? { ref: source.ref } : {}),
    },
  };
}

/** Lenient JSON parsing for model output: strips code fences and surrounding prose. */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

import { parse as parseYaml } from "yaml";
import { MakeMcpError } from "../errors.js";
import {
  ApiSpecSchema,
  type ApiSpec,
  type AuthScheme,
  type Endpoint,
  type Param,
  type RequestBody,
  type VersionStrategy,
} from "../ir/index.js";

type Json = Record<string, unknown>;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
type Method = (typeof METHODS)[number];
const MAX_SCHEMA_DEPTH = 8;

export type OpenApiFlavor = "openapi3" | "swagger2";

export function parseApiDocument(text: string): Json {
  const trimmed = text.trim();
  try {
    const doc: unknown = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(trimmed);
    if (doc && typeof doc === "object" && !Array.isArray(doc)) return doc as Json;
  } catch (err) {
    throw new MakeMcpError("SPEC_INVALID", `Spec is neither JSON nor YAML: ${(err as Error).message}`);
  }
  throw new MakeMcpError("SPEC_INVALID", "Spec document is not an object");
}

export function detectOpenApiFlavor(doc: Json): OpenApiFlavor | undefined {
  if (typeof doc.openapi === "string" && doc.openapi.startsWith("3")) return "openapi3";
  if (doc.swagger === "2.0") return "swagger2";
  return undefined;
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolvePointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((part) => decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((node, key) => (isObject(node) || Array.isArray(node) ? (node as Json)[key] : undefined), doc);
}

/** Inlines internal `$ref`s into a JSON-safe tree; cycles, external refs and deep nesting become stubs. */
function deref(doc: Json, node: unknown, depth = 0, stack: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((item) => deref(doc, item, depth + 1, stack));
  if (!isObject(node)) return node;

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const name = ref.split("/").pop() ?? ref;
    if (stack.includes(ref) || depth > MAX_SCHEMA_DEPTH) {
      return { type: "object", description: `${name} (nested structure omitted)` };
    }
    const target = resolvePointer(doc, ref);
    if (target === undefined) return { description: `Unresolved reference ${ref}` };
    return deref(doc, target, depth + 1, [...stack, ref]);
  }

  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "xml" || key === "externalDocs" || key.startsWith("x-")) continue;
    out[key] = deref(doc, value, depth + 1, stack);
  }
  return out;
}

export function toSnakeCase(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function endpointId(method: Method, path: string, operationId: unknown): string {
  if (typeof operationId === "string" && toSnakeCase(operationId)) return toSnakeCase(operationId).slice(0, 64);
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? `by_${seg.slice(1, -1)}` : seg));
  return toSnakeCase([method, ...segments].join("_")).slice(0, 64) || method;
}

export function uniqueIds(endpoints: Endpoint[]): Endpoint[] {
  const used = new Map<string, number>();
  return endpoints.map((ep) => {
    const count = used.get(ep.id) ?? 0;
    used.set(ep.id, count + 1);
    if (count === 0) return ep;
    const suffix = `_${count + 1}`;
    return { ...ep, id: ep.id.slice(0, 64 - suffix.length) + suffix };
  });
}

function paramSchemaSwagger2(p: Json): Json {
  const schema: Json = {};
  for (const key of ["type", "format", "items", "enum", "default", "minimum", "maximum", "pattern"]) {
    if (p[key] !== undefined) schema[key] = p[key];
  }
  if (schema.type === "file") schema.type = "string";
  return schema;
}

function mergeParams(pathLevel: unknown, opLevel: unknown, doc: Json): Json[] {
  const merged = new Map<string, Json>();
  for (const list of [pathLevel, opLevel]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = deref(doc, raw) as Json;
      if (typeof p.name === "string" && typeof p.in === "string") merged.set(`${p.in}:${p.name}`, p);
    }
  }
  return [...merged.values()];
}

function buildEndpoint(doc: Json, flavor: OpenApiFlavor, method: Method, path: string, pathItem: Json, op: Json): Endpoint {
  const rawParams = mergeParams(pathItem.parameters, op.parameters, doc);
  const params: Param[] = [];
  let body: RequestBody | undefined;
  const formProps: Json = {};
  const formRequired: string[] = [];
  let formIsMultipart = false;

  for (const p of rawParams) {
    const location = p.in as string;
    if (location === "body") {
      const consumes = (op.consumes ?? doc.consumes) as string[] | undefined;
      body = {
        contentType: consumes?.[0] ?? "application/json",
        required: p.required === true,
        schema: (p.schema as Json) ?? {},
      };
      continue;
    }
    if (location === "formData") {
      formProps[p.name as string] = { ...paramSchemaSwagger2(p), ...(p.description ? { description: p.description } : {}) };
      if (p.required === true) formRequired.push(p.name as string);
      if (p.type === "file") formIsMultipart = true;
      continue;
    }
    if (!["path", "query", "header", "cookie"].includes(location)) continue;
    params.push({
      name: p.name as string,
      in: location as Param["in"],
      required: location === "path" || p.required === true,
      ...(typeof p.description === "string" ? { description: p.description } : {}),
      schema: flavor === "swagger2" ? paramSchemaSwagger2(p) : ((p.schema as Json) ?? { type: "string" }),
    });
  }

  if (Object.keys(formProps).length > 0) {
    body = {
      contentType: formIsMultipart ? "multipart/form-data" : "application/x-www-form-urlencoded",
      required: formRequired.length > 0,
      schema: { type: "object", properties: formProps, ...(formRequired.length ? { required: formRequired } : {}) },
    };
  }

  if (flavor === "openapi3" && op.requestBody) {
    const rb = deref(doc, op.requestBody) as Json;
    const content = (rb.content ?? {}) as Record<string, Json>;
    const contentType = Object.keys(content).find((ct) => ct.includes("json")) ?? Object.keys(content)[0];
    if (contentType) {
      body = { contentType, required: rb.required === true, schema: (content[contentType]?.schema as Json) ?? {} };
    }
  }

  const hasQuery = params.some((p) => p.in === "query");
  return {
    id: endpointId(method, path, op.operationId),
    method,
    path,
    ...(typeof op.summary === "string" ? { summary: op.summary.trim() } : {}),
    ...(typeof op.description === "string" ? { description: op.description.trim() } : {}),
    params,
    ...(body ? { body } : {}),
    tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string") : [],
    deprecated: op.deprecated === true,
    resource: method === "get" && !hasQuery && !body,
  };
}

function baseUrlOf(doc: Json, flavor: OpenApiFlavor, sourceUrl: string): string {
  const fallbackOrigin = (() => {
    try {
      return new URL(sourceUrl).origin;
    } catch {
      return "http://localhost";
    }
  })();

  if (flavor === "swagger2") {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.includes("https") ? "https" : ((doc.schemes as string[])?.[0] ?? "https");
    const host = typeof doc.host === "string" ? `${scheme}://${doc.host}` : fallbackOrigin;
    return `${host}${typeof doc.basePath === "string" ? doc.basePath : ""}`.replace(/\/$/, "");
  }

  const server = (doc.servers as Json[] | undefined)?.[0];
  if (!server || typeof server.url !== "string") return fallbackOrigin;
  let url = server.url;
  for (const [name, variable] of Object.entries((server.variables ?? {}) as Record<string, Json>)) {
    url = url.replaceAll(`{${name}}`, String(variable.default ?? ""));
  }
  try {
    return new URL(url, sourceUrl.startsWith("http") ? sourceUrl : fallbackOrigin).href.replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

const VERSION_SEGMENT = /\/(v\d+(?:\.\d+)?)(?=\/|$)/;

function detectVersionStrategy(
  baseUrl: string,
  endpoints: Endpoint[],
  specVersion: string,
): { baseUrl: string; endpoints: Endpoint[]; strategy: VersionStrategy } {
  const inBase = VERSION_SEGMENT.exec(new URL(baseUrl).pathname);
  if (inBase?.[1]) {
    return {
      baseUrl: baseUrl.replace(`/${inBase[1]}`, "/{apiVersion}"),
      endpoints,
      strategy: { type: "path", default: inBase[1] },
    };
  }

  const prefixes = new Set(endpoints.map((ep) => VERSION_SEGMENT.exec(ep.path)?.index === 0 ? VERSION_SEGMENT.exec(ep.path)?.[1] : undefined));
  const [only] = prefixes;
  if (endpoints.length > 0 && prefixes.size === 1 && only) {
    return {
      baseUrl: `${baseUrl}/{apiVersion}`,
      endpoints: endpoints.map((ep) => ({ ...ep, path: ep.path.slice(only.length + 1) || "/" })),
      strategy: { type: "path", default: only },
    };
  }

  for (const location of ["header", "query"] as const) {
    const pattern = location === "header" ? /^(x-)?api-version$/i : /^api-version$/i;
    const hits = endpoints.filter((ep) => ep.params.some((p) => p.in === location && pattern.test(p.name)));
    if (endpoints.length > 0 && hits.length / endpoints.length >= 0.5) {
      const sample = hits[0]!.params.find((p) => p.in === location && pattern.test(p.name))!;
      const schema = sample.schema;
      const fallback = (schema.default ?? (Array.isArray(schema.enum) ? schema.enum[0] : undefined) ?? specVersion) as string;
      return {
        baseUrl,
        endpoints: endpoints.map((ep) => ({ ...ep, params: ep.params.filter((p) => !(p.in === location && pattern.test(p.name))) })),
        strategy: { type: location, name: sample.name, default: String(fallback) },
      };
    }
  }

  return { baseUrl, endpoints, strategy: { type: "none" } };
}

function authSchemes(doc: Json, flavor: OpenApiFlavor, envPrefix: string): AuthScheme[] {
  const defs = (
    flavor === "swagger2" ? doc.securityDefinitions : (doc.components as Json | undefined)?.securitySchemes
  ) as Record<string, Json> | undefined;
  if (!defs) return [];

  const schemes: AuthScheme[] = [];
  const oauthEnv = {
    tokenEnvVar: `${envPrefix}_ACCESS_TOKEN`,
    clientIdEnvVar: `${envPrefix}_CLIENT_ID`,
    clientSecretEnvVar: `${envPrefix}_CLIENT_SECRET`,
  };

  for (const raw of Object.values(defs)) {
    const def = deref(doc, raw) as Json;
    const type = String(def.type ?? "");
    if (type === "apiKey" && typeof def.name === "string") {
      const location = ["header", "query", "cookie"].includes(String(def.in)) ? (def.in as "header" | "query" | "cookie") : "header";
      schemes.push({ type: "apiKey", in: location, name: def.name, envVar: `${envPrefix}_API_KEY` });
    } else if ((type === "http" && String(def.scheme).toLowerCase() === "bearer") || type === "openIdConnect") {
      schemes.push({ type: "bearer", envVar: `${envPrefix}_TOKEN` });
    } else if ((type === "http" && String(def.scheme).toLowerCase() === "basic") || type === "basic") {
      schemes.push({ type: "basic", userEnvVar: `${envPrefix}_USERNAME`, passwordEnvVar: `${envPrefix}_PASSWORD` });
    } else if (type === "oauth2") {
      const flows = (def.flows ?? {}) as Record<string, Json>;
      const clientCredentials = flows.clientCredentials ?? (def.flow === "application" ? def : undefined);
      const scopeSource = (clientCredentials?.scopes ?? Object.values(flows)[0]?.scopes ?? def.scopes ?? {}) as Json;
      const tokenUrl = clientCredentials?.tokenUrl;
      schemes.push({
        type: "oauth2",
        ...(typeof tokenUrl === "string" ? { tokenUrl } : {}),
        scopes: Object.keys(scopeSource),
        ...oauthEnv,
      });
    }
  }

  // One scheme per type is enough for env var placeholders.
  return schemes.filter((s, i) => schemes.findIndex((o) => o.type === s.type) === i);
}

export interface OpenApiOptions {
  sourceUrl: string;
  envPrefix: string;
  fetchedAt?: string;
}

export function openApiToSpec(doc: Json, options: OpenApiOptions): ApiSpec {
  const flavor = detectOpenApiFlavor(doc);
  if (!flavor) throw new MakeMcpError("SPEC_INVALID", "Not an OpenAPI 3.x or Swagger 2.0 document");
  const info = (doc.info ?? {}) as Json;
  const paths = (doc.paths ?? {}) as Record<string, Json>;

  const endpoints: Endpoint[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = deref(doc, rawItem) as Json;
    for (const method of METHODS) {
      const op = pathItem[method];
      if (isObject(op)) endpoints.push(buildEndpoint(doc, flavor, method, path, pathItem, op));
    }
  }

  const specVersion = String(info.version ?? "");
  const versioned = detectVersionStrategy(baseUrlOf(doc, flavor, options.sourceUrl), uniqueIds(endpoints), specVersion);

  return ApiSpecSchema.parse({
    title: String(info.title ?? "API"),
    ...(typeof info.description === "string" ? { description: info.description } : {}),
    specVersion,
    baseUrl: versioned.baseUrl,
    versionStrategy: versioned.strategy,
    auth: authSchemes(doc, flavor, options.envPrefix),
    endpoints: versioned.endpoints,
    source: { kind: "openapi", url: options.sourceUrl, fetchedAt: options.fetchedAt ?? new Date().toISOString() },
  });
}

/** Applies a user-requested API version when it has the same shape as the spec's default (e.g. v2 → v3). */
export function applyRequestedVersion(spec: ApiSpec, requested: string | undefined): { spec: ApiSpec; applied: boolean } {
  const strategy = spec.versionStrategy;
  if (!requested || strategy.type === "none") return { spec, applied: false };
  const shape = (v: string) => v.replace(/\d+/g, "9");
  let candidate = requested;
  if (strategy.default.startsWith("v") && /^\d/.test(requested)) candidate = `v${requested}`;
  if (shape(candidate) !== shape(strategy.default)) return { spec, applied: false };
  return { spec: { ...spec, versionStrategy: { ...strategy, default: candidate } }, applied: true };
}

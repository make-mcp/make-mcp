import { isMakeMcpError } from "../errors.js";
import type { Fetcher, FetchResult } from "../fetch/types.js";
import { parseLlmsTxt } from "../parse/llms-txt.js";
import { detectOpenApiFlavor, parseApiDocument } from "../parse/openapi.js";

export interface OpenApiProbe {
  url: string;
  title: string;
  endpointCount: number;
  tags: string[];
  /** Security scheme types declared by the spec (apiKey, http, oauth2, …). */
  authTypes: string[];
  /** `info.version` of the spec. */
  specVersion: string;
}

export interface DocsProbe {
  llmsFullTxt?: string;
  llmsTxt?: { url: string; declaredVersion?: string };
  openapi?: OpenApiProbe;
  website?: string;
}

const OPENAPI_PATHS = ["/openapi.json", "/openapi.yaml", "/swagger.json", "/v3/api-docs", "/api-docs", "/swagger/v1/swagger.json"];

async function tryFetch(fetcher: Fetcher, url: string, accept?: string): Promise<FetchResult | undefined> {
  try {
    const res = await fetcher(url, accept ? { accept } : undefined);
    return res.ok ? res : undefined;
  } catch (err) {
    if (isMakeMcpError(err)) return undefined;
    throw err;
  }
}

export function summarizeOpenApi(url: string, body: string): OpenApiProbe | undefined {
  try {
    const doc = parseApiDocument(body);
    if (!detectOpenApiFlavor(doc)) return undefined;
    const paths = (doc.paths ?? {}) as Record<string, Record<string, { tags?: string[] }>>;
    const ops = Object.values(paths).flatMap((item) =>
      Object.entries(item)
        .filter(([method]) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method))
        .map(([, op]) => op),
    );
    const tags = [...new Set(ops.flatMap((op) => op?.tags ?? []))];
    const schemes = (doc.securityDefinitions ?? (doc.components as { securitySchemes?: unknown } | undefined)?.securitySchemes ?? {}) as Record<
      string,
      { type?: string }
    >;
    const authTypes = [...new Set(Object.values(schemes).map((s) => String(s.type ?? "")).filter(Boolean))];
    return {
      url,
      title: String((doc.info as { title?: string } | undefined)?.title ?? "API"),
      endpointCount: ops.length,
      tags,
      authTypes,
      specVersion: String((doc.info as { version?: unknown } | undefined)?.version ?? ""),
    };
  } catch {
    return undefined;
  }
}

const looksLikeText = (res: FetchResult) => !res.contentType.includes("html") && !/^\s*<(!doctype|html)/i.test(res.body);

/** Probes a URL and its origin for llms.txt variants, OpenAPI documents and a docs website. */
export async function probeDocs(rawUrl: string, fetcher: Fetcher): Promise<DocsProbe> {
  const url = new URL(rawUrl);
  const probe: DocsProbe = {};

  // The URL itself may be the spec or an llms.txt.
  const direct = await tryFetch(fetcher, url.href);
  if (direct) {
    const openapi = summarizeOpenApi(direct.url, direct.body);
    if (openapi) probe.openapi = openapi;
    else if (/llms(-full)?\.txt$/.test(url.pathname) && looksLikeText(direct)) {
      if (url.pathname.endsWith("llms-full.txt")) probe.llmsFullTxt = direct.url;
      else {
        const declared = parseLlmsTxt(direct.body, direct.url).declaredVersion;
        probe.llmsTxt = { url: direct.url, ...(declared ? { declaredVersion: declared } : {}) };
      }
    } else if (direct.contentType.includes("html")) probe.website = direct.url;
  }

  const full = probe.llmsFullTxt ? undefined : await tryFetch(fetcher, `${url.origin}/llms-full.txt`, "text/plain");
  if (full && looksLikeText(full)) probe.llmsFullTxt = full.url;

  if (!probe.llmsTxt) {
    const llms = await tryFetch(fetcher, `${url.origin}/llms.txt`, "text/plain");
    if (llms && looksLikeText(llms)) {
      const declared = parseLlmsTxt(llms.body, llms.url).declaredVersion;
      probe.llmsTxt = { url: llms.url, ...(declared ? { declaredVersion: declared } : {}) };
    }
  }

  if (!probe.openapi) {
    for (const path of OPENAPI_PATHS) {
      const res = await tryFetch(fetcher, `${url.origin}${path}`, "application/json,application/yaml");
      const openapi = res && summarizeOpenApi(res.url, res.body);
      if (openapi) {
        probe.openapi = openapi;
        break;
      }
    }
  }

  return probe;
}

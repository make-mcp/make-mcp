import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetcher, FetchResult } from "./types.js";

interface FixtureEntry {
  file?: string;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * Offline Fetcher backed by `<dir>/manifest.json` (`{ "<url>": { file, status, contentType } }`).
 * Unknown URLs answer 404, mirroring how discovery probes behave against real hosts.
 */
export function createFixtureFetch(dir: string): Fetcher {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, FixtureEntry>;

  return async (url): Promise<FetchResult> => {
    const entry = manifest[url];
    if (!entry) {
      return { url, status: 404, ok: false, contentType: "text/plain", headers: {}, body: "not found" };
    }
    const status = entry.status ?? 200;
    return {
      url,
      status,
      ok: status >= 200 && status < 300,
      contentType: entry.contentType ?? "text/plain",
      headers: entry.headers ?? {},
      body: entry.file ? readFileSync(join(dir, entry.file), "utf8") : "",
    };
  };
}

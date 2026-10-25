import { MakeMcpError } from "../errors.js";
import { ALLOW_ALL, parseRobots, pathMatches, type RobotsPolicy } from "./robots.js";
import type { Fetcher } from "./types.js";

interface TdmRepEntry {
  location?: string;
  "tdm-reservation"?: number;
}

export interface PoliteFetchOptions {
  /** Minimum delay between requests to the same origin. */
  delayMs?: number;
}

/**
 * Wraps a Fetcher for content crawling: honours robots.txt, the TDM reservation
 * protocol (`tdm-reservation` header and `/.well-known/tdmrep.json`, cf. § 44b UrhG)
 * and spaces out requests per origin. Use it for documentation, not for registry APIs.
 */
export function createPoliteFetch(inner: Fetcher, options: PoliteFetchOptions = {}): Fetcher {
  const delayMs = options.delayMs ?? 250;
  const robots = new Map<string, Promise<RobotsPolicy>>();
  const tdm = new Map<string, Promise<TdmRepEntry[]>>();
  const lastRequest = new Map<string, number>();

  const robotsFor = (origin: string) => {
    let policy = robots.get(origin);
    if (!policy) {
      policy = inner(`${origin}/robots.txt`)
        .then((res) => (res.ok ? parseRobots(res.body) : ALLOW_ALL))
        .catch(() => ALLOW_ALL);
      robots.set(origin, policy);
    }
    return policy;
  };

  const tdmFor = (origin: string) => {
    let entries = tdm.get(origin);
    if (!entries) {
      entries = inner(`${origin}/.well-known/tdmrep.json`)
        .then((res) => {
          if (!res.ok) return [];
          const parsed: unknown = JSON.parse(res.body);
          return Array.isArray(parsed) ? (parsed as TdmRepEntry[]) : [];
        })
        .catch(() => []);
      tdm.set(origin, entries);
    }
    return entries;
  };

  const throttle = async (origin: string) => {
    const wait = (lastRequest.get(origin) ?? 0) + delayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequest.set(origin, Date.now());
  };

  return async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const path = url.pathname + url.search;

    if (!(await robotsFor(url.origin)).isAllowed(path)) {
      throw new MakeMcpError("ROBOTS_DISALLOWED", `robots.txt disallows ${rawUrl}`, { url: rawUrl });
    }
    const reserved = (await tdmFor(url.origin)).some(
      (e) => e["tdm-reservation"] === 1 && e.location && pathMatches(e.location, url.pathname),
    );
    if (reserved) {
      throw new MakeMcpError("ROBOTS_DISALLOWED", `TDM rights reserved for ${rawUrl} (tdmrep.json)`, { url: rawUrl });
    }

    await throttle(url.origin);
    const res = await inner(rawUrl, init);
    if (res.ok && res.headers["tdm-reservation"]?.trim() === "1") {
      throw new MakeMcpError("ROBOTS_DISALLOWED", `TDM rights reserved for ${rawUrl} (header)`, { url: rawUrl });
    }
    return res;
  };
}

import { createFixtureFetch } from "./fixture-fetch.js";
import { createPoliteFetch } from "./polite-fetch.js";
import { createSafeFetch } from "./safe-fetch.js";
import type { Fetcher } from "./types.js";

export interface Fetchers {
  /** Registries and the GitHub API. */
  apiFetcher: Fetcher;
  /** Documentation content; honours robots.txt and TDM reservations. */
  contentFetcher: Fetcher;
}

export interface FetcherConfig {
  allowPrivateNetworks?: boolean;
  /** Serve requests from a fixture manifest instead of the network (tests, demos). */
  fixturesDir?: string;
}

/** Reads `MAKE_MCP_ALLOW_PRIVATE=1` and `MAKE_MCP_FIXTURES=<dir>` unless overridden. */
export function createFetchers(config: FetcherConfig = {}): Fetchers {
  const fixturesDir = config.fixturesDir ?? process.env.MAKE_MCP_FIXTURES;
  const apiFetcher = fixturesDir
    ? createFixtureFetch(fixturesDir)
    : createSafeFetch({ allowPrivateNetworks: config.allowPrivateNetworks ?? process.env.MAKE_MCP_ALLOW_PRIVATE === "1" });
  return { apiFetcher, contentFetcher: createPoliteFetch(apiFetcher, fixturesDir ? { delayMs: 0 } : {}) };
}

export interface FetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}

export interface FetchInit {
  accept?: string;
  headers?: Record<string, string>;
}

/**
 * All network access in core goes through a Fetcher so that callers can swap
 * in SSRF-guarded network access (`createSafeFetch`) or fixtures (`createFixtureFetch`).
 * Non-2xx responses resolve normally; transport failures and policy violations throw.
 */
export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResult>;

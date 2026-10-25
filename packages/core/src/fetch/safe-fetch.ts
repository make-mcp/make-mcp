import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { MakeMcpError } from "../errors.js";
import type { Fetcher, FetchResult } from "./types.js";

export const USER_AGENT = "make-mcp/0.1 (+https://make-mcp.net)";

export interface SafeFetchOptions {
  /** Allow RFC1918/loopback/ULA targets, e.g. for internal docs on the user's own machine. */
  allowPrivateNetworks?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
}

const DEFAULTS = { maxBytes: 10 * 1024 * 1024, timeoutMs: 15_000, maxRedirects: 5 };

/** Never reachable, not even with allowPrivateNetworks (cloud metadata, link-local, unspecified). */
const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet("0.0.0.0", 8, "ipv4");
alwaysBlocked.addSubnet("169.254.0.0", 16, "ipv4");
alwaysBlocked.addSubnet("224.0.0.0", 4, "ipv4");
alwaysBlocked.addSubnet("240.0.0.0", 4, "ipv4");
alwaysBlocked.addAddress("::", "ipv6");
alwaysBlocked.addSubnet("fe80::", 10, "ipv6");
alwaysBlocked.addSubnet("ff00::", 8, "ipv6");

const privateRanges = new BlockList();
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
privateRanges.addSubnet("100.64.0.0", 10, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("198.18.0.0", 15, "ipv4");
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");

const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata"]);

function normalizeIp(ip: string): { address: string; family: "ipv4" | "ipv6" } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return { address: mapped[1], family: "ipv4" };
  return { address: ip, family: isIP(ip) === 6 ? "ipv6" : "ipv4" };
}

export function isBlockedAddress(ip: string, allowPrivateNetworks = false): boolean {
  const { address, family } = normalizeIp(ip);
  if (alwaysBlocked.check(address, family)) return true;
  return !allowPrivateNetworks && privateRanges.check(address, family);
}

function assertAllowedUrl(raw: string, allowPrivateNetworks: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MakeMcpError("FETCH_BLOCKED", `Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MakeMcpError("FETCH_BLOCKED", `Protocol not allowed: ${url.protocol}`, { url: raw });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) {
    throw new MakeMcpError("FETCH_BLOCKED", `Host not allowed: ${host}`, { url: raw });
  }
  if (isIP(host) && isBlockedAddress(host, allowPrivateNetworks)) {
    throw new MakeMcpError("FETCH_BLOCKED", `Address not allowed: ${host}`, { url: raw });
  }
  return url;
}

/** DNS lookup that refuses blocked addresses, so the check also holds against DNS rebinding. */
function guardedLookup(allowPrivateNetworks: boolean) {
  return (
    hostname: string,
    options: object,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const blocked = addresses.find((a) => isBlockedAddress(a.address, allowPrivateNetworks));
      if (blocked) {
        const error: NodeJS.ErrnoException = new Error(`Resolved address not allowed: ${hostname} -> ${blocked.address}`);
        error.code = "MAKE_MCP_FETCH_BLOCKED";
        return callback(error, []);
      }
      if ((options as { all?: boolean }).all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(new Error(`No address for ${hostname}`), []);
      callback(null, first.address, first.family);
    });
  };
}

async function readLimited(body: AsyncIterable<Uint8Array> | null, maxBytes: number, url: string): Promise<string> {
  if (!body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new MakeMcpError("FETCH_TOO_LARGE", `Response exceeds ${maxBytes} bytes`, { url });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function causeCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    const code = (current as { code?: string }).code;
    if (code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function createSafeFetch(options: SafeFetchOptions = {}): Fetcher {
  const allowPrivate = options.allowPrivateNetworks ?? false;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(allowPrivate) } });

  return async (rawUrl, init = {}): Promise<FetchResult> => {
    let url = assertAllowedUrl(rawUrl, allowPrivate);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let res;
      try {
        res = await undiciFetch(url, {
          dispatcher,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "user-agent": options.userAgent ?? USER_AGENT,
            accept: init.accept ?? "*/*",
            ...init.headers,
          },
        });
      } catch (err) {
        if (causeCode(err) === "MAKE_MCP_FETCH_BLOCKED") {
          throw new MakeMcpError("FETCH_BLOCKED", `Address not allowed for ${url.hostname}`, { url: url.href });
        }
        throw new MakeMcpError("FETCH_FAILED", `Request to ${url.href} failed: ${(err as Error).message}`, {
          url: url.href,
        });
      }

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = assertAllowedUrl(new URL(location, url).href, allowPrivate);
        continue;
      }

      const body = await readLimited(res.body, maxBytes, url.href);
      return {
        url: url.href,
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type") ?? "",
        headers: Object.fromEntries(res.headers.entries()),
        body,
      };
    }
    throw new MakeMcpError("FETCH_FAILED", `Too many redirects for ${rawUrl}`, { url: rawUrl });
  };
}

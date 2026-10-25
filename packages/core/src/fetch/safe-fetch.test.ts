import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMakeMcpError } from "../errors.js";
import { createSafeFetch, isBlockedAddress } from "./safe-fetch.js";

describe("isBlockedAddress", () => {
  it.each([
    ["169.254.169.254", true],
    ["0.0.0.0", true],
    ["fe80::1", true],
    ["::ffff:169.254.169.254", true],
    ["10.1.2.3", true],
    ["127.0.0.1", true],
    ["192.168.178.1", true],
    ["172.20.0.1", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["fd00::1", true],
    ["::ffff:10.0.0.1", true],
    ["8.8.8.8", false],
    ["2606:4700::1111", false],
  ])("%s blocked=%s", (ip, expected) => {
    expect(isBlockedAddress(ip)).toBe(expected);
  });

  it("allows private ranges when explicitly permitted, but never metadata", () => {
    expect(isBlockedAddress("192.168.1.10", true)).toBe(false);
    expect(isBlockedAddress("127.0.0.1", true)).toBe(false);
    expect(isBlockedAddress("169.254.169.254", true)).toBe(true);
  });
});

describe("createSafeFetch", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect-to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      } else if (req.url === "/big") {
        res.writeHead(200).end("x".repeat(2048));
      } else if (req.url === "/hop") {
        res.writeHead(301, { location: "/ok" }).end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" }).end("hello");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("rejects loopback by default", async () => {
    const fetcher = createSafeFetch();
    await expect(fetcher(`${base}/ok`)).rejects.toSatisfy((e) => isMakeMcpError(e, "FETCH_BLOCKED"));
  });

  it("rejects hostnames resolving to loopback by default", async () => {
    const fetcher = createSafeFetch();
    await expect(fetcher(base.replace("127.0.0.1", "localhost") + "/ok")).rejects.toSatisfy((e) =>
      isMakeMcpError(e, "FETCH_BLOCKED"),
    );
  });

  it("rejects non-http protocols and metadata hostnames", async () => {
    const fetcher = createSafeFetch({ allowPrivateNetworks: true });
    await expect(fetcher("file:///etc/passwd")).rejects.toSatisfy((e) => isMakeMcpError(e, "FETCH_BLOCKED"));
    await expect(fetcher("http://metadata.google.internal/")).rejects.toSatisfy((e) =>
      isMakeMcpError(e, "FETCH_BLOCKED"),
    );
  });

  it("follows redirects within policy", async () => {
    const fetcher = createSafeFetch({ allowPrivateNetworks: true });
    const res = await fetcher(`${base}/hop`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello");
    expect(res.url).toBe(`${base}/ok`);
  });

  it("blocks redirects to the metadata address even when private networks are allowed", async () => {
    const fetcher = createSafeFetch({ allowPrivateNetworks: true });
    await expect(fetcher(`${base}/redirect-to-metadata`)).rejects.toSatisfy((e) => isMakeMcpError(e, "FETCH_BLOCKED"));
  });

  it("enforces the size limit", async () => {
    const fetcher = createSafeFetch({ allowPrivateNetworks: true, maxBytes: 1024 });
    await expect(fetcher(`${base}/big`)).rejects.toSatisfy((e) => isMakeMcpError(e, "FETCH_TOO_LARGE"));
  });
});

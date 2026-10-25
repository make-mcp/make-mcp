import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createLlmFromEnv, isMakeMcpError, zipProject, type Fetchers } from "@make-mcp/core";
import { IntakeSessions, SERVER_VERSION } from "@make-mcp/mcp-server";

/**
 * Local web UI: the same intake flow as the coding-agent plugin, in a browser. Binds to 127.0.0.1 by default
 * and requires a random token on every API call, so other sites in the browser (CSRF, DNS rebinding) cannot
 * drive it. API extraction needs an LLM from the environment (see `make-mcp --help`).
 */

export interface UiOptions {
  fetchers: Fetchers;
  workspace: string;
  host?: string;
  port?: number;
  /** Running in the published Docker image: paths in registrations would point into the container. */
  container?: boolean;
  /** Fixed token (tests); random otherwise. */
  token?: string;
}

export interface UiServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;
const page = () => readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

const str = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || !value) throw new HttpError(400, `missing ${key}`);
  return value;
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/html; charset=utf-8" : body instanceof Uint8Array ? "application/zip" : "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(payload);
}

export async function startUi(options: UiOptions): Promise<UiServer> {
  const token = options.token ?? randomBytes(24).toString("hex");
  const sessions = new IntakeSessions(options.fetchers, options.workspace);
  const llm = createLlmFromEnv();
  const expected = Buffer.from(token);
  const tokenOk = (value: string | null | undefined) => {
    if (typeof value !== "string") return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const api: Record<string, (body: Record<string, unknown>) => unknown> = {
    info: () => ({ version: SERVER_VERSION, workspace: options.workspace, llm: llm?.label ?? null, container: options.container ?? false }),
    detect: (b) => sessions.detect(str(b, "target")),
    answer: (b) => {
      const answers = b.answers ?? {};
      if (typeof answers !== "object" || Array.isArray(answers) || Object.values(answers).some((v) => typeof v !== "string")) {
        throw new HttpError(400, "answers must map question ids to strings");
      }
      return sessions.answer(str(b, "sessionId"), answers as Record<string, string>);
    },
    preview: (b) => sessions.preview(str(b, "sessionId")),
    extract: (b) => {
      if (!llm) throw new HttpError(409, "No LLM configured. Set ANTHROPIC_API_KEY, or MAKE_MCP_LLM_BASE_URL + MAKE_MCP_LLM_MODEL, and restart make-mcp ui.");
      return sessions.extractWithLlm(str(b, "sessionId"), llm);
    },
    generate: (b) => sessions.generate(str(b, "sessionId")),
    test: (b) => sessions.test({ sessionId: str(b, "sessionId") }),
    register: (b) => {
      if (options.container) throw new HttpError(409, "Registration is not available inside the container – the paths would point into it.");
      return sessions.register(str(b, "sessionId"), {
        client: b.client === "cursor" ? "cursor" : "claude-code",
        ...(b.scope === "global" || b.scope === "project" ? { scope: b.scope } : {}),
        apply: b.apply === true,
      });
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, page(), {
          "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
        });
      }
      if (req.method === "GET" && url.pathname === "/api/zip") {
        if (!tokenOk(url.searchParams.get("t"))) throw new HttpError(401, "invalid token");
        const project = sessions.project(url.searchParams.get("session") ?? "");
        return send(res, 200, zipProject(project), { "content-disposition": `attachment; filename="${project.manifest.name}-mcp.zip"` });
      }
      const name = url.pathname.startsWith("/api/") ? url.pathname.slice(5) : "";
      const handler = Object.hasOwn(api, name) ? api[name] : undefined;
      if (req.method !== "POST" || !handler) throw new HttpError(404, "not found");
      if (!tokenOk(req.headers["x-make-mcp-token"] as string | undefined)) throw new HttpError(401, "invalid token");
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, "cross-origin request");
      return send(res, 200, (await handler(await readJson(req))) ?? {});
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: "HTTP", message: err.message });
      if (isMakeMcpError(err)) return send(res, 422, { error: err.code, message: err.message, ...err.details });
      process.stderr.write(`ui error: ${(err as Error).stack ?? String(err)}\n`);
      return send(res, 500, { error: "INTERNAL", message: (err as Error).message });
    }
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${options.port ?? 4321} is in use – choose another with --port.`) : err),
    );
    server.listen(options.port ?? 4321, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return {
    url: `http://${shownHost}:${port}/#t=${token}`,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

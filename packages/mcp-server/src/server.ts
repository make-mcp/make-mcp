import { createFetchers, isMakeMcpError, type Fetchers } from "@make-mcp/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { z } from "zod";
import { IntakeSessions } from "./sessions.js";

export const SERVER_VERSION = "0.4.0";
const log = pino({ name: "make-mcp", level: process.env.LOG_LEVEL ?? "info" }, pino.destination(2));

const FLOW = `Workflow (follow it in order, talk to the user in their language):
1. detect_context with the target the user named and workspace = absolute path of the user's project.
2. For each question from detect_context/submit_answers: ask the user with your native question UI (max 4 at once),
   pre-select the "default" option, allow free text where allowFreeText is true. Never invent answers.
3. submit_answers with the user's choices (option value or label). Repeat 2–3 until no questions remain.
4. preview_plan and show the summary verbatim. Wait for an explicit "yes" before continuing.
4b. Only if preview_plan says the API must be extracted from the documentation: call extract_api, read the returned
   pages yourself and answer with JSON exactly as its instructions and schema say (quote the page verbatim, never
   invent operations), then submit_extraction. Repeat for every task. Show the user the accepted operations.
5. generate_server, then test_server. Report the tools and any warnings.
6. register_server without apply first, show the user the diff; only call it with apply=true after they agree.`;

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

function failure(err: unknown): CallToolResult {
  if (isMakeMcpError(err)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.code, message: err.message, ...err.details }, null, 2) }], isError: true };
  }
  log.error({ err }, "unexpected error");
  return { content: [{ type: "text", text: `Unexpected error: ${(err as Error).message}` }], isError: true };
}

/** Wraps a tool handler: JSON result on success, structured error otherwise. */
const tool =
  <A>(run: (args: A) => unknown) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      const result = await run(args);
      return result && typeof result === "object" && "content" in result ? (result as CallToolResult) : json(result);
    } catch (err) {
      return failure(err);
    }
  };

export interface ServerOptions {
  fetchers?: Fetchers;
  /** Default workspace for detect_context; the agent usually starts the server in the project root. */
  defaultWorkspace?: string;
}

export function createMakeMcpServer(options: ServerOptions = {}): McpServer {
  const sessions = new IntakeSessions(options.fetchers ?? createFetchers(), options.defaultWorkspace);
  const server = new McpServer({ name: "make-mcp", version: SERVER_VERSION }, { instructions: FLOW });

  server.registerTool(
    "detect_context",
    {
      title: "Detect target",
      description:
        "Step 1. Detects everything that can be found automatically about the target (installed version, license, repository, docs, llms.txt, OpenAPI) and returns the questions that still need the user's input.",
      inputSchema: {
        target: z.string().min(1).describe("Package name, product name or URL (docs, llms.txt or OpenAPI spec)"),
        workspace: z.string().optional().describe("Absolute path of the user's project (recommended; defaults to the server's working directory)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ target, workspace }: { target: string; workspace?: string }) => {
      const result = await sessions.detect(target, workspace);
      log.info({ target, session: result.sessionId }, "detected context");
      return result;
    }),
  );

  server.registerTool(
    "submit_answers",
    {
      title: "Submit answers",
      description: "Step 3. Stores the user's answers (question id → option value, label or free text) and returns remaining questions.",
      inputSchema: {
        sessionId: z.string(),
        answers: z.record(z.string(), z.string()).describe('e.g. {"mode": "docs", "register": "project"}'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(({ sessionId, answers }: { sessionId: string; answers: Record<string, string> }) => sessions.answer(sessionId, answers)),
  );

  server.registerTool(
    "preview_plan",
    {
      title: "Preview plan",
      description: "Step 4. Summarises what will be generated. Show it to the user and get explicit confirmation before generate_server.",
      inputSchema: { sessionId: z.string() },
      annotations: { readOnlyHint: true },
    },
    tool(({ sessionId }: { sessionId: string }) => {
      const { summary, needsExtraction } = sessions.preview(sessionId);
      const next = needsExtraction
        ? "Ask the user to confirm. Then extract the API: extract_api → submit_extraction for every task → generate_server."
        : "Ask the user to confirm before calling generate_server.";
      return { content: [{ type: "text", text: `${summary}\n\n${next}` }] };
    }),
  );

  server.registerTool(
    "extract_api",
    {
      title: "Extract API from docs",
      description:
        "Step 4b (only when preview_plan asks for it). Returns one batch of documentation pages plus instructions and a JSON schema. Read the pages, extract the HTTP operations yourself and pass the JSON to submit_extraction.",
      inputSchema: { sessionId: z.string(), taskId: z.string().optional().describe("Defaults to the next unfinished task") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ sessionId, taskId }: { sessionId: string; taskId?: string }) => {
      const result = await sessions.extractionTask(sessionId, taskId);
      return result.done ? { ...result, next: "Show the accepted operations to the user, then call generate_server." } : result;
    }),
  );

  server.registerTool(
    "submit_extraction",
    {
      title: "Submit extracted API",
      description:
        "Step 4b. Stores your JSON for one extract_api task. Every operation is checked against the quoted page; invented ones are rejected. Returns the accepted operations and what is left.",
      inputSchema: {
        sessionId: z.string(),
        taskId: z.string(),
        result: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("JSON object (or string) matching the schema from extract_api"),
      },
      annotations: { readOnlyHint: true },
    },
    tool(({ sessionId, taskId, result }: { sessionId: string; taskId: string; result: string | Record<string, unknown> }) => {
      const summary = sessions.submitExtraction(sessionId, taskId, result);
      const next = summary.remainingTasks[0];
      return { ...summary, next: next ? `Call extract_api for task ${next}.` : "Show the accepted operations to the user, then call generate_server." };
    }),
  );

  server.registerTool(
    "generate_server",
    {
      title: "Generate server",
      description: "Step 5. Fetches sources and writes the MCP server to the output directory. Only call after the user confirmed preview_plan.",
      inputSchema: {
        sessionId: z.string(),
        zip: z.boolean().optional().describe("Also write <outDir>.zip"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool(async ({ sessionId, zip }: { sessionId: string; zip?: boolean }) => {
      const result = await sessions.generate(sessionId, { zip: zip ?? false });
      return { ...result, next: "Call test_server, then register_server." };
    }),
  );

  server.registerTool(
    "test_server",
    {
      title: "Test generated server",
      description: "Step 5b. Installs dependencies, builds and starts the generated server, lists its tools and runs a smoke call.",
      inputSchema: { sessionId: z.string().optional(), dir: z.string().optional().describe("Generated server directory (if no session)") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool(async (args: { sessionId?: string; dir?: string }) => {
      const result = await sessions.test(args);
      return { ...json(result), ...(result.ok ? {} : { isError: true }) };
    }),
  );

  server.registerTool(
    "register_server",
    {
      title: "Register with coding agent",
      description:
        "Step 6. Without apply: returns the config diff (project scope) or the command to run (global scope). With apply=true: writes the project config. Only apply after the user agreed to the diff.",
      inputSchema: {
        sessionId: z.string(),
        client: z.enum(["claude-code", "cursor"]).default("claude-code"),
        scope: z.enum(["project", "global"]).optional().describe("Defaults to the intake answer"),
        apply: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    tool(({ sessionId, client, scope, apply }: { sessionId: string; client: "claude-code" | "cursor"; scope?: "project" | "global"; apply: boolean }) =>
      sessions.register(sessionId, { client, ...(scope ? { scope } : {}), apply }),
    ),
  );

  server.registerPrompt(
    "create_mcp",
    {
      title: "Create an MCP server",
      description: "Guided creation of an MCP server for a library, product or API",
      argsSchema: { target: z.string().describe("What the MCP server should be for, e.g. daisyui or an OpenAPI URL") },
    },
    ({ target }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Create an MCP server for "${target}" with the make-mcp tools.\n\n${FLOW}` } }],
    }),
  );

  return server;
}

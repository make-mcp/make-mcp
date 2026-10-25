import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  applyRegistration,
  applySourceAnswers,
  createFetchers,
  detectContext,
  EXTRACTION_INSTRUCTIONS,
  ExtractionResultSchema,
  extractionJsonSchema,
  finishExtraction,
  parseModelJson,
  startExtraction,
  MakeMcpError,
  generateProject,
  isMakeMcpError,
  nextQuestions,
  normalizeAnswers,
  planRegistration,
  resolveIntake,
  summarizeIntake,
  writeProject,
  zipProject,
  type ApiSpec,
  type DocCorpus,
  type ExtractionPlan,
  type ExtractionResult,
  type Fetchers,
  type Findings,
  type GeneratedProject,
  type IntakeAnswers,
  type ResolvedIntake,
} from "@make-mcp/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { z } from "zod";
import { testServer } from "./test-server.js";

export const SERVER_VERSION = "0.2.0";
const log = pino({ name: "make-mcp", level: process.env.LOG_LEVEL ?? "info" }, pino.destination(2));

interface Session {
  id: string;
  findings: Findings;
  answers: IntakeAnswers;
  resolved?: ResolvedIntake;
  project?: GeneratedProject;
  extraction?: { corpus: DocCorpus; plan: ExtractionPlan; results: Map<string, ExtractionResult>; spec?: ApiSpec };
}

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

function findingsView(f: Findings) {
  return {
    target: f.target,
    package: f.packageName ? `${f.registry}:${f.packageName}` : undefined,
    kind: f.kind,
    version: f.version,
    license: f.license?.value,
    repository: f.repositoryUrl?.value,
    repoTag: f.repoTag,
    docsSources: f.docsCandidates.map((d) => `${d.kind}: ${d.url}${d.ref ? ` @ ${d.ref}` : ""}`),
    openapi: f.openapi,
    mode: f.mode,
    language: f.language,
    notes: f.notes,
  };
}

export interface ServerOptions {
  fetchers?: Fetchers;
  /** Default workspace for detect_context; the agent usually starts the server in the project root. */
  defaultWorkspace?: string;
}

export function createMakeMcpServer(options: ServerOptions = {}): McpServer {
  const fetchers = options.fetchers ?? createFetchers();
  const sessions = new Map<string, Session>();
  const server = new McpServer({ name: "make-mcp", version: SERVER_VERSION }, { instructions: FLOW });

  const session = (id: string): Session => {
    const found = sessions.get(id);
    if (!found) throw new MakeMcpError("SESSION_NOT_FOUND", `Unknown sessionId ${id}; call detect_context first.`);
    return found;
  };

  const questionsFor = (s: Session) => nextQuestions(s.findings, s.answers);

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
    async ({ target, workspace }) => {
      try {
        const findings = await detectContext({ target, workspaceRoot: workspace ?? options.defaultWorkspace ?? process.cwd(), ...fetchers });
        const s: Session = { id: randomUUID(), findings, answers: {} };
        sessions.set(s.id, s);
        log.info({ target, session: s.id }, "detected context");
        return json({ sessionId: s.id, findings: findingsView(findings), questions: questionsFor(s) });
      } catch (err) {
        return failure(err);
      }
    },
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
    async ({ sessionId, answers }) => {
      try {
        const s = session(sessionId);
        s.answers = normalizeAnswers(s.findings, s.answers, answers);
        if (answers.docsSource || answers.codeSource) s.findings = await applySourceAnswers(s.findings, s.answers, fetchers);
        s.resolved = undefined;
        const questions = questionsFor(s);
        return json({ answers: s.answers, questions, ready: questions.length === 0, notes: s.findings.notes });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "preview_plan",
    {
      title: "Preview plan",
      description: "Step 4. Summarises what will be generated. Show it to the user and get explicit confirmation before generate_server.",
      inputSchema: { sessionId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId }) => {
      try {
        const s = session(sessionId);
        s.resolved = resolveIntake(s.findings, s.answers);
        const next =
          s.resolved.apiSource === "docs"
            ? "Ask the user to confirm. Then extract the API: extract_api → submit_extraction for every task → generate_server."
            : "Ask the user to confirm before calling generate_server.";
        return { content: [{ type: "text", text: `${summarizeIntake(s.resolved)}\n\n${next}` }] };
      } catch (err) {
        return failure(err);
      }
    },
  );

  const extractionSummary = (s: Session, resolved: ResolvedIntake) => {
    const extraction = s.extraction!;
    const { spec, validated } = finishExtraction(resolved, extraction.corpus, [...extraction.results.values()]);
    extraction.spec = spec;
    const remaining = extraction.plan.tasks.filter((t) => !extraction.results.has(t.id)).map((t) => t.id);
    return {
      accepted: spec.endpoints.map((e) => `${e.method.toUpperCase()} ${e.path} – ${e.summary ?? e.id}`),
      rejected: validated.rejected,
      baseUrl: spec.baseUrl || "(not stated in the docs – the user must set it)",
      auth: spec.auth.map((a) => a.type),
      notes: validated.notes,
      remainingTasks: remaining,
      next: remaining.length ? `Call extract_api for task ${remaining[0]}.` : "Show the accepted operations to the user, then call generate_server.",
    };
  };

  server.registerTool(
    "extract_api",
    {
      title: "Extract API from docs",
      description:
        "Step 4b (only when preview_plan asks for it). Returns one batch of documentation pages plus instructions and a JSON schema. Read the pages, extract the HTTP operations yourself and pass the JSON to submit_extraction.",
      inputSchema: { sessionId: z.string(), taskId: z.string().optional().describe("Defaults to the next unfinished task") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sessionId, taskId }) => {
      try {
        const s = session(sessionId);
        const resolved = (s.resolved ??= resolveIntake(s.findings, s.answers));
        if (resolved.apiSource !== "docs") throw new MakeMcpError("INTAKE_INCOMPLETE", "This target has an OpenAPI spec; no extraction needed.");
        if (!s.extraction) {
          const { corpus, plan } = await startExtraction(resolved, fetchers);
          s.extraction = { corpus, plan, results: new Map() };
          log.info({ session: s.id, tasks: plan.tasks.length, pages: corpus.pages.length }, "extraction planned");
        }
        const { plan, results } = s.extraction;
        const task = taskId ? plan.tasks.find((t) => t.id === taskId) : plan.tasks.find((t) => !results.has(t.id));
        if (!task) {
          if (taskId) throw new MakeMcpError("INTAKE_INCOMPLETE", `Unknown taskId ${taskId}`);
          return json({ done: true, ...extractionSummary(s, resolved) });
        }
        return json({
          taskId: task.id,
          task: `${plan.tasks.indexOf(task) + 1} of ${plan.tasks.length}`,
          ...(plan.skippedPages ? { skippedPages: plan.skippedPages } : {}),
          instructions: EXTRACTION_INSTRUCTIONS,
          schema: extractionJsonSchema(),
          pages: task.pages,
        });
      } catch (err) {
        return failure(err);
      }
    },
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
    async ({ sessionId, taskId, result }) => {
      try {
        const s = session(sessionId);
        if (!s.extraction || !s.resolved) throw new MakeMcpError("INTAKE_INCOMPLETE", "Call extract_api first.");
        if (!s.extraction.plan.tasks.some((t) => t.id === taskId)) throw new MakeMcpError("INTAKE_INCOMPLETE", `Unknown taskId ${taskId}`);
        const parsed = ExtractionResultSchema.safeParse(typeof result === "string" ? parseModelJson(result) : result);
        if (!parsed.success) {
          throw new MakeMcpError(
            "SPEC_INVALID",
            `Result does not match the schema: ${parsed.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          );
        }
        s.extraction.results.set(taskId, parsed.data);
        s.project = undefined;
        return json(extractionSummary(s, s.resolved));
      } catch (err) {
        return failure(err);
      }
    },
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
    async ({ sessionId, zip }) => {
      try {
        const s = session(sessionId);
        const resolved = s.resolved ?? resolveIntake(s.findings, s.answers);
        if (resolved.apiSource === "docs" && !s.extraction?.spec) {
          throw new MakeMcpError("INTAKE_INCOMPLETE", "Extract the API first: extract_api → submit_extraction for every task.");
        }
        const project = await generateProject(resolved, {
          ...fetchers,
          workspaceRoot: s.findings.workspaceRoot,
          ...(s.extraction?.spec ? { extractedApi: s.extraction.spec, corpus: s.extraction.corpus } : {}),
        });
        const files = writeProject(project);
        if (zip) writeFileSync(`${project.outDir}.zip`, zipProject(project));
        s.project = project;
        return json({
          outDir: project.outDir,
          files,
          ...(zip ? { zip: `${project.outDir}.zip` } : {}),
          tools: project.tools,
          docPages: project.pageCount,
          endpoints: project.endpointCount,
          contentMode: project.manifest.docs?.contentMode,
          envVars: project.envVars,
          warnings: project.warnings,
          next: "Call test_server, then register_server.",
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "test_server",
    {
      title: "Test generated server",
      description: "Step 5b. Installs dependencies, builds and starts the generated server, lists its tools and runs a smoke call.",
      inputSchema: { sessionId: z.string().optional(), dir: z.string().optional().describe("Generated server directory (if no session)") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ sessionId, dir }) => {
      try {
        const target = dir ?? (sessionId ? session(sessionId).project?.outDir : undefined);
        if (!target) throw new MakeMcpError("INTAKE_INCOMPLETE", "Pass dir, or a sessionId after generate_server.");
        const result = await testServer(target, fetchers);
        return { ...json(result), ...(result.ok ? {} : { isError: true }) };
      } catch (err) {
        return failure(err);
      }
    },
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
    async ({ sessionId, client, scope, apply }) => {
      try {
        const s = session(sessionId);
        if (!s.project) throw new MakeMcpError("INTAKE_INCOMPLETE", "Call generate_server first.");
        const effectiveScope = scope ?? (s.resolved?.register === "global" ? "global" : "project");
        const plan = planRegistration({
          workspaceRoot: s.findings.workspaceRoot,
          name: s.project.manifest.name,
          run: s.project.run,
          envVars: s.project.envVars,
          scope: effectiveScope,
          client,
        });
        if (apply && plan.file) {
          applyRegistration(plan);
          return json({ applied: true, file: plan.file, replacedExisting: plan.replacesExisting, envVars: s.project.envVars.filter((v) => v.secret) });
        }
        return json({ applied: false, ...plan });
      } catch (err) {
        return failure(err);
      }
    },
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

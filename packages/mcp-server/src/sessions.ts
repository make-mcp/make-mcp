import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  applyRegistration,
  applySourceAnswers,
  catalogAnswers,
  detectContext,
  EXTRACTION_INSTRUCTIONS,
  ExtractionResultSchema,
  extractionJsonSchema,
  finishExtraction,
  generateProject,
  MakeMcpError,
  nextQuestions,
  normalizeAnswers,
  parseModelJson,
  planRegistration,
  resolveIntake,
  runExtraction,
  startExtraction,
  summarizeIntake,
  writeProject,
  zipProject,
  type AgentClient,
  type ApiSpec,
  type DocCorpus,
  type ExtractionPlan,
  type ExtractionResult,
  type Fetchers,
  type Findings,
  type GeneratedProject,
  type IntakeAnswers,
  type LlmClient,
  type Question,
  type ResolvedIntake,
} from "@make-mcp/core";
import { testServer, type ServerTestResult } from "./test-server.js";

/**
 * The intake → extraction → generation flow as plain methods. The MCP tools and the local web UI are thin
 * wrappers around it, so both behave identically. Methods throw MakeMcpError for anything the caller should show.
 */

interface Session {
  id: string;
  findings: Findings;
  answers: IntakeAnswers;
  resolved?: ResolvedIntake;
  project?: GeneratedProject;
  extraction?: { corpus: DocCorpus; plan: ExtractionPlan; results: Map<string, ExtractionResult>; spec?: ApiSpec };
}

export interface FindingsView {
  target: string;
  package: string | undefined;
  kind: Findings["kind"];
  version: Findings["version"];
  license: string | undefined;
  repository: string | undefined;
  repoTag: string | undefined;
  docsSources: string[];
  catalog: string | undefined;
  openapi: Findings["openapi"];
  mode: Findings["mode"];
  language: Findings["language"];
  notes: string[];
}

export function findingsView(f: Findings): FindingsView {
  return {
    target: f.target,
    package: f.packageName ? `${f.registry}:${f.packageName}` : undefined,
    kind: f.kind,
    version: f.version,
    license: f.license?.value,
    repository: f.repositoryUrl?.value,
    repoTag: f.repoTag,
    docsSources: f.docsCandidates.map((d) => `${d.kind}: ${d.url}${d.ref ? ` @ ${d.ref}` : ""}`),
    catalog: f.catalog ? `${f.catalog.name} (community catalog, maintained by ${f.catalog.maintainers.join(", ")})` : undefined,
    openapi: f.openapi,
    mode: f.mode,
    language: f.language,
    notes: f.notes,
  };
}

export interface DetectResult {
  sessionId: string;
  findings: FindingsView;
  questions: Question[];
}

export interface AnswerResult {
  answers: IntakeAnswers;
  questions: Question[];
  ready: boolean;
  notes: string[];
}

export interface PreviewResult {
  summary: string;
  needsExtraction: boolean;
}

export interface ExtractionSummary {
  accepted: string[];
  rejected: { method: string; path: string; reason: string }[];
  baseUrl: string;
  auth: string[];
  notes: string[];
  remainingTasks: string[];
}

export interface GenerateResult {
  outDir: string;
  files: string[];
  zip?: string;
  tools: string[];
  docPages: number;
  endpoints: number;
  contentMode?: string;
  envVars: GeneratedProject["envVars"];
  warnings: string[];
}

export class IntakeSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly fetchers: Fetchers;
  private readonly defaultWorkspace: string | undefined;

  constructor(fetchers: Fetchers, defaultWorkspace?: string) {
    this.fetchers = fetchers;
    this.defaultWorkspace = defaultWorkspace;
  }

  private get(id: string): Session {
    const found = this.sessions.get(id);
    if (!found) throw new MakeMcpError("SESSION_NOT_FOUND", `Unknown sessionId ${id}; call detect_context first.`);
    return found;
  }

  private resolved(s: Session): ResolvedIntake {
    return (s.resolved ??= resolveIntake(s.findings, s.answers));
  }

  async detect(target: string, workspace?: string): Promise<DetectResult> {
    const findings = await detectContext({ target, workspaceRoot: workspace ?? this.defaultWorkspace ?? process.cwd(), ...this.fetchers });
    const s: Session = { id: randomUUID(), findings, answers: catalogAnswers(findings, {}) };
    this.sessions.set(s.id, s);
    return { sessionId: s.id, findings: findingsView(findings), questions: nextQuestions(findings, s.answers) };
  }

  async answer(sessionId: string, raw: Record<string, string>): Promise<AnswerResult> {
    const s = this.get(sessionId);
    s.answers = normalizeAnswers(s.findings, s.answers, raw);
    if (raw.docsSource || raw.codeSource) s.findings = await applySourceAnswers(s.findings, s.answers, this.fetchers);
    s.resolved = undefined;
    s.extraction = undefined;
    s.project = undefined;
    const questions = nextQuestions(s.findings, s.answers);
    return { answers: s.answers, questions, ready: questions.length === 0, notes: s.findings.notes };
  }

  preview(sessionId: string): PreviewResult {
    const s = this.get(sessionId);
    s.resolved = resolveIntake(s.findings, s.answers);
    return { summary: summarizeIntake(s.resolved), needsExtraction: s.resolved.apiSource === "docs" };
  }

  private async ensureExtraction(s: Session): Promise<NonNullable<Session["extraction"]>> {
    const resolved = this.resolved(s);
    if (resolved.apiSource !== "docs") throw new MakeMcpError("INTAKE_INCOMPLETE", "This target has an OpenAPI spec; no extraction needed.");
    if (!s.extraction) {
      const { corpus, plan } = await startExtraction(resolved, this.fetchers);
      s.extraction = { corpus, plan, results: new Map() };
    }
    return s.extraction;
  }

  private summary(s: Session): ExtractionSummary {
    const extraction = s.extraction!;
    const { spec, validated } = finishExtraction(this.resolved(s), extraction.corpus, [...extraction.results.values()]);
    extraction.spec = spec;
    return {
      accepted: spec.endpoints.map((e) => `${e.method.toUpperCase()} ${e.path} – ${e.summary ?? e.id}`),
      rejected: validated.rejected,
      baseUrl: spec.baseUrl || "(not stated in the docs – the user must set it)",
      auth: spec.auth.map((a) => a.type),
      notes: validated.notes,
      remainingTasks: extraction.plan.tasks.filter((t) => !extraction.results.has(t.id)).map((t) => t.id),
    };
  }

  /** Next (or given) batch of pages for the agent's own model. */
  async extractionTask(sessionId: string, taskId?: string) {
    const s = this.get(sessionId);
    const { plan, results } = await this.ensureExtraction(s);
    const task = taskId ? plan.tasks.find((t) => t.id === taskId) : plan.tasks.find((t) => !results.has(t.id));
    if (!task) {
      if (taskId) throw new MakeMcpError("INTAKE_INCOMPLETE", `Unknown taskId ${taskId}`);
      return { done: true as const, ...this.summary(s) };
    }
    return {
      done: false as const,
      taskId: task.id,
      task: `${plan.tasks.indexOf(task) + 1} of ${plan.tasks.length}`,
      ...(plan.skippedPages ? { skippedPages: plan.skippedPages } : {}),
      instructions: EXTRACTION_INSTRUCTIONS,
      schema: extractionJsonSchema(),
      pages: task.pages,
    };
  }

  submitExtraction(sessionId: string, taskId: string, result: string | Record<string, unknown>): ExtractionSummary {
    const s = this.get(sessionId);
    if (!s.extraction) throw new MakeMcpError("INTAKE_INCOMPLETE", "Call extract_api first.");
    if (!s.extraction.plan.tasks.some((t) => t.id === taskId)) throw new MakeMcpError("INTAKE_INCOMPLETE", `Unknown taskId ${taskId}`);
    const parsed = ExtractionResultSchema.safeParse(typeof result === "string" ? parseModelJson(result) : result);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new MakeMcpError("SPEC_INVALID", `Result does not match the schema: ${issues}`);
    }
    s.extraction.results.set(taskId, parsed.data);
    s.project = undefined;
    return this.summary(s);
  }

  /** Runs all batches through a configured model (web UI and CLI, where no agent is involved). */
  async extractWithLlm(sessionId: string, llm: LlmClient, onTask?: (index: number, total: number) => void): Promise<ExtractionSummary & { pages: number }> {
    const s = this.get(sessionId);
    const extraction = await this.ensureExtraction(s);
    const results = await runExtraction(extraction.plan, llm, onTask ? { onTask } : {});
    extraction.plan.tasks.forEach((t, i) => {
      const result = results[i];
      if (result) extraction.results.set(t.id, result);
    });
    return { ...this.summary(s), pages: extraction.plan.tasks.reduce((n, t) => n + t.pages.length, 0) };
  }

  async generate(sessionId: string, options: { zip?: boolean; outDir?: string } = {}): Promise<GenerateResult> {
    const s = this.get(sessionId);
    let resolved = this.resolved(s);
    if (options.outDir) resolved = s.resolved = { ...resolved, outDir: options.outDir };
    if (resolved.apiSource === "docs" && !s.extraction?.spec) {
      throw new MakeMcpError("INTAKE_INCOMPLETE", "Extract the API first: extract_api → submit_extraction for every task.");
    }
    const project = await generateProject(resolved, {
      ...this.fetchers,
      workspaceRoot: s.findings.workspaceRoot,
      ...(s.extraction?.spec ? { extractedApi: s.extraction.spec, corpus: s.extraction.corpus } : {}),
    });
    const files = writeProject(project);
    if (options.zip) writeFileSync(`${project.outDir}.zip`, zipProject(project));
    s.project = project;
    return {
      outDir: project.outDir,
      files,
      ...(options.zip ? { zip: `${project.outDir}.zip` } : {}),
      tools: project.tools,
      docPages: project.pageCount,
      endpoints: project.endpointCount,
      ...(project.manifest.docs?.contentMode ? { contentMode: project.manifest.docs.contentMode } : {}),
      envVars: project.envVars,
      warnings: project.warnings,
    };
  }

  /** The generated project in memory, e.g. to stream it as a ZIP download. */
  project(sessionId: string): GeneratedProject {
    const project = this.get(sessionId).project;
    if (!project) throw new MakeMcpError("INTAKE_INCOMPLETE", "Call generate_server first.");
    return project;
  }

  async test(target: { sessionId?: string; dir?: string }): Promise<ServerTestResult> {
    const dir = target.dir ?? (target.sessionId ? this.get(target.sessionId).project?.outDir : undefined);
    if (!dir) throw new MakeMcpError("INTAKE_INCOMPLETE", "Pass dir, or a sessionId after generate_server.");
    return testServer(dir, this.fetchers);
  }

  register(sessionId: string, options: { client: AgentClient; scope?: "project" | "global"; apply: boolean }) {
    const s = this.get(sessionId);
    const project = this.project(sessionId);
    const scope = options.scope ?? (s.resolved?.register === "global" ? "global" : "project");
    const plan = planRegistration({
      workspaceRoot: s.findings.workspaceRoot,
      name: project.manifest.name,
      run: project.run,
      envVars: project.envVars,
      scope,
      client: options.client,
    });
    if (options.apply && plan.file) {
      applyRegistration(plan);
      return { applied: true, file: plan.file, replacedExisting: plan.replacesExisting, envVars: project.envVars.filter((v) => v.secret || v.required) };
    }
    return { applied: false, ...plan };
  }
}

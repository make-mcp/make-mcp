import { MakeMcpError } from "../errors.js";
import { contentModeFor } from "../license.js";
import { defaultOutDir, effectiveMode, nextQuestions } from "./questions.js";
import type { Findings, IntakeAnswers, ResolvedIntake } from "./types.js";

export interface ResolveOptions {
  /** Fill open questions with their defaults (non-interactive `--yes`). */
  useDefaults?: boolean;
}

export function envPrefixFor(slug: string): string {
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "API";
}

export function resolveIntake(findings: Findings, answers: IntakeAnswers, options: ResolveOptions = {}): ResolvedIntake {
  const open = nextQuestions(findings, answers, Infinity);
  const filled: IntakeAnswers = { ...answers };
  const missing: string[] = [];
  for (const q of open) {
    if (options.useDefaults && q.default !== undefined) (filled as Record<string, string>)[q.id] = q.default;
    else missing.push(q.id);
  }
  if (missing.length > 0) {
    throw new MakeMcpError("INTAKE_INCOMPLETE", `Open questions: ${missing.join(", ")}`, { missing });
  }

  const mode = effectiveMode(findings, filled);
  const needsDocs = mode !== "api";
  const needsApi = mode !== "docs";
  if (needsDocs && findings.docsCandidates.length === 0) {
    throw new MakeMcpError("SOURCE_NOT_FOUND", `No documentation source found for ${findings.target}`, { missing: ["docsSource"] });
  }
  const extractApi = needsApi && !findings.openapi && findings.docsCandidates.length > 0 && filled.docsSource !== "none";
  if (needsApi && !findings.openapi && !extractApi) {
    throw new MakeMcpError("SOURCE_NOT_FOUND", `No OpenAPI/Swagger spec and no documentation found for ${findings.target}.`, {
      missing: ["docsSource"],
    });
  }

  const scopeTags =
    filled.scope && filled.scope !== "all"
      ? filled.scope
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

  return {
    target: findings.target,
    slug: findings.slug,
    envPrefix: envPrefixFor(findings.slug),
    mode,
    version: filled.version ?? findings.version?.value ?? "latest",
    ...(findings.license ? { license: findings.license.value } : {}),
    docs: needsDocs ? findings.docsCandidates : [],
    ...(needsApi && findings.openapi ? { openapiUrl: findings.openapi.url, apiSource: "openapi" as const } : {}),
    ...(extractApi ? { apiSource: "docs" as const, extractionDocs: findings.docsCandidates } : {}),
    auth: filled.auth ?? "none",
    ...(scopeTags ? { scopeTags } : {}),
    language: filled.language ?? findings.language?.value ?? "ts",
    transport: filled.transport ?? "stdio",
    deploy: filled.deploy ?? (filled.transport === "http" ? "cloudrun" : "none"),
    outDir: filled.outDir ?? defaultOutDir(findings),
    register: filled.register ?? "none",
    ...(filled.tools ? { toolMode: filled.tools } : {}),
    ...(findings.repositoryUrl ? { repositoryUrl: findings.repositoryUrl.value } : {}),
    ...(findings.homepage ? { homepage: findings.homepage } : {}),
    ...(findings.description ? { description: findings.description } : {}),
    notes: findings.notes,
  };
}

/** Plain-text summary shown to the user for confirmation before anything is generated. */
export function summarizeIntake(resolved: ResolvedIntake): string {
  const contentMode = contentModeFor(resolved.license);
  const lines = [
    `Target:      ${resolved.target} ${resolved.version}`,
    `Purpose:     ${resolved.mode === "docs" ? "knowledge lookup (docs)" : resolved.mode === "api" ? "API actions" : "docs + API actions"}`,
    ...(resolved.docs[0] ? [`Docs source: ${resolved.docs[0].kind} – ${resolved.docs[0].url}${resolved.docs[0].ref ? ` @ ${resolved.docs[0].ref}` : ""}`] : []),
    ...(resolved.docs.length > 1 ? [`Fallbacks:   ${resolved.docs.slice(1).map((d) => d.kind).join(", ")}`] : []),
    ...(resolved.openapiUrl ? [`API spec:    ${resolved.openapiUrl}`, `Auth:        ${resolved.auth === "none" ? "from spec" : resolved.auth}`] : []),
    ...(resolved.apiSource === "docs"
      ? [`API spec:    extracted from the documentation by an LLM, every operation checked against its source page`]
      : []),
    ...(resolved.scopeTags ? [`Scope:       ${resolved.scopeTags.join(", ")}`] : []),
    ...(resolved.toolMode ? [`API tools:   ${resolved.toolMode === "grouped" ? "grouped (list/describe/call)" : "one per operation"}`] : []),
    `License:     ${resolved.license ?? "unknown"} → docs ${contentMode === "embedded" ? "embedded in the server" : "fetched on first start (not redistributed)"}`,
    `Output:      ${resolved.language === "ts" ? "TypeScript" : "Python"}, ${resolved.transport}, ${resolved.outDir}`,
    `Register:    ${resolved.register}`,
    ...(resolved.deploy === "cloudrun" ? ["Deploy:      Google Cloud Run templates (service.yaml, skaffold.yaml)"] : []),
    ...resolved.notes.map((n) => `Note:        ${n}`),
  ];
  return lines.join("\n");
}

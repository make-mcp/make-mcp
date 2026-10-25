import { MakeMcpError } from "../errors.js";
import { IntakeAnswersSchema, type Findings, type IntakeAnswers, type Mode, type Question, type QuestionId } from "./types.js";

const SCOPE_THRESHOLD = 40;
export const MAX_QUESTIONS_PER_ROUND = 4;

export function effectiveMode(findings: Findings, answers: IntakeAnswers): Mode {
  return answers.mode ?? findings.mode.value;
}

const needsApi = (mode: Mode) => mode === "api" || mode === "both";
const needsDocs = (mode: Mode) => mode === "docs" || mode === "both";

export function defaultOutDir(findings: Findings): string {
  return `mcp-servers/${findings.slug}-mcp`;
}

/** Builds a question when it is still open; returns undefined when it is answered or confidently detected. */
function buildQuestion(id: QuestionId, findings: Findings, answers: IntakeAnswers): Question | undefined {
  if (answers[id] !== undefined) return undefined;
  const mode = effectiveMode(findings, answers);

  switch (id) {
    case "docsSource": {
      const missingDocs = needsDocs(mode) && findings.docsCandidates.length === 0;
      const missingSpec = needsApi(mode) && !findings.openapi;
      if (!missingDocs && !missingSpec) return undefined;
      return {
        id,
        header: missingSpec ? "API spec" : "Docs",
        question: missingSpec
          ? `No OpenAPI/Swagger spec found for ${findings.target}. Where is it (URL)?`
          : `No documentation found for ${findings.target}. Is there documentation (URL to docs, llms.txt or README)?`,
        options: [{ value: "none", label: "None", description: "There is no documentation" }],
        allowFreeText: true,
      };
    }
    case "codeSource": {
      if (findings.repositoryUrl || findings.openapi || findings.docsCandidates.length > 0) return undefined;
      return {
        id,
        header: "Source code",
        question: `Is the source code of ${findings.target} accessible somewhere (repository URL or local path)?`,
        options: [{ value: "none", label: "Not accessible", description: "Closed source or not available" }],
        allowFreeText: true,
      };
    }
    case "version": {
      if (findings.version?.confidence === "high") return undefined;
      const detected = findings.version?.value;
      const options = [
        ...(detected ? [{ value: detected, label: detected, description: `Detected via ${findings.version?.source}` }] : []),
        ...(findings.latestVersion && findings.latestVersion !== detected
          ? [{ value: findings.latestVersion, label: `${findings.latestVersion} (latest)`, description: "Latest published version" }]
          : []),
      ];
      return {
        id,
        header: "Version",
        question: `Which version of ${findings.target} do you use?`,
        options: options.length ? options : [{ value: "latest", label: "Latest", description: "No version detected" }],
        default: detected ?? "latest",
        allowFreeText: true,
      };
    }
    case "mode": {
      if (findings.mode.confidence === "high") return undefined;
      return {
        id,
        header: "Purpose",
        question: `What should the MCP server for ${findings.target} do?`,
        options: [
          { value: "docs", label: "Look up knowledge", description: "Search docs, components, examples (works offline)" },
          { value: "api", label: "Perform actions", description: "Call the API with your credentials" },
          { value: "both", label: "Both", description: "Docs lookup plus API actions" },
        ],
        default: findings.mode.value,
        allowFreeText: false,
      };
    }
    case "auth": {
      if (!needsApi(mode) || (findings.openapi && findings.openapi.authTypes.length > 0)) return undefined;
      return {
        id,
        header: "Auth",
        question: `How does the ${findings.target} API authenticate?`,
        options: [
          { value: "none", label: "None" },
          { value: "apiKey", label: "API key" },
          { value: "bearer", label: "Bearer token" },
          { value: "basic", label: "Basic auth" },
          { value: "oauth2", label: "OAuth2" },
        ],
        default: "none",
        allowFreeText: false,
      };
    }
    case "scope": {
      if (!needsApi(mode) || !findings.openapi || findings.openapi.endpointCount <= SCOPE_THRESHOLD) return undefined;
      return {
        id,
        header: "Scope",
        question: `The API has ${findings.openapi.endpointCount} endpoints. Generate all of them or only some areas (tags, comma-separated)?`,
        options: [
          { value: "all", label: "All endpoints" },
          ...findings.openapi.tags.slice(0, 3).map((tag) => ({ value: tag, label: tag })),
        ],
        default: "all",
        allowFreeText: true,
      };
    }
    case "language": {
      if (findings.language?.confidence === "high") return undefined;
      return {
        id,
        header: "Language",
        question: "Which language should the generated server use?",
        options: [
          { value: "ts", label: "TypeScript", description: "Node.js ≥ 22" },
          { value: "py", label: "Python", description: "Python ≥ 3.11 with uv" },
        ],
        default: findings.language?.value ?? "ts",
        allowFreeText: false,
      };
    }
    case "register": {
      return {
        id,
        header: "Register",
        question: "Register the generated server with your coding agent?",
        options: [
          { value: "project", label: "This project", description: "Writes .mcp.json in the workspace" },
          { value: "global", label: "Globally", description: "Prints the command for your user config" },
          { value: "none", label: "No", description: "Only generate the files" },
        ],
        default: "project",
        allowFreeText: false,
      };
    }
    case "transport":
    case "outDir":
    case "tools":
      return undefined;
  }
}

const ORDER: QuestionId[] = ["docsSource", "codeSource", "version", "mode", "auth", "scope", "language", "register"];

/** Open questions in priority order; only what cannot be detected with confidence. */
export function nextQuestions(findings: Findings, answers: IntakeAnswers, max = MAX_QUESTIONS_PER_ROUND): Question[] {
  return ORDER.map((id) => buildQuestion(id, findings, answers))
    .filter((q): q is Question => q !== undefined)
    .slice(0, max);
}

/**
 * Normalizes raw answers (option labels or values, free text) and validates them.
 * Unknown keys are reported instead of silently dropped.
 */
export function normalizeAnswers(findings: Findings, current: IntakeAnswers, raw: Record<string, string>): IntakeAnswers {
  const merged: Record<string, string> = { ...(current as Record<string, string>) };
  for (const [key, rawValue] of Object.entries(raw)) {
    const value = rawValue.trim();
    const question = buildQuestion(key as QuestionId, findings, { ...current, [key]: undefined });
    const option = question?.options.find((o) => o.value.toLowerCase() === value.toLowerCase() || o.label.toLowerCase() === value.toLowerCase());
    merged[key] = option?.value ?? value;
  }
  const parsed = IntakeAnswersSchema.strict().safeParse(merged);
  if (!parsed.success) {
    throw new MakeMcpError("INTAKE_INCOMPLETE", `Invalid answers: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

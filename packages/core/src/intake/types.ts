import { z } from "zod";
import type { OpenApiProbe } from "../discover/probe.js";
import type { DocsSource } from "../parse/docs-corpus.js";

export type Confidence = "high" | "medium" | "low";

export interface Finding<T> {
  value: T;
  confidence: Confidence;
  /** Human-readable provenance, e.g. "package-lock.json" or "npm registry". */
  source: string;
}

export type TargetKind = "api" | "library" | "unknown";
export type Mode = "docs" | "api" | "both";

export interface Findings {
  target: string;
  slug: string;
  workspaceRoot: string;
  kind: Finding<TargetKind>;
  packageName?: string;
  registry?: "npm" | "pypi";
  description?: string;
  version?: Finding<string>;
  latestVersion?: string;
  license?: Finding<string>;
  repositoryUrl?: Finding<string>;
  repoTag?: string;
  homepage?: string;
  /** Ordered documentation sources; the loader uses the first that yields pages. */
  docsCandidates: DocsSource[];
  openapi?: OpenApiProbe;
  mode: Finding<Mode>;
  language?: Finding<"ts" | "py">;
  /** Things the user should know, e.g. a version mismatch between docs and installed package. */
  notes: string[];
}

export const IntakeAnswersSchema = z
  .object({
    mode: z.enum(["docs", "api", "both"]),
    version: z.string().min(1),
    /** Repository URL, local path or "none". */
    codeSource: z.string().min(1),
    /** Docs/OpenAPI/llms.txt URL or "none". */
    docsSource: z.string().min(1),
    auth: z.enum(["none", "apiKey", "bearer", "basic", "oauth2"]),
    /** Comma-separated tags, or "all". */
    scope: z.string().min(1),
    language: z.enum(["ts", "py"]),
    transport: z.enum(["stdio", "http"]),
    outDir: z.string().min(1),
    register: z.enum(["project", "global", "none"]),
  })
  .partial();
export type IntakeAnswers = z.infer<typeof IntakeAnswersSchema>;
export type QuestionId = keyof IntakeAnswers;

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface Question {
  id: QuestionId;
  /** Max 12 chars, fits chip-style UIs such as Claude Code's AskUserQuestion header. */
  header: string;
  question: string;
  options: QuestionOption[];
  default?: string;
  /** Free text (URL, path, version) is accepted in addition to the options. */
  allowFreeText: boolean;
}

export interface ResolvedIntake {
  target: string;
  slug: string;
  envPrefix: string;
  mode: Mode;
  version: string;
  license?: string;
  docs: DocsSource[];
  openapiUrl?: string;
  auth: NonNullable<IntakeAnswers["auth"]>;
  scopeTags?: string[];
  language: "ts" | "py";
  transport: "stdio" | "http";
  outDir: string;
  register: "project" | "global" | "none";
  repositoryUrl?: string;
  homepage?: string;
  description?: string;
  notes: string[];
}

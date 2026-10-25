export * from "./errors.js";
export * from "./ir/index.js";
export * from "./license.js";
export { createSafeFetch, isBlockedAddress, USER_AGENT, type SafeFetchOptions } from "./fetch/safe-fetch.js";
export { createPoliteFetch, type PoliteFetchOptions } from "./fetch/polite-fetch.js";
export { createFixtureFetch } from "./fetch/fixture-fetch.js";
export type { Fetcher, FetchInit, FetchResult } from "./fetch/types.js";
export { createWorkspace, type Workspace } from "./fs/workspace.js";
export { detectContext, applySourceAnswers, type DetectOptions, type RefineOptions } from "./discover/detect.js";
export * from "./intake/types.js";
export { nextQuestions, normalizeAnswers, effectiveMode, defaultOutDir, MAX_QUESTIONS_PER_ROUND } from "./intake/questions.js";
export { resolveIntake, summarizeIntake, envPrefixFor, type ResolveOptions } from "./intake/resolve.js";
export { loadDocCorpus, type DocsSource, type LoadCorpusOptions } from "./parse/docs-corpus.js";
export { openApiToSpec, parseApiDocument, applyRequestedVersion } from "./parse/openapi.js";
export { splitMarkdown, slugify } from "./parse/markdown-split.js";
export {
  generateProject,
  writeProject,
  zipProject,
  refreshDocs,
  corpusCachePath,
  GENERATOR_PACKAGE,
  GENERATOR_VERSION,
  type GenerateOptions,
  type GeneratedProject,
  type Manifest,
  type EnvVar,
  type RefreshOptions,
} from "./generate/project.js";
export { planRegistration, applyRegistration, type AgentClient, type RegisterInput, type RegistrationPlan } from "./generate/register.js";
export { createFetchers, type Fetchers, type FetcherConfig } from "./fetch/defaults.js";

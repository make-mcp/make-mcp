export * from "./errors.js";
export { VERSION } from "./version.js";
export { isSafeVersion } from "./safe-version.js";
export * from "./ir/index.js";
export * from "./license.js";
export { createSafeFetch, isBlockedAddress, USER_AGENT, type SafeFetchOptions } from "./fetch/safe-fetch.js";
export { createPoliteFetch, type PoliteFetchOptions } from "./fetch/polite-fetch.js";
export { createFixtureFetch } from "./fetch/fixture-fetch.js";
export type { Fetcher, FetchInit, FetchResult } from "./fetch/types.js";
export { createWorkspace, type Workspace } from "./fs/workspace.js";
export {
  detectContext,
  applySourceAnswers,
  expandBundle,
  refineFindings,
  projectDependencies,
  MAX_PROJECT_LIBRARIES,
  type DetectOptions,
  type RefineOptions,
} from "./discover/detect.js";
export { readSignatures, scanTypeDeclarations, scanPythonSource, type SignatureResult, type SignatureTarget } from "./discover/signatures.js";
export { loadChanges, parseChangelog, tagVersion, compareVersions } from "./parse/changes.js";
export * from "./intake/types.js";
export {
  nextQuestions,
  normalizeAnswers,
  effectiveMode,
  defaultOutDir,
  bundleChoice,
  isBundle,
  projectSlug,
  MAX_QUESTIONS_PER_ROUND,
} from "./intake/questions.js";
export { resolveIntake, summarizeIntake, envPrefixFor, type ResolveOptions } from "./intake/resolve.js";
export { loadDocCorpus, type DocsSource, type LoadCorpusOptions } from "./parse/docs-corpus.js";
export { openApiToSpec, parseApiDocument, applyRequestedVersion } from "./parse/openapi.js";
export { splitMarkdown, slugify } from "./parse/markdown-split.js";
export {
  generateProject,
  writeProject,
  zipProject,
  refreshDocs,
  manifestLibraries,
  needsRefresh,
  corpusCachePath,
  cacheRoot,
  insideCache,
  hostPath,
  startExtraction,
  finishExtraction,
  GROUP_THRESHOLD,
  type ExtractionStart,
  GENERATOR_PACKAGE,
  GENERATOR_VERSION,
  type GenerateOptions,
  type GeneratedProject,
  type Manifest,
  type LibraryManifest,
  type ChangesSource,
  type EnvVar,
  type RefreshOptions,
} from "./generate/project.js";
export {
  planExtraction,
  renderTask,
  validateExtraction,
  extractionToSpec,
  extractionJsonSchema,
  parseModelJson,
  canonicalPath,
  ExtractionResultSchema,
  EXTRACTION_INSTRUCTIONS,
  type ExtractionPlan,
  type ExtractionTask,
  type ExtractionResult,
  type ExtractedOperation,
  type ValidatedExtraction,
  type Rejection,
} from "./extract/prose-api.js";
export { createLlmFromEnv, anthropicClient, openAiCompatibleClient, runExtraction, splitResults, DEFAULT_ANTHROPIC_MODEL, type LlmClient } from "./extract/llm.js";
export { planRegistration, applyRegistration, type AgentClient, type RegisterInput, type RegistrationPlan } from "./generate/register.js";
export {
  CATALOG_URL,
  CatalogEntrySchema,
  CatalogIndexSchema,
  catalogAnswers,
  catalogName,
  fetchCatalogEntry,
  fetchCatalogIndex,
  findCatalogEntry,
  searchCatalog,
  type CatalogEntry,
  type CatalogIndex,
} from "./catalog.js";
export { createFetchers, type Fetchers, type FetcherConfig } from "./fetch/defaults.js";

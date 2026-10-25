import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  cacheRoot,
  catalogAnswers,
  createLlmFromEnv,
  detectContext,
  finishExtraction,
  generateProject,
  GENERATOR_VERSION,
  insideCache,
  MakeMcpError,
  resolveIntake,
  runExtraction,
  splitResults,
  startExtraction,
  writeProject,
  type Fetchers,
  type GenerateOptions,
  type Manifest,
} from "@make-mcp/core";
import { testServer } from "@make-mcp/mcp-server";

/**
 * `make-mcp run <target>`: an MCP server on demand. Generates the server for the version the current project uses
 * into the user cache (once), builds and smoke-tests it, then runs it over stdio. This is what the catalog's
 * Claude Code plugins start, so a plugin install gives you a version-exact server without any setup.
 *
 * stdout belongs to the MCP protocol: everything else goes to stderr.
 */

export interface RunOptions {
  target: string;
  workspace: string;
  fetchers: Fetchers;
  /** Regenerate even if a cached build exists. */
  refresh?: boolean;
}

const log = (message: string) => process.stderr.write(`[make-mcp] ${message}\n`);

function isBuilt(dir: string, language: "ts" | "py"): boolean {
  try {
    JSON.parse(readFileSync(join(dir, "data", "manifest.json"), "utf8")) as Manifest;
    return existsSync(join(dir, language === "ts" ? "dist/index.js" : "server.py"));
  } catch {
    return false;
  }
}

/** Generates, builds and tests the server in the cache unless it is already there. Returns its directory. */
export async function prepareServer(options: RunOptions): Promise<{ dir: string; language: "ts" | "py"; built: boolean }> {
  const findings = await detectContext({ target: options.target, workspaceRoot: options.workspace, ...options.fetchers });
  const resolved = resolveIntake(findings, catalogAnswers(findings, { transport: "stdio", register: "none" }), { useDefaults: true });
  const dir = insideCache(join(cacheRoot(), "servers", resolved.slug, `${resolved.version}-${resolved.language}-${GENERATOR_VERSION}`));
  if (!options.refresh && isBuilt(dir, resolved.language)) return { dir, language: resolved.language, built: false };

  log(`building ${resolved.target} ${resolved.version} MCP server (first run only) …`);
  const generateOptions: GenerateOptions = { ...options.fetchers, workspaceRoot: options.workspace };
  if (resolved.apiSource === "docs") {
    const llm = createLlmFromEnv();
    if (!llm) {
      throw new MakeMcpError(
        "INTAKE_INCOMPLETE",
        `${resolved.target} has no OpenAPI spec; extracting its API needs an LLM (ANTHROPIC_API_KEY or MAKE_MCP_LLM_BASE_URL + MAKE_MCP_LLM_MODEL).`,
      );
    }
    const { corpus, plan } = await startExtraction(resolved, options.fetchers);
    const { ok, failed } = splitResults(plan, await runExtraction(plan, llm));
    // A cached build is reused forever, so never cache an API with missing parts.
    if (failed.length) throw new MakeMcpError("SPEC_INVALID", `The model gave no valid answer for ${failed.length} of ${plan.tasks.length} batches; try again or use another model.`);
    Object.assign(generateOptions, { extractedApi: finishExtraction(resolved, corpus, ok).spec, corpus });
  }

  // Build next to the final directory and swap it in, so nobody ever sees a half-built cache entry.
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  try {
    const project = await generateProject({ ...resolved, outDir: tmp }, generateOptions);
    writeProject(project);
    const tested = await testServer(tmp, options.fetchers);
    if (!tested.ok) throw new MakeMcpError("FETCH_FAILED", `The generated server failed its smoke test: ${tested.error ?? "no tools"}`);

    // Another start may have finished first (several agent sessions launch the same plugin). Keep its build.
    if (!options.refresh && isBuilt(dir, resolved.language)) return { dir, language: resolved.language, built: false };
    if (options.refresh) rmSync(dir, { recursive: true, force: true });
    try {
      renameSync(tmp, dir);
    } catch (err) {
      if (isBuilt(dir, resolved.language)) return { dir, language: resolved.language, built: false };
      throw err;
    }
    log(`ready: ${tested.tools.length} tools (${dir})`);
    return { dir, language: resolved.language, built: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs the prepared server with this process's stdio; resolves with its exit code. */
export async function runServer(options: RunOptions): Promise<number> {
  const { dir, language } = await prepareServer(options);
  const child =
    language === "ts"
      ? spawn(process.execPath, [join(dir, "dist", "index.js")], { stdio: "inherit" })
      : spawn("uv", ["run", "--no-sync", "--directory", dir, "server.py"], { stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  return new Promise((resolve) => {
    child.on("error", (err) => {
      log(language === "py" ? `could not start the Python server (is uv installed?): ${err.message}` : `could not start the server: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

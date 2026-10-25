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
  MakeMcpError,
  resolveIntake,
  runExtraction,
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

function cachedManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "data", "manifest.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

/** Generates, builds and tests the server in the cache unless it is already there. Returns its directory. */
export async function prepareServer(options: RunOptions): Promise<{ dir: string; language: "ts" | "py"; built: boolean }> {
  const findings = await detectContext({ target: options.target, workspaceRoot: options.workspace, ...options.fetchers });
  const resolved = resolveIntake(findings, catalogAnswers(findings, { transport: "stdio", register: "none" }), { useDefaults: true });
  const dir = join(cacheRoot(), "servers", resolved.slug, `${resolved.version}-${resolved.language}-${GENERATOR_VERSION}`);
  if (!options.refresh && cachedManifest(dir) && existsSync(join(dir, resolved.language === "ts" ? "dist/index.js" : "server.py"))) {
    return { dir, language: resolved.language, built: false };
  }

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
    const { spec } = finishExtraction(resolved, corpus, await runExtraction(plan, llm));
    Object.assign(generateOptions, { extractedApi: spec, corpus });
  }

  // Build next to the final directory and swap it in, so a crash never leaves a half-built cache entry.
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  const project = await generateProject({ ...resolved, outDir: tmp }, generateOptions);
  writeProject(project);
  const tested = await testServer(tmp, options.fetchers);
  if (!tested.ok) {
    rmSync(tmp, { recursive: true, force: true });
    throw new MakeMcpError("FETCH_FAILED", `The generated server failed its smoke test: ${tested.error ?? "no tools"}`);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  log(`ready: ${tested.tools.length} tools (${dir})`);
  return { dir, language: resolved.language, built: true };
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
  return new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

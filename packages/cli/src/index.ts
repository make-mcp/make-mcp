#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  applyRegistration,
  applySourceAnswers,
  createFetchers,
  createLlmFromEnv,
  detectContext,
  finishExtraction,
  generateProject,
  isMakeMcpError,
  nextQuestions,
  normalizeAnswers,
  planRegistration,
  refreshDocs,
  resolveIntake,
  runExtraction,
  startExtraction,
  summarizeIntake,
  writeProject,
  zipProject,
  type ApiSpec,
  type DocCorpus,
  type Fetchers,
  type GeneratedProject,
  type IntakeAnswers,
  type Question,
  type ResolvedIntake,
} from "@make-mcp/core";
import { SERVER_VERSION, startStdioServer, testServer } from "@make-mcp/mcp-server";

const HELP = `make-mcp ${SERVER_VERSION} – generate MCP servers from docs, specs or source code

Run with "npx @make-mcp/cli <command>" or install globally: "npm i -g @make-mcp/cli".

Usage:
  make-mcp create [target]          Interactive: detect, ask, generate, test, register
  make-mcp generate --target <t>    Non-interactive (use --yes to accept defaults)
  make-mcp mcp                      Run make-mcp as an MCP server (stdio) for coding agents
  make-mcp refresh <dir>            Download docs for a server that fetches them on install
  make-mcp test <dir>               Install, build and smoke-test a generated server

Options for create/generate:
  --workspace <dir>     Project to inspect (default: cwd)
  --mode <docs|api|both>   --lang <ts|py>   --version <v>   --out <dir>
  --docs <url|none>     --code <url|path|none>   --auth <none|apiKey|bearer|basic|oauth2>
  --scope <all|tag,…>   --transport <stdio|http>   --register <project|global|none>
  --tools <endpoints|grouped>   (default: grouped above 40 API operations)
  --client <claude-code|cursor>   --zip   --yes   --allow-private   --fixtures <dir>

APIs without an OpenAPI spec are extracted from their documentation by an LLM. Inside a coding agent
(plugin / "make-mcp mcp") the agent's own model does it. The CLI needs one of:
  ANTHROPIC_API_KEY                                   Anthropic (MAKE_MCP_LLM_MODEL, default claude-sonnet-5-5)
  MAKE_MCP_LLM_BASE_URL + MAKE_MCP_LLM_MODEL          any OpenAI-compatible endpoint, e.g. Ollama: http://localhost:11434/v1
  OPENAI_API_KEY + MAKE_MCP_LLM_MODEL                 OpenAI
`;

const out = (line = "") => process.stdout.write(`${line}\n`);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: "string" },
    workspace: { type: "string" },
    mode: { type: "string" },
    lang: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
    docs: { type: "string" },
    code: { type: "string" },
    auth: { type: "string" },
    scope: { type: "string" },
    transport: { type: "string" },
    register: { type: "string" },
    tools: { type: "string" },
    client: { type: "string", default: "claude-code" },
    zip: { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
    "allow-private": { type: "boolean", default: false },
    "if-missing": { type: "boolean", default: false },
    fixtures: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function answersFromFlags(): Record<string, string> {
  const map: Record<string, string | undefined> = {
    mode: values.mode,
    language: values.lang,
    version: values.version,
    outDir: values.out,
    docsSource: values.docs,
    codeSource: values.code,
    auth: values.auth,
    scope: values.scope,
    transport: values.transport,
    register: values.register,
    tools: values.tools,
  };
  return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => e[1] !== undefined));
}

async function ask(question: Question): Promise<string> {
  const { input, select } = await import("@inquirer/prompts");
  const OTHER = "\u0000other";
  if (question.options.length === 0) return input({ message: question.question, ...(question.default ? { default: question.default } : {}) });
  const choice = await select({
    message: question.question,
    choices: [
      ...question.options.map((o) => ({ name: o.label, value: o.value, ...(o.description ? { description: o.description } : {}) })),
      ...(question.allowFreeText ? [{ name: "Other…", value: OTHER }] : []),
    ],
    ...(question.default ? { default: question.default } : {}),
  });
  return choice === OTHER ? input({ message: question.question }) : choice;
}

async function confirmStep(message: string, fallback = true): Promise<boolean> {
  if (values.yes) return fallback;
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: fallback });
}

async function intake(fetchers: Fetchers, interactive: boolean): Promise<ResolvedIntake> {
  const target = values.target ?? positionals[1];
  if (!target) throw new Error("Missing target, e.g. `make-mcp create daisyui`.");
  const workspaceRoot = resolve(values.workspace ?? process.cwd());
  out(`Detecting ${target} …`);
  let findings = await detectContext({ target, workspaceRoot, ...fetchers });
  let answers: IntakeAnswers = normalizeAnswers(findings, {}, answersFromFlags());
  if (answers.docsSource || answers.codeSource) findings = await applySourceAnswers(findings, answers, fetchers);
  findings.notes.forEach((n) => out(`  note: ${n}`));

  if (interactive && !values.yes) {
    for (let questions = nextQuestions(findings, answers); questions.length > 0; questions = nextQuestions(findings, answers)) {
      const raw: Record<string, string> = {};
      for (const question of questions) raw[question.id] = await ask(question);
      answers = normalizeAnswers(findings, answers, raw);
      if (raw.docsSource || raw.codeSource) findings = await applySourceAnswers(findings, answers, fetchers);
    }
  }
  return resolveIntake(findings, answers, { useDefaults: values.yes || !interactive });
}

async function extractApi(resolved: ResolvedIntake, fetchers: Fetchers, interactive: boolean): Promise<{ spec: ApiSpec; corpus: DocCorpus } | undefined> {
  const llm = createLlmFromEnv();
  if (!llm) {
    throw new Error(
      "This API has no OpenAPI spec and must be extracted from its documentation by an LLM. Run make-mcp inside your coding agent " +
        "(its model does the extraction, no key needed) or configure one for the CLI – see `make-mcp --help`.",
    );
  }
  out("Loading the documentation …");
  const { corpus, plan } = await startExtraction(resolved, fetchers);
  const pages = plan.tasks.reduce((n, t) => n + t.pages.length, 0);
  out(`${pages} of ${corpus.pages.length} pages look like API reference (${plan.tasks.length} batch${plan.tasks.length === 1 ? "" : "es"}).`);
  if (interactive && !(await confirmStep(`Send them to ${llm.label} to extract the operations?`))) return undefined;

  const results = await runExtraction(plan, llm, { onTask: (i, total) => out(`  extracting batch ${i + 1}/${total} …`) });
  const { spec, validated } = finishExtraction(resolved, corpus, results);
  out(`\nExtracted ${spec.endpoints.length} operations (checked against the documentation):`);
  spec.endpoints.forEach((e) => out(`  ${e.method.toUpperCase().padEnd(6)} ${e.path} – ${e.summary ?? e.id}`));
  if (validated.rejected.length) {
    out(`Rejected ${validated.rejected.length} (not backed by the docs):`);
    validated.rejected.forEach((r) => out(`  ${r.method.padEnd(6)} ${r.path} – ${r.reason}`));
  }
  validated.notes.forEach((n) => out(`  note: ${n}`));
  if (interactive && !(await confirmStep("Generate the server with these operations?"))) return undefined;
  return { spec, corpus };
}

async function generate(interactive: boolean): Promise<void> {
  const fetchers = createFetchers({ allowPrivateNetworks: values["allow-private"], ...(values.fixtures ? { fixturesDir: values.fixtures } : {}) });
  const resolved = await intake(fetchers, interactive);
  out(`\n${summarizeIntake(resolved)}\n`);
  if (interactive && !(await confirmStep("Generate this server?"))) return;

  const workspaceRoot = resolve(values.workspace ?? process.cwd());
  const extracted = resolved.apiSource === "docs" ? await extractApi(resolved, fetchers, interactive) : undefined;
  if (resolved.apiSource === "docs" && !extracted) return;
  const project: GeneratedProject = await generateProject(resolved, {
    ...fetchers,
    workspaceRoot,
    ...(extracted ? { extractedApi: extracted.spec, corpus: extracted.corpus } : {}),
  });
  writeProject(project);
  out(`Wrote ${Object.keys(project.files).length} files to ${project.outDir}`);
  out(`Tools: ${project.tools.join(", ")}`);
  project.warnings.forEach((w) => out(`  warning: ${w}`));
  if (values.zip) {
    writeFileSync(`${project.outDir}.zip`, zipProject(project));
    out(`ZIP: ${project.outDir}.zip`);
  }

  if (interactive && (await confirmStep("Install, build and smoke-test it now?"))) {
    const result = await testServer(project.outDir, fetchers);
    out(result.ok ? `✓ ${result.tools.length} tools respond (${result.steps.join(" → ")})` : `✗ test failed: ${result.error ?? "no tools"}`);
  }

  if (resolved.register !== "none") {
    const plan = planRegistration({
      workspaceRoot,
      name: project.manifest.name,
      run: project.run,
      envVars: project.envVars,
      scope: resolved.register,
      client: values.client === "cursor" ? "cursor" : "claude-code",
    });
    if (plan.command) out(`\nRegister globally with:\n  ${plan.command}`);
    else if (plan.file) {
      out(`\n${plan.replacesExisting ? "Update" : "Add"} "${project.manifest.name}" in ${plan.file}:\n${plan.after}`);
      if (await confirmStep(`Write ${plan.file}?`)) {
        applyRegistration(plan);
        out(`✓ registered in ${plan.file}`);
      }
    }
  }
  if (project.envVars.some((v) => v.secret)) out(`\nSet credentials: ${project.envVars.filter((v) => v.secret).map((v) => v.name).join(", ")}`);
}

async function main(): Promise<void> {
  const command = positionals[0];
  if (values.help || !command) return void out(HELP);

  switch (command) {
    case "create":
      return generate(true);
    case "generate":
      return generate(false);
    case "mcp":
      return startStdioServer();
    case "refresh": {
      const dir = resolve(positionals[1] ?? ".");
      const result = await refreshDocs(dir, { ...createFetchers({ allowPrivateNetworks: values["allow-private"] }), ifMissing: values["if-missing"] });
      return void out(result.skipped ? `Docs cache present: ${result.path}` : `Downloaded ${result.pages} pages to ${result.path}`);
    }
    case "test": {
      const result = await testServer(resolve(positionals[1] ?? "."), createFetchers({ allowPrivateNetworks: values["allow-private"] }));
      out(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    default:
      out(HELP);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  if (isMakeMcpError(err)) process.stderr.write(`error [${err.code}]: ${err.message}\n`);
  else process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exitCode = 1;
});

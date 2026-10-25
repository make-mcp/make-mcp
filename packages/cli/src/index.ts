#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  applyRegistration,
  applySourceAnswers,
  createFetchers,
  detectContext,
  generateProject,
  isMakeMcpError,
  nextQuestions,
  normalizeAnswers,
  planRegistration,
  refreshDocs,
  resolveIntake,
  summarizeIntake,
  writeProject,
  zipProject,
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
  --client <claude-code|cursor>   --zip   --yes   --allow-private   --fixtures <dir>
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

async function generate(interactive: boolean): Promise<void> {
  const fetchers = createFetchers({ allowPrivateNetworks: values["allow-private"], ...(values.fixtures ? { fixturesDir: values.fixtures } : {}) });
  const resolved = await intake(fetchers, interactive);
  out(`\n${summarizeIntake(resolved)}\n`);
  if (interactive && !(await confirmStep("Generate this server?"))) return;

  const workspaceRoot = resolve(values.workspace ?? process.cwd());
  const project: GeneratedProject = await generateProject(resolved, { ...fetchers, workspaceRoot });
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

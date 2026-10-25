#!/usr/bin/env node
// Sets one version everywhere it is pinned: package manifests, internal dependencies, runtime
// constants and the Claude Code plugin. Usage: npm run set-version -- 0.2.0 (or --check 0.2.0).
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const log = (line) => process.stdout.write(`${line}\n`);
const warn = (line) => process.stderr.write(`${line}\n`);

const [flag, arg] = process.argv.slice(2);
const check = flag === "--check";
const version = check ? arg : flag;
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  warn("usage: set-version [--check] <x.y.z>");
  process.exit(1);
}

const v = String.raw`\d+\.\d+\.\d+(?:-[\w.]+)?`;
const edits = [
  ["packages/core/package.json", [[new RegExp(`("version": ")${v}`), `$1${version}`]]],
  ["packages/mcp-server/package.json", [
    [new RegExp(`("version": ")${v}`), `$1${version}`],
    [new RegExp(`("@make-mcp/core": ")${v}`), `$1${version}`],
  ]],
  ["packages/cli/package.json", [
    [new RegExp(`("version": ")${v}`), `$1${version}`],
    [new RegExp(`("@make-mcp/core": ")${v}`), `$1${version}`],
    [new RegExp(`("@make-mcp/mcp-server": ")${v}`), `$1${version}`],
  ]],
  ["packages/mcp-server/src/server.ts", [[new RegExp(`(SERVER_VERSION = ")${v}`), `$1${version}`]]],
  ["packages/core/src/version.ts", [[new RegExp(`(VERSION = ")${v}`), `$1${version}`]]],
  ["plugins/claude-code/.claude-plugin/plugin.json", [[new RegExp(`("version": ")${v}`), `$1${version}`]]],
  ["plugins/claude-code/.mcp.json", [[new RegExp(`(@make-mcp/cli@)${v}`), `$1${version}`]]],
];

// Compute every edit first, so a missing pattern never leaves a half-updated set of files.
const changes = edits.map(([file, rules]) => {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [pattern, replacement] of rules) {
    if (!pattern.test(after)) throw new Error(`${file}: pattern ${pattern} not found`);
    after = after.replace(pattern, replacement);
  }
  return { file, before, after };
});
const stale = changes.filter((c) => c.after !== c.before);
for (const c of stale) {
  if (check) warn(`${c.file} does not pin ${version}`);
  else writeFileSync(c.file, c.after);
}

if (check && stale.length) process.exit(1);
log(check ? `all files pin ${version}` : `set ${version} in ${stale.length} file(s); run npm install to update the lockfile`);

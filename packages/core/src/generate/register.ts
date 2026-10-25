import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MakeMcpError } from "../errors.js";
import type { EnvVar } from "./project.js";

export type AgentClient = "claude-code" | "cursor";

export interface RegisterInput {
  workspaceRoot: string;
  name: string;
  run: { command: string; args: string[] };
  envVars: EnvVar[];
  scope: "project" | "global";
  client: AgentClient;
}

export interface RegistrationPlan {
  client: AgentClient;
  scope: "project" | "global";
  /** Config file that will be changed (project scope). */
  file?: string;
  before?: string;
  after?: string;
  /** Command for the user to run themselves (global scope). */
  command?: string;
  replacesExisting: boolean;
}

/** Only credentials are wired through; base URL/version overrides stay optional. */
function credentialVars(envVars: EnvVar[]): string[] {
  return envVars.filter((v) => v.secret).map((v) => v.name);
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function planRegistration(input: RegisterInput): RegistrationPlan {
  const vars = credentialVars(input.envVars);

  if (input.scope === "global") {
    const command =
      input.client === "claude-code"
        ? [
            "claude mcp add --scope user",
            ...vars.map((v) => `-e ${v}=…`),
            shellQuote(input.name),
            "--",
            shellQuote(input.run.command),
            ...input.run.args.map(shellQuote),
          ].join(" ")
        : `Add "${input.name}" to ~/.cursor/mcp.json: ${JSON.stringify({ command: input.run.command, args: input.run.args })}`;
    return { client: input.client, scope: "global", command, replacesExisting: false };
  }

  const file = join(input.workspaceRoot, input.client === "cursor" ? ".cursor/mcp.json" : ".mcp.json");
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (before !== undefined && before.trim()) {
    try {
      config = JSON.parse(before) as typeof config;
    } catch {
      throw new MakeMcpError("SPEC_INVALID", `${file} is not valid JSON; refusing to modify it.`);
    }
  }

  const envRef = (name: string) => (input.client === "cursor" ? `\${env:${name}}` : `\${${name}:-}`);
  const entry = {
    command: input.run.command,
    args: input.run.args,
    ...(vars.length ? { env: Object.fromEntries(vars.map((v) => [v, envRef(v)])) } : {}),
  };
  const servers = { ...(config.mcpServers ?? {}) };
  const replacesExisting = input.name in servers;
  servers[input.name] = entry;
  const after = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;

  return { client: input.client, scope: "project", file, ...(before !== undefined ? { before } : {}), after, replacesExisting };
}

export function applyRegistration(plan: RegistrationPlan): void {
  if (!plan.file || plan.after === undefined) return;
  const current = existsSync(plan.file) ? readFileSync(plan.file, "utf8") : undefined;
  if (current !== plan.before) {
    throw new MakeMcpError("OUTPUT_NOT_EMPTY", `${plan.file} changed since the plan was made; plan again.`);
  }
  mkdirSync(dirname(plan.file), { recursive: true });
  writeFileSync(plan.file, plan.after);
}

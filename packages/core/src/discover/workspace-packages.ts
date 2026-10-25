import { parse as parseYaml } from "yaml";
import type { Workspace } from "../fs/workspace.js";

export interface InstalledPackage {
  name: string;
  version: string;
  /** Where the version came from; lockfiles and node_modules are exact, package.json is a range. */
  source: "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "node_modules" | "package.json";
  exact: boolean;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9@/]/g, "");

/** Finds the dependency name in package.json that matches a user-typed target ("daisyUI" → "daisyui"). */
export function matchDependency(ws: Workspace, target: string): string | undefined {
  const pkg = ws.readJson<PackageJson>("package.json");
  if (!pkg) return undefined;
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
  const wanted = normalize(target);
  return names.find((n) => normalize(n) === wanted) ?? names.find((n) => normalize(n.split("/").pop() ?? n) === wanted);
}

function fromPackageLock(ws: Workspace, name: string): string | undefined {
  const lock = ws.readJson<{ packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> }>(
    "package-lock.json",
  );
  return lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version;
}

function fromPnpmLock(ws: Workspace, name: string): string | undefined {
  const text = ws.readText("pnpm-lock.yaml");
  if (!text) return undefined;
  try {
    const lock = parseYaml(text) as {
      importers?: Record<string, Record<string, Record<string, { version?: string }>>>;
      packages?: Record<string, unknown>;
    };
    for (const importer of Object.values(lock.importers ?? {})) {
      for (const group of ["dependencies", "devDependencies"]) {
        const version = importer[group]?.[name]?.version;
        if (version) return version.split("(")[0];
      }
    }
    const key = Object.keys(lock.packages ?? {}).find((k) => k.replace(/^\//, "").startsWith(`${name}@`));
    return key?.replace(/^\//, "").slice(name.length + 1).split("(")[0];
  } catch {
    return undefined;
  }
}

function fromYarnLock(ws: Workspace, name: string): string | undefined {
  const text = ws.readText("yarn.lock");
  if (!text) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const block = new RegExp(`^"?${escaped}@[^\\n]*:\\n(?:\\s+[^\\n]*\\n)*?\\s+version:?\\s+"?([^"\\n]+)"?`, "m").exec(text);
  return block?.[1];
}

export function findInstalledPackage(ws: Workspace, name: string): InstalledPackage | undefined {
  const lockfiles = [
    ["package-lock.json", fromPackageLock],
    ["pnpm-lock.yaml", fromPnpmLock],
    ["yarn.lock", fromYarnLock],
  ] as const;
  for (const [source, read] of lockfiles) {
    const version = read(ws, name);
    if (version) return { name, version, source, exact: true };
  }

  const installed = ws.readJson<PackageJson>(`node_modules/${name}/package.json`);
  if (installed?.version) return { name, version: installed.version, source: "node_modules", exact: true };

  const pkg = ws.readJson<PackageJson>("package.json");
  const range = pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name] ?? pkg?.peerDependencies?.[name];
  if (range) return { name, version: range, source: "package.json", exact: false };
  return undefined;
}

export function detectWorkspaceLanguage(ws: Workspace): "ts" | "py" | undefined {
  const isNode = ws.exists("package.json");
  const isPython = ["pyproject.toml", "requirements.txt", "setup.py", "uv.lock"].some((f) => ws.exists(f));
  if (isNode && !isPython) return "ts";
  if (isPython && !isNode) return "py";
  return undefined;
}

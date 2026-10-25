import { parse as parseToml } from "smol-toml";
import type { Workspace } from "../fs/workspace.js";
import { isSafeVersion } from "../safe-version.js";

export type PythonSource =
  | "uv.lock"
  | "poetry.lock"
  | "pdm.lock"
  | "Pipfile.lock"
  | "site-packages"
  | "requirements.txt"
  | "pyproject.toml"
  | "Pipfile";

export interface PythonDependency {
  /** Name as written in the project file. */
  name: string;
  /** PEP 440 specifier such as ">=2.0,<3" or "==2.1.0"; empty if unconstrained. */
  spec: string;
  file: string;
}

/** PEP 503 normalisation: "Typing_Extensions" and "typing-extensions" are the same project. */
export const normalizePythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const readToml = (ws: Workspace, file: string): Record<string, unknown> | undefined => {
  const text = ws.readText(file);
  if (text === undefined) return undefined;
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Splits a PEP 508 requirement ("httpx[http2]>=0.27; python_version>'3.9'") into name and specifier. */
export function parseRequirement(line: string): { name: string; spec: string } | undefined {
  // pip-compile output: "pkg==1.0 \\" continuation lines and "--hash=…" options next to the requirement.
  const cleaned = line
    .split("#")[0]!
    .split(";")[0]!
    .replace(/\s+--\S.*$/, "")
    .replace(/\\\s*$/, "")
    .trim();
  if (!cleaned || cleaned.startsWith("-") || cleaned.includes("://")) return undefined;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(\(?[^)]*\)?)$/.exec(cleaned);
  if (!match) return undefined;
  return { name: match[1]!, spec: match[2]!.replace(/[()\s]/g, "") };
}

function poetrySpec(value: unknown): string {
  const raw = typeof value === "string" ? value : typeof asRecord(value).version === "string" ? (asRecord(value).version as string) : "";
  if (!raw || raw === "*") return "";
  // A bare version means an exact pin in Poetry and Pipfile.
  if (/^\d[\w.+!-]*$/.test(raw)) return `==${raw}`;
  // Poetry's caret/tilde ranges start at the given version.
  return /^[\^~]\d/.test(raw) ? `>=${raw.slice(1)}` : raw;
}

/** All direct dependencies declared in pyproject.toml, requirements*.txt and Pipfile. */
export function pythonDependencies(ws: Workspace): PythonDependency[] {
  const deps: PythonDependency[] = [];
  const pyproject = readToml(ws, "pyproject.toml");
  if (pyproject) {
    const project = asRecord(pyproject.project);
    const pep621 = [
      ...asArray(project.dependencies),
      ...Object.values(asRecord(project["optional-dependencies"])).flatMap(asArray),
      ...Object.values(asRecord(pyproject["dependency-groups"])).flatMap(asArray),
    ];
    for (const entry of pep621) {
      const req = typeof entry === "string" ? parseRequirement(entry) : undefined;
      if (req) deps.push({ ...req, file: "pyproject.toml" });
    }
    const poetry = asRecord(asRecord(pyproject.tool).poetry);
    const groups = [
      asRecord(poetry.dependencies),
      asRecord(poetry["dev-dependencies"]),
      ...Object.values(asRecord(poetry.group)).map((g) => asRecord(asRecord(g).dependencies)),
    ];
    for (const group of groups) {
      for (const [name, value] of Object.entries(group)) {
        if (name !== "python") deps.push({ name, spec: poetrySpec(value), file: "pyproject.toml" });
      }
    }
  }

  for (const file of ws.list(".").filter((f) => /^requirements.*\.(txt|in)$/.test(f))) {
    for (const line of (ws.readText(file) ?? "").split("\n")) {
      const req = parseRequirement(line);
      if (req) deps.push({ ...req, file });
    }
  }

  const pipfile = readToml(ws, "Pipfile");
  for (const section of ["packages", "dev-packages"]) {
    for (const [name, value] of Object.entries(asRecord(pipfile?.[section]))) {
      deps.push({ name, spec: poetrySpec(value), file: "Pipfile" });
    }
  }
  return deps;
}

/** Finds the declared dependency that matches a user-typed target ("FastAPI" → "fastapi"). */
export function matchPythonDependency(ws: Workspace, target: string): string | undefined {
  const wanted = normalizePythonName(target.replace(/\s+/g, "-"));
  return pythonDependencies(ws).find((d) => normalizePythonName(d.name) === wanted)?.name;
}

function fromTomlLock(ws: Workspace, file: string, name: string): string | undefined {
  const lock = readToml(ws, file);
  const wanted = normalizePythonName(name);
  const entry = asArray(lock?.package)
    .map(asRecord)
    .find((p) => typeof p.name === "string" && normalizePythonName(p.name) === wanted);
  return typeof entry?.version === "string" ? entry.version : undefined;
}

function fromPipfileLock(ws: Workspace, name: string): string | undefined {
  const lock = ws.readJson<Record<string, Record<string, { version?: string }>>>("Pipfile.lock");
  const wanted = normalizePythonName(name);
  for (const section of ["default", "develop"]) {
    for (const [key, value] of Object.entries(lock?.[section] ?? {})) {
      if (normalizePythonName(key) === wanted && value.version) return value.version.replace(/^==/, "");
    }
  }
  return undefined;
}

export interface DistInfo {
  /** site-packages directory relative to the workspace. */
  sitePackages: string;
  /** `<name>-<version>.dist-info` directory name. */
  distInfo: string;
  version: string;
}

/** Looks for `<name>-<version>.dist-info` in a project-local virtualenv. */
export function findDistInfo(ws: Workspace, name: string): DistInfo | undefined {
  const wanted = normalizePythonName(name);
  for (const venv of [".venv", "venv", "env"]) {
    const sitePackages = [...ws.list(`${venv}/lib`).map((py) => `${venv}/lib/${py}/site-packages`), `${venv}/Lib/site-packages`];
    for (const dir of sitePackages) {
      for (const entry of ws.list(dir)) {
        const match = /^(.+)-([^-]+)\.dist-info$/.exec(entry);
        if (match && normalizePythonName(match[1]!) === wanted) return { sitePackages: dir, distInfo: entry, version: match[2]! };
      }
    }
  }
  return undefined;
}

const fromSitePackages = (ws: Workspace, name: string) => findDistInfo(ws, name)?.version;

/** Lowest version a PEP 440 specifier allows, e.g. ">=2.1,<3" → "2.1", "~=1.4.2" → "1.4.2". */
export function minimumPythonVersion(spec: string): string | undefined {
  const match = /(?:^|,)\s*(?:===|==|>=|~=)\s*([0-9][0-9A-Za-z.+!-]*)/.exec(spec);
  return match?.[1]?.replace(/\.$/, "");
}

export interface InstalledPythonPackage {
  name: string;
  version: string;
  source: PythonSource;
  exact: boolean;
  /** The declared specifier when the version is only a lower bound. */
  range?: string;
}

const declaredSource = (file: string): PythonSource => (file.startsWith("requirements") ? "requirements.txt" : (file as PythonSource));

export function findInstalledPythonPackage(ws: Workspace, name: string): InstalledPythonPackage | undefined {
  const locks: [PythonSource, () => string | undefined][] = [
    ["uv.lock", () => fromTomlLock(ws, "uv.lock", name)],
    ["poetry.lock", () => fromTomlLock(ws, "poetry.lock", name)],
    ["pdm.lock", () => fromTomlLock(ws, "pdm.lock", name)],
    ["Pipfile.lock", () => fromPipfileLock(ws, name)],
    ["site-packages", () => fromSitePackages(ws, name)],
  ];
  for (const [source, read] of locks) {
    const version = read();
    if (version && isSafeVersion(version)) return { name, version, source, exact: true };
  }

  const wanted = normalizePythonName(name);
  const declared = pythonDependencies(ws).filter((d) => normalizePythonName(d.name) === wanted);
  const pinned = declared.find((d) => /^===?[0-9][0-9A-Za-z.+!]*$/.test(d.spec) && isSafeVersion(d.spec.replace(/^===?/, "")));
  if (pinned) return { name, version: pinned.spec.replace(/^===?/, ""), source: declaredSource(pinned.file), exact: true };
  for (const dep of declared) {
    const min = minimumPythonVersion(dep.spec);
    if (min && isSafeVersion(min)) return { name, version: min, source: declaredSource(dep.file), exact: false, range: dep.spec };
  }
  return undefined;
}

export function isPythonWorkspace(ws: Workspace): boolean {
  return (
    ["pyproject.toml", "uv.lock", "poetry.lock", "Pipfile", "setup.py", "setup.cfg"].some((f) => ws.exists(f)) ||
    ws.list(".").some((f) => /^requirements.*\.txt$/.test(f))
  );
}

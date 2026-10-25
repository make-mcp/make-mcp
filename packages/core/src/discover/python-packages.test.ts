import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFixtureFetch } from "../fetch/fixture-fetch.js";
import { createPoliteFetch } from "../fetch/polite-fetch.js";
import { createWorkspace } from "../fs/workspace.js";
import { detectContext } from "./detect.js";
import {
  findInstalledPythonPackage,
  matchPythonDependency,
  minimumPythonVersion,
  parseRequirement,
  pythonDependencies,
} from "./python-packages.js";
import { detectWorkspaceLanguage } from "./workspace-packages.js";

const fixtures = (path: string) => fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url));
const ws = (name: string) => createWorkspace(fixtures(`workspaces/${name}`));

describe("parseRequirement", () => {
  it("handles extras, markers, comments and parenthesised specifiers", () => {
    expect(parseRequirement("FastAPI[standard]>=0.115")).toEqual({ name: "FastAPI", spec: ">=0.115" });
    expect(parseRequirement("httpx >= 0.27, <1 ; python_version >= '3.11'  # client")).toEqual({ name: "httpx", spec: ">=0.27,<1" });
    expect(parseRequirement("requests (==2.32.3)")).toEqual({ name: "requests", spec: "==2.32.3" });
    expect(parseRequirement("-e .")).toBeUndefined();
    expect(parseRequirement("git+https://github.com/x/y.git")).toBeUndefined();
  });

  it("finds the lower bound of a specifier", () => {
    expect(minimumPythonVersion(">=2.1,<3")).toBe("2.1");
    expect(minimumPythonVersion("<3,~=1.4.2")).toBe("1.4.2");
    expect(minimumPythonVersion("==2.*")).toBe("2");
    expect(minimumPythonVersion("<3")).toBeUndefined();
  });
});

describe("Python workspaces", () => {
  it("reads PEP 621 dependencies and dependency groups", () => {
    expect(pythonDependencies(ws("python-uv")).map((d) => d.name)).toEqual(["FastAPI", "httpx", "pytest"]);
    expect(matchPythonDependency(ws("python-uv"), "fastapi")).toBe("FastAPI");
    expect(detectWorkspaceLanguage(ws("python-uv"))).toBe("py");
  });

  it("takes exact versions from lockfiles", () => {
    expect(findInstalledPythonPackage(ws("python-uv"), "FastAPI")).toEqual({ name: "FastAPI", version: "0.115.6", source: "uv.lock", exact: true });
    expect(findInstalledPythonPackage(ws("python-pipfile"), "fastapi")).toMatchObject({ version: "0.111.1", source: "Pipfile.lock", exact: true });
  });

  it("treats == pins as exact and ranges as lower bounds", () => {
    expect(findInstalledPythonPackage(ws("python-requirements"), "fastapi")).toMatchObject({ version: "0.112.2", source: "requirements.txt", exact: true });
    expect(findInstalledPythonPackage(ws("python-poetry"), "fastapi")).toEqual({
      name: "fastapi",
      version: "0.110.0",
      source: "pyproject.toml",
      exact: false,
      range: ">=0.110.0",
    });
    expect(pythonDependencies(ws("python-poetry")).map((d) => d.name)).toEqual(["fastapi", "pytest"]);
  });

  it("finds installed distributions in a local virtualenv", () => {
    const root = mkdtempSync(join(tmpdir(), "make-mcp-venv-"));
    writeFileSync(join(root, "requirements.txt"), "fastapi\n");
    mkdirSync(join(root, ".venv/lib/python3.12/site-packages/fastapi-0.113.0.dist-info"), { recursive: true });
    expect(findInstalledPythonPackage(createWorkspace(root), "fastapi")).toMatchObject({ version: "0.113.0", source: "site-packages", exact: true });
  });
});

describe("detectContext in a Python project", async () => {
  const apiFetcher = createFixtureFetch(fixtures("http"));
  const contentFetcher = createPoliteFetch(apiFetcher, { delayMs: 0 });

  it("uses the lockfile version and PyPI metadata", async () => {
    const findings = await detectContext({ target: "FastAPI", workspaceRoot: fixtures("workspaces/python-uv"), apiFetcher, contentFetcher });
    expect(findings).toMatchObject({ packageName: "fastapi", registry: "pypi", slug: "fastapi", latestVersion: "0.118.0" });
    expect(findings.version).toEqual({ value: "0.115.6", confidence: "high", source: "uv.lock" });
    expect(findings.license?.value).toBe("MIT");
    expect(findings.repositoryUrl?.value).toBe("https://github.com/fastapi/fastapi");
    expect(findings.language?.value).toBe("py");
  });

  it("reports a declared range with medium confidence", async () => {
    const findings = await detectContext({ target: "fastapi", workspaceRoot: fixtures("workspaces/python-poetry"), apiFetcher, contentFetcher });
    expect(findings.version).toEqual({ value: "0.110.0", confidence: "medium", source: "pyproject.toml range >=0.110.0" });
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "../fs/workspace.js";
import { readSignatures, scanPythonSource, scanTypeDeclarations } from "./signatures.js";

const workspace = (name: string) => createWorkspace(fileURLToPath(new URL(`../../../../fixtures/workspaces/${name}`, import.meta.url)));

describe("TypeScript declarations", () => {
  it("follows the package's types entry and its imports", () => {
    const result = readSignatures(workspace("project"), { registry: "npm", packageName: "acme-ui", version: "2.0.0" });
    expect(result.source).toBe("node_modules/acme-ui");
    const byName = Object.fromEntries(result.symbols.map((s) => [s.name, s]));
    // internalHelper is declared but not exported.
    expect(Object.keys(byName).sort()).toEqual(["Button", "ButtonProps", "Size", "Theme", "VERSION", "createTheme", "icons", "icons.load"].sort());
    expect(byName.createTheme).toMatchObject({ kind: "function", module: "dist/index.d.ts", signature: "function createTheme(tokens?: Partial<Theme>): Theme;" });
    expect(byName.createTheme!.doc).toContain("@param tokens");
    // Overloads are merged; the type alias spans lines without a semicolon.
    expect(byName.Button!.signature.split("\n")).toHaveLength(2);
    expect(byName.Size!.signature).toBe('type Size = "sm" | "md"\n  | "lg";');
    expect(byName.ButtonProps!.signature).toContain("onClick?: (event: MouseEvent) => void;");
  });

  it("only reads the installed version", () => {
    const other = readSignatures(workspace("project"), { registry: "npm", packageName: "acme-ui", version: "3.0.0" });
    expect(other).toMatchObject({ symbols: [], installed: true });
    expect(other.note).toContain("not 3.0.0");
    expect(readSignatures(workspace("project"), { registry: "npm", packageName: "daisyui", version: "5.7.50" })).toEqual({ symbols: [], installed: false });
  });

  it("handles declarations without semicolons and nested braces", () => {
    const symbols = scanTypeDeclarations(
      ["export declare class Store<T> {", "  get(key: string): T | undefined", "  on(event: { type: string }): void", "}", "export declare const enum Mode { A, B }"].join("\n"),
      "index.d.ts",
    );
    expect(symbols.map((s) => [s.name, s.kind])).toEqual([
      ["Store", "class"],
      ["Mode", "enum"],
    ]);
    expect(symbols[0]!.signature).toContain("on(event: { type: string }): void");
  });

  it("keeps object types in signatures and generics", () => {
    const symbols = scanTypeDeclarations(
      [
        "export declare function f(): { ok: boolean } | undefined;",
        "export declare function g(): { a: 1 }[]",
        "export declare class A extends B<{ x: number }> {",
        "  run(): void",
        "}",
      ].join("\n"),
      "index.d.ts",
    );
    expect(symbols.map((s) => s.signature)).toEqual([
      "function f(): { ok: boolean } | undefined;",
      "function g(): { a: 1 }[]",
      "class A extends B<{ x: number }> {\n  run(): void\n}",
    ]);
  });

  it("reads namespaces, export = and export lists with aliases", () => {
    const react = scanTypeDeclarations(
      [
        "export = React;",
        "export as namespace React;",
        "declare namespace React {",
        "  /** Returns a stateful value. */",
        "  function useState<S>(initial: S | (() => S)): [S, (value: S) => void];",
        "  interface FC<P = {}> { (props: P): unknown }",
        "}",
      ].join("\n"),
      "index.d.ts",
    );
    expect(react.map((s) => [s.name, s.kind])).toEqual([
      ["React", "namespace"],
      ["React.useState", "function"],
      ["React.FC", "interface"],
    ]);
    expect(react[1]!.doc).toBe("Returns a stateful value.");

    const bundled = scanTypeDeclarations("declare class Hono$1 {}\ndeclare function hidden(): void;\nexport { Hono$1 as Hono };", "index.d.ts");
    expect(bundled.map((s) => s.name)).toEqual(["Hono"]);
  });
});

describe("Python", () => {
  it("reads stubs over sources and skips private modules and names", () => {
    const result = readSignatures(workspace("python-venv"), { registry: "pypi", packageName: "acme-client", version: "1.2.0" });
    const names = result.symbols.map((s) => s.name);
    // TokenAuth lives in the private module _auth and is re-exported as Auth; `unexported` and `_internal` stay out.
    expect(names.sort()).toEqual(["Auth", "Auth.__init__", "Client", "Client.__init__", "Client.get", "Client.stream", "connect", "sign"].sort());
    expect(result.symbols.find((s) => s.name === "sign")!.signature.split("\n")).toHaveLength(3);
    const get = result.symbols.find((s) => s.name === "Client.get")!;
    expect(get).toMatchObject({ kind: "method", module: "acme_client.client", doc: "Sends a GET request and returns the decoded JSON." });
    expect(get.signature).toBe("def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]");
    expect(result.symbols.find((s) => s.name === "Client")!.doc).toBe("HTTP client for the Acme API.");
  });

  it("parses async methods and module functions", () => {
    const symbols = scanPythonSource("async def fetch(url: str) -> bytes:\n    '''Fetch.'''\n\nclass _Private:\n    pass\n", "pkg");
    expect(symbols).toEqual([{ name: "fetch", kind: "function", module: "pkg", signature: "async def fetch(url: str) -> bytes", doc: "Fetch." }]);
  });
});

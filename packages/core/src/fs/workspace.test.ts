import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMakeMcpError } from "../errors.js";
import { createWorkspace } from "./workspace.js";

function setup() {
  const outside = mkdtempSync(join(tmpdir(), "make-mcp-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  const root = mkdtempSync(join(tmpdir(), "make-mcp-ws-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "package.json"), '{"name":"demo"}');
  symlinkSync(outside, join(root, "link"));
  return { root, outside };
}

describe("createWorkspace", () => {
  it("reads files inside the root", () => {
    const { root } = setup();
    const ws = createWorkspace(root);
    expect(ws.readJson<{ name: string }>("package.json")?.name).toBe("demo");
    expect(ws.readText("missing.txt")).toBeUndefined();
  });

  it.each(["../x", "sub/../../x", "/etc/passwd", "link/secret.txt"])("rejects %s", (path) => {
    const { root } = setup();
    const ws = createWorkspace(root);
    let caught: unknown;
    try {
      ws.readText(path);
    } catch (err) {
      caught = err;
    }
    expect(isMakeMcpError(caught, "PATH_OUTSIDE_WORKSPACE")).toBe(true);
  });
});

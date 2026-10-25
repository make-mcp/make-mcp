import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MakeMcpError } from "../errors.js";

/** Read-only view on the user's project. Every path is confined to the workspace root. */
export interface Workspace {
  readonly root: string;
  resolve(relPath: string): string;
  exists(relPath: string): boolean;
  readText(relPath: string): string | undefined;
  readJson<T = unknown>(relPath: string): T | undefined;
  /** Entry names of a directory, or [] if it does not exist. */
  list(relDir: string): string[];
}

export function createWorkspace(root: string): Workspace {
  const realRoot = realpathSync(resolve(root));

  const resolvePath = (relPath: string): string => {
    const candidate = resolve(realRoot, relPath);
    // Resolve symlinks of existing paths so a link cannot point outside the root.
    const real = existsSync(candidate) ? realpathSync(candidate) : candidate;
    const rel = relative(realRoot, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new MakeMcpError("PATH_OUTSIDE_WORKSPACE", `Path escapes workspace: ${relPath}`, { root: realRoot });
    }
    return real;
  };

  const readText = (relPath: string): string | undefined => {
    const path = resolvePath(relPath);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };

  return {
    root: realRoot,
    resolve: resolvePath,
    exists: (relPath) => existsSync(resolvePath(relPath)),
    readText,
    list(relDir) {
      const path = resolvePath(relDir);
      return existsSync(path) && statSync(path).isDirectory() ? readdirSync(path).sort() : [];
    },
    readJson<T>(relPath: string) {
      const text = readText(relPath);
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined;
      }
    },
  };
}

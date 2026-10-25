/** Licenses that allow redistributing documentation content with attribution. */
const PERMISSIVE = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "Zlib",
  "BlueOak-1.0.0",
]);

/**
 * True when an SPDX expression permits embedding content.
 * `OR` needs one permissive operand, `AND` needs all; anything unknown is treated as restrictive.
 */
export function isPermissiveLicense(spdx: string | undefined): boolean {
  if (!spdx) return false;
  const expr = spdx.trim().replace(/^\((.*)\)$/, "$1");
  if (/\s+OR\s+/i.test(expr)) return expr.split(/\s+OR\s+/i).some(isPermissiveLicense);
  if (/\s+AND\s+/i.test(expr)) return expr.split(/\s+AND\s+/i).every(isPermissiveLicense);
  return PERMISSIVE.has(expr);
}

export type ContentMode = "embedded" | "fetch-on-install";

export function contentModeFor(spdx: string | undefined): ContentMode {
  return isPermissiveLicense(spdx) ? "embedded" : "fetch-on-install";
}

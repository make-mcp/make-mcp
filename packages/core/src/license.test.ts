import { describe, expect, it } from "vitest";
import { contentModeFor, isPermissiveLicense } from "./license.js";

describe("isPermissiveLicense", () => {
  it.each([
    ["MIT", true],
    ["Apache-2.0", true],
    ["(MIT OR GPL-3.0)", true],
    ["MIT AND CC-BY-4.0", true],
    ["MIT AND GPL-3.0", false],
    ["GPL-3.0", false],
    ["SEE LICENSE IN LICENSE.md", false],
    [undefined, false],
  ])("%s -> %s", (spdx, expected) => {
    expect(isPermissiveLicense(spdx)).toBe(expected);
  });

  it("maps licenses to content mode", () => {
    expect(contentModeFor("MIT")).toBe("embedded");
    expect(contentModeFor(undefined)).toBe("fetch-on-install");
  });
});

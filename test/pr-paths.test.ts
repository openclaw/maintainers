import { describe, expect, it } from "vitest";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { MAINTAINERS_ROOT_DIR, resolveMaintainersPath } from "../pr-ops/core/paths.ts";

describe("maintainers path resolution", () => {
  it("resolves relative paths from the maintainers repo root", () => {
    expect(resolveMaintainersPath(".local/pr-plan")).toBe(
      resolvePath(MAINTAINERS_ROOT_DIR, ".local/pr-plan"),
    );
  });

  it("keeps absolute paths unchanged", () => {
    const absolute = "/tmp/pr-plan";
    expect(resolveMaintainersPath(absolute)).toBe(absolute);
  });

  it("anchors root dir to this repository", () => {
    const expectedRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
    expect(MAINTAINERS_ROOT_DIR).toBe(expectedRoot);
  });
});

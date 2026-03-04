import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

export const MAINTAINERS_ROOT_DIR = resolve(CORE_DIR, "../..");

export function resolveMaintainersPath(pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return pathValue;
  }
  return resolve(MAINTAINERS_ROOT_DIR, pathValue);
}

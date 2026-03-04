import {
  BROWSER_DEFAULT_PATH_RE,
  CORE_RUNTIME_PATH_RE,
  DEFAULT_POLICY_PATH_RE,
  DEFAULT_SHIFT_TEXT_RE,
  ONBOARDING_PATH_RE,
  ONBOARDING_TEXT_RE,
  OPTIONAL_TEXT_RE,
  TOOL_AUTO_ENABLE_RE,
  TOOL_CATALOG_PATH_RE,
  VENDOR_HINT_RE,
} from "./constants.ts";
import type { PolicyFlag } from "./types.ts";

function normalizeFilePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .toLowerCase();
}

export function detectPolicyFlags(input: {
  title: string;
  body: string;
  files: string[];
}): PolicyFlag[] {
  const title = input.title ?? "";
  const body = input.body ?? "";
  const files = input.files ?? [];
  const text = `${title}\n${body}`;
  const normalizedFiles = files.map(normalizeFilePath);

  const vendorHint =
    VENDOR_HINT_RE.test(text) || normalizedFiles.some((path) => VENDOR_HINT_RE.test(path));
  if (!vendorHint) {
    return [];
  }

  const touchesOnboarding = normalizedFiles.some((path) => ONBOARDING_PATH_RE.test(path));
  const touchesBrowserDefaults = normalizedFiles.some((path) => BROWSER_DEFAULT_PATH_RE.test(path));
  const touchesDefaultPolicyPath = normalizedFiles.some((path) =>
    DEFAULT_POLICY_PATH_RE.test(path),
  );
  const touchesToolCatalog = normalizedFiles.some((path) => TOOL_CATALOG_PATH_RE.test(path));
  const touchesOpenclawTools = normalizedFiles.some(
    (path) => path === "src/agents/openclaw-tools.ts",
  );
  const touchesCoreRuntime = normalizedFiles.some((path) => CORE_RUNTIME_PATH_RE.test(path));
  const textMentionsOnboarding = ONBOARDING_TEXT_RE.test(text);
  const textMentionsDefaultShift = DEFAULT_SHIFT_TEXT_RE.test(text);
  const textMentionsAutoEnable = TOOL_AUTO_ENABLE_RE.test(text);

  if (!touchesDefaultPolicyPath) {
    return [];
  }

  const flags = new Set<PolicyFlag>();
  const hasDefaultPathSignal =
    touchesOnboarding ||
    touchesBrowserDefaults ||
    textMentionsOnboarding ||
    textMentionsDefaultShift ||
    textMentionsAutoEnable;

  if (hasDefaultPathSignal) {
    flags.add("vendor_lockin_default_path");
  }

  if (
    textMentionsAutoEnable ||
    (touchesOnboarding && touchesToolCatalog) ||
    (touchesOpenclawTools && /allow|enable|default/i.test(text))
  ) {
    flags.add("auto_enable_vendor_tools");
  }

  if (
    touchesBrowserDefaults &&
    (textMentionsDefaultShift || /default/i.test(text) || /(profile|browser|driver)/i.test(text))
  ) {
    flags.add("default_profile_shift");
  }

  if (touchesCoreRuntime && flags.size > 0) {
    const strongDefaultSignals =
      flags.has("default_profile_shift") ||
      flags.has("auto_enable_vendor_tools") ||
      touchesOnboarding;
    if (strongDefaultSignals || !OPTIONAL_TEXT_RE.test(text)) {
      flags.add("vendor_core_not_optional");
    }
  }

  return [...flags];
}

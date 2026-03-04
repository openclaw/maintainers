import type { AnalysisResult, DailyPlan } from "../core/types.ts";

export function toMarkdown(analysis: AnalysisResult, plan: DailyPlan): string {
  const flaggedCount = plan.selected.filter((item) => item.policyFlags.length > 0).length;
  const clusterRows = plan.selected
    .filter((item) => item.lane === "cluster")
    .map(
      (item) =>
        `| #${item.representativeNumber} | #${item.originNumber ?? item.representativeNumber} | ${item.decisionGain} | ${item.clusterMembers.slice(0, 8).join(", ")}${item.clusterMembers.length > 8 ? ", ..." : ""} | ${item.clusterConfidence ?? "unknown"} | ${item.clusterCoverage === null ? "-" : item.clusterCoverage.toFixed(2)} | ${item.policyFlags.join(", ") || "-"} | ${item.risk} | ${item.effort} |`,
    );
  const fastRows = plan.selected
    .filter((item) => item.lane === "fast")
    .map(
      (item) =>
        `| #${item.representativeNumber} | ${item.policyFlags.join(", ") || "-"} | ${item.risk} | ${item.effort} | ${item.author} |`,
    );
  const deepRows = plan.selected
    .filter((item) => item.lane === "deep")
    .map(
      (item) =>
        `| #${item.representativeNumber} | ${item.policyFlags.join(", ") || "-"} | ${item.risk} | ${item.effort} | ${item.author} |`,
    );

  return [
    "# PR Plan",
    "",
    `Generated: ${analysis.generatedAt}`,
    `Repository: ${analysis.repo}`,
    "",
    "## Snapshot",
    `- Open PRs: ${analysis.totalOpen}`,
    `- Draft PRs: ${analysis.draftCount}`,
    `- Ready PRs: ${analysis.readyCount}`,
    `- Clusters (size >= 2): ${analysis.clusters.length}`,
    `- Likely automation/update PRs: ${analysis.likelyAutomationCount}`,
    `- Risk mix: low=${analysis.lowRiskCount}, medium=${analysis.mediumRiskCount}, high=${analysis.highRiskCount}`,
    "",
    "## Daily Target",
    `- Mode: ${plan.mode}`,
    `- Target decisions: ${plan.targetDecisions}`,
    `- Expected decisions from selected queue: ${plan.expectedDecisions}`,
    `- Expected PRs to actively review: ${plan.expectedReviews}`,
    `- Dedupe decisions: ${plan.expectedClusterDecisions}`,
    `- Single decisions: ${plan.expectedSingleDecisions}`,
    `- Decision gain ratio: ${plan.decisionGainRatio.toFixed(2)}`,
    `- Lane totals: cluster=${plan.laneTotals.cluster}, fast=${plan.laneTotals.fast}, deep=${plan.laneTotals.deep}`,
    `- Policy-flagged items in queue: ${flaggedCount}`,
    "",
    "## Cluster Lane",
    "| Representative | Origin | Decision Gain | Members | Confidence | Coverage | Policy Flags | Risk | Effort |",
    "| --- | --- | ---: | --- | --- | ---: | --- | --- | ---: |",
    ...(clusterRows.length > 0 ? clusterRows : ["| (none) | - | 0 | - | - | - | - | - | - |"]),
    "",
    "## Fast Lane",
    "| PR | Policy Flags | Risk | Effort | Author |",
    "| --- | --- | --- | ---: | --- |",
    ...(fastRows.length > 0 ? fastRows : ["| (none) | - | - | - | - |"]),
    "",
    "## Deep Lane",
    "| PR | Policy Flags | Risk | Effort | Author |",
    "| --- | --- | --- | ---: | --- |",
    ...(deepRows.length > 0 ? deepRows : ["| (none) | - | - | - | - |"]),
    "",
  ].join("\n");
}

function sanitizeTsvCell(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

export function toTsv(plan: DailyPlan): string {
  const header = [
    "lane",
    "representative_number",
    "origin_number",
    "decision_gain",
    "cluster_confidence",
    "cluster_coverage",
    "policy_flags",
    "risk",
    "effort",
    "author",
    "cluster_id",
    "cluster_members",
    "url",
    "title",
    "rationale",
  ].join("\t");

  const rows = plan.selected.map((item) =>
    [
      item.lane,
      String(item.representativeNumber),
      item.originNumber === null ? "" : String(item.originNumber),
      String(item.decisionGain),
      item.clusterConfidence ?? "",
      item.clusterCoverage === null ? "" : item.clusterCoverage.toFixed(4),
      item.policyFlags.join(","),
      item.risk,
      String(item.effort),
      sanitizeTsvCell(item.author),
      item.clusterId ?? "",
      item.clusterMembers.join(","),
      item.representativeUrl,
      sanitizeTsvCell(item.title),
      sanitizeTsvCell(item.rationale.join("; ")),
    ].join("\t"),
  );

  return `${header}\n${rows.join("\n")}\n`;
}

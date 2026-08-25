/**
 * Builds the Taiga QA audit comment from Orchestrator results.
 *
 * Uses Reviewer-authoritative outcomes and existing artifacts only.
 * Does not invent evidence or change agent decisions.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import type {
  RequirementQaDecision,
  TestCaseFlowResult,
} from "./pipeline.js";
import {
  automationResultsPath,
  reviewerReportPaths,
} from "../artifact-paths.js";

export async function buildQaAuditComment(options: {
  requirementId: string;
  requirementTitle: string;
  decision: RequirementQaDecision;
  results: TestCaseFlowResult[];
  artifactsDir: string;
  repoRoot: string;
}): Promise<string> {
  const {
    requirementId,
    requirementTitle,
    decision,
    results,
    artifactsDir,
    repoRoot,
  } = options;

  const title = requirementTitle.trim() || requirementId;
  const lines: string[] = [
    `QA Reviewer: ${decision.decision}`,
    "",
    `Requirement: ${requirementId} — ${title}`,
  ];

  if (results.length === 1 && results[0]) {
    const result = results[0];
    lines.push(`Test Case: ${result.testCaseId}`);
    lines.push(`Automation: ${result.automationStatus}`);
    lines.push(`Reviewer: ${result.reviewerStatus}`);
    const coverage = coverageLine(result);
    if (coverage) {
      lines.push(`Coverage: ${coverage}`);
    }
  } else {
    lines.push("Test Cases:");
    for (const result of results) {
      const coverage = coverageLine(result);
      const coverageSuffix = coverage ? ` / Coverage: ${coverage}` : "";
      lines.push(
        `- ${result.testCaseId} — Automation ${result.automationStatus} / Reviewer ${result.reviewerStatus}${coverageSuffix}`
      );
    }
    lines.push("");
    lines.push(`Overall Reviewer result: ${decision.decision}`);
  }

  const expectedActual = expectedActualLines(results, decision.decision);
  if (expectedActual.length > 0) {
    lines.push("");
    lines.push(...expectedActual);
  }

  const reason = reasonText(results, decision.decision);
  if (reason) {
    lines.push("");
    lines.push("Reason:");
    lines.push(reason);
  }

  lines.push("");
  lines.push(`Result: ${resultText(decision.decision)}`);
  lines.push("");
  lines.push("QA flow executed by the QA Agents.");
  lines.push("");
  lines.push("Evidence:");

  const evidence = await evidenceLines(results, artifactsDir, repoRoot);
  if (evidence.length === 0) {
    lines.push("- (no generated evidence artifacts were found)");
  } else {
    lines.push(...evidence);
  }

  lines.push("");
  lines.push(`Taiga action: ${decision.taigaStatus}`);

  return lines.join("\n");
}

function coverageLine(result: TestCaseFlowResult): string | undefined {
  const functional = result.reviewerResult?.functionalTestCases.find(
    (testCase) => testCase.id === result.testCaseId
  );
  const coverageStatus =
    functional?.coverageStatus ?? result.automation?.execution.coverageStatus;
  if (!coverageStatus) {
    return undefined;
  }

  const checked =
    functional?.linksChecked ?? result.automation?.execution.linksChecked;
  const discovered =
    functional?.linksDiscovered ?? result.automation?.execution.linksDiscovered;
  if (typeof checked === "number" && typeof discovered === "number") {
    return `${coverageStatus} (${checked}/${discovered} links)`;
  }

  return coverageStatus;
}

function expectedActualLines(
  results: TestCaseFlowResult[],
  decision: RequirementQaDecision["decision"]
): string[] {
  if (decision !== "FAIL") {
    return [];
  }

  for (const result of results) {
    const issue = result.reviewerResult?.productIssues[0];
    const finding = result.reviewerResult?.findings.find(
      (item) => item.classification === "PRODUCT_ISSUE"
    ) ?? result.reviewerResult?.findings[0];
    const source = issue ?? finding;
    if (!source) {
      continue;
    }

    const lines: string[] = [];
    if (source.summary?.trim()) {
      lines.push(`Finding: ${compactText(source.summary, 240)}`);
    }
    if (source.originalUrl?.trim()) {
      lines.push(`Actual: ${source.originalUrl.trim()}`);
    }
    return lines;
  }

  return [];
}

function reasonText(
  results: TestCaseFlowResult[],
  decision: RequirementQaDecision["decision"]
): string | undefined {
  const assessments = results
    .map((result) => result.reviewerResult?.qaAssessment?.trim())
    .filter((value): value is string => Boolean(value));
  if (assessments[0]) {
    return compactText(assessments[0], 600);
  }

  const finding = results
    .flatMap((result) => result.reviewerResult?.findings ?? [])
    .find((item) => item.summary?.trim() || item.rationale?.trim());
  if (finding) {
    return compactText(finding.summary || finding.rationale, 600);
  }

  const gap = results
    .flatMap((result) => result.reviewerResult?.coverageGaps ?? [])
    .find((item) => item.summary?.trim() || item.rationale?.trim());
  if (gap) {
    return compactText(gap.summary || gap.rationale, 600);
  }

  if (decision === "INCONCLUSIVE") {
    const automationError = results.find((result) => result.automationError)
      ?.automationError;
    if (automationError) {
      return compactText(automationError, 400);
    }
  }

  return undefined;
}

function resultText(decision: RequirementQaDecision["decision"]): string {
  if (decision === "PASS") {
    return "Requirement validated successfully by the QA Agents.";
  }
  if (decision === "FAIL") {
    return "Product behavior does not meet the requirement.";
  }
  return "Human QA review required.";
}

async function evidenceLines(
  results: TestCaseFlowResult[],
  artifactsDir: string,
  repoRoot: string
): Promise<string[]> {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const candidates = [
      result.automation?.execution.evidencePath,
      automationResultsPath(
        result.requirementId,
        result.testCaseId,
        artifactsDir
      ),
      reviewerReportPaths(
        result.requirementId,
        result.testCaseId,
        artifactsDir
      ).html,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const relative = await existingRelativePath(candidate, repoRoot);
      if (!relative || seen.has(relative)) {
        continue;
      }
      seen.add(relative);
      const label = relative.includes(`${path.sep}qa-reviewer${path.sep}`)
        ? "Reviewer report"
        : "Automation";
      lines.push(`- ${label}: ${relative}`);
    }
  }

  return lines;
}

async function existingRelativePath(
  filePath: string,
  repoRoot: string
): Promise<string | undefined> {
  try {
    await access(filePath);
  } catch {
    return undefined;
  }

  const relative = path.relative(repoRoot, filePath);
  if (!relative || relative.startsWith("..")) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

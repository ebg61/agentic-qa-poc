/**
 * Canonical artifact locations. Each QA agent owns a directory under artifacts/.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(MODULE_DIR, "..");
export const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");

export const ANALYST_DIR_NAME = "qa-analyst";
export const AUTOMATION_DIR_NAME = "qa-automation";
export const REVIEWER_DIR_NAME = "qa-reviewer";
export const ORCHESTRATOR_DIR_NAME = "qa-orchestrator";

export function analystDir(artifactsDir: string = ARTIFACTS_DIR): string {
  return path.join(artifactsDir, ANALYST_DIR_NAME);
}

export function automationDir(artifactsDir: string = ARTIFACTS_DIR): string {
  return path.join(artifactsDir, AUTOMATION_DIR_NAME);
}

export function reviewerDir(artifactsDir: string = ARTIFACTS_DIR): string {
  return path.join(artifactsDir, REVIEWER_DIR_NAME);
}

export function orchestratorDir(artifactsDir: string = ARTIFACTS_DIR): string {
  return path.join(artifactsDir, ORCHESTRATOR_DIR_NAME);
}

export function analystArtifactPath(
  requirementId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(analystDir(artifactsDir), `${requirementId}.json`);
}

export function automationRequirementPath(
  requirementId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(automationDir(artifactsDir), `${requirementId}.json`);
}

export function automationTestCasePath(
  requirementId: string,
  testCaseId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(
    automationDir(artifactsDir),
    `${requirementId}-${testCaseId}.json`
  );
}

export function automationResultsPath(
  requirementId: string,
  testCaseId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(
    automationDir(artifactsDir),
    `${requirementId}-${testCaseId}-results.json`
  );
}

export function automationTestResultsDir(
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(automationDir(artifactsDir), "test-results");
}

export function reviewerReportPaths(
  requirementId: string,
  testCaseId?: string,
  artifactsDir: string = ARTIFACTS_DIR
): { json: string; html: string } {
  const name = testCaseId
    ? `${requirementId}-${testCaseId}`
    : requirementId;
  const directory = reviewerDir(artifactsDir);
  return {
    json: path.join(directory, `${name}.json`),
    html: path.join(directory, `${name}.html`),
  };
}

export function reviewerFeedbackPath(
  requirementId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(reviewerDir(artifactsDir), `${requirementId}-feedback.json`);
}

export function legacyAnalystArtifactPath(
  requirementId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(artifactsDir, `qa-analysis-${requirementId}.json`);
}

export function legacyAutomationRequirementPath(
  requirementId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(artifactsDir, `qa-automation-${requirementId}.json`);
}

export function legacyAutomationTestCasePath(
  requirementId: string,
  testCaseId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(
    artifactsDir,
    `qa-automation-${requirementId}-${testCaseId}.json`
  );
}

export function legacyReviewerFeedbackPath(
  requirementId: string,
  artifactsDir: string = ARTIFACTS_DIR
): string {
  return path.join(artifactsDir, `qa-feedback-${requirementId}.json`);
}

export async function firstExistingPath(
  ...candidates: Array<string | undefined>
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

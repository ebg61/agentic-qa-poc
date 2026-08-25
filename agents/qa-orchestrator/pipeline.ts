/**
 * Orchestrator coordination of Analyst → Automation → Reviewer.
 *
 * Invokes existing agent entry points. Does not implement QA logic.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestCase } from "../qa-analyst/index.js";
import {
  runQaAutomation,
  type QaAutomationResult,
} from "../qa-automation/index.js";
import {
  runQaReview,
  type QaReviewResult,
} from "../qa-reviewer/index.js";
import { renderQaReviewHtml } from "../qa-reviewer/report.js";
import type { AnalystInvocationResult } from "./handoff.js";
import {
  automationRequirementPath,
  automationResultsPath,
  automationTestCasePath,
  firstExistingPath,
  legacyReviewerFeedbackPath,
  reviewerFeedbackPath,
  reviewerReportPaths,
} from "../artifact-paths.js";

export interface TestCaseFlowResult {
  requirementId: string;
  testCaseId: string;
  analystStatus: "COMPLETED" | "FAILED";
  automationStatus: string;
  reviewerStatus: string;
  automation?: QaAutomationResult;
  reviewerResult?: QaReviewResult;
  automationError?: string;
  reviewerError?: string;
}

export type FinalQaDecision = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface RequirementQaDecision {
  requirementId: string;
  decision: FinalQaDecision;
  taigaStatus: "DONE" | "RETURNED BY QA" | "PENDING QA REVIEW";
}

export async function continueAfterAnalyst(options: {
  analyst: AnalystInvocationResult;
  artifactsDir: string;
  requirementText: string;
  requirementTitle: string;
}): Promise<TestCaseFlowResult[]> {
  const { analyst, artifactsDir, requirementText, requirementTitle } = options;
  const testCases = analyst.analysis.testCases;

  if (testCases.length === 0) {
    console.log("Including QA Automation...");
    console.log("QA Automation: no Test Cases to automate.");
    console.log("");
    console.log("Including QA Reviewer...");
    console.log("QA Reviewer: no Test Cases to review.");
    console.log("");
    return [];
  }

  const results: TestCaseFlowResult[] = [];
  const automationResults: QaAutomationResult[] = [];

  console.log("Including QA Automation...");
  console.log("");

  for (const testCase of testCases) {
    results.push(
      await runAutomationThenReview({
        analyst,
        testCase,
        artifactsDir,
        requirementText,
        requirementTitle,
        automationResults,
      })
    );
  }

  await writeRequirementAutomationArtifact(artifactsDir, automationResults);
  await writeRequirementReviewerArtifact(artifactsDir, results);

  return results;
}

async function runAutomationThenReview(options: {
  analyst: AnalystInvocationResult;
  testCase: TestCase;
  artifactsDir: string;
  requirementText: string;
  requirementTitle: string;
  automationResults: QaAutomationResult[];
}): Promise<TestCaseFlowResult> {
  const {
    analyst,
    testCase,
    artifactsDir,
    requirementText,
    requirementTitle,
    automationResults,
  } = options;
  const requirementId = testCase.requirementId || analyst.requirementId;
  const testCaseId = testCase.id;

  const flow: TestCaseFlowResult = {
    requirementId,
    testCaseId,
    analystStatus: "COMPLETED",
    automationStatus: "NOT_RUN",
    reviewerStatus: "NOT_RUN",
  };

  console.log(`QA Automation:`);
  console.log(`- ${requirementId} / ${testCaseId}`);

  try {
    const automation = await runQaAutomation({
      requirementId,
      testCaseId,
    });
    flow.automation = automation;
    flow.automationStatus = automation.execution.status;
    automationResults.push(automation);
    await writeTestCaseAutomationArtifact(artifactsDir, automation);
    await writeRequirementAutomationArtifact(artifactsDir, automationResults);

    console.log(`- status: ${automation.execution.status}`);
    if (automation.execution.evidencePath) {
      console.log(`- evidence: ${automation.execution.evidencePath}`);
    }
    console.log("");
  } catch (error: unknown) {
    flow.automationStatus = "FAILED";
    flow.automationError = errorMessage(error);
    console.log(`- status: FAILED`);
    console.log(`- error: ${flow.automationError}`);
    console.log("");
  }

  console.log("Including QA Reviewer...");
  console.log("");
  console.log("QA Reviewer:");
  console.log(`- ${requirementId} / ${testCaseId}`);

  try {
    const reviewerResult = await runQaReview({
      requirementId,
      testCaseId,
      requirementText,
      analysisPath: analyst.analysisArtifact,
      automationUsPath: automationRequirementPath(requirementId, artifactsDir),
      automationTcPath: automationTestCasePath(
        requirementId,
        testCaseId,
        artifactsDir
      ),
      executionEvidencePath:
        flow.automation?.execution.evidencePath ??
        automationResultsPath(requirementId, testCaseId, artifactsDir),
      feedbackPath:
        (await firstExistingPath(
          reviewerFeedbackPath(requirementId, artifactsDir),
          legacyReviewerFeedbackPath(requirementId, artifactsDir)
        )) ?? reviewerFeedbackPath(requirementId, artifactsDir),
    });
    flow.reviewerResult = reviewerResult;
    flow.reviewerStatus = reviewerResult.overallAssessment;
    await writeReviewerArtifacts(
      artifactsDir,
      requirementId,
      testCaseId,
      reviewerResult,
      requirementTitle
    );

    console.log(`- status: ${reviewerResult.overallAssessment}`);
    console.log("");
  } catch (error: unknown) {
    flow.reviewerStatus = "FAILED";
    flow.reviewerError = errorMessage(error);
    console.log(`- status: FAILED`);
    console.log(`- error: ${flow.reviewerError}`);
    console.log("");
  }

  return flow;
}

export function aggregateRequirementQaDecision(
  results: TestCaseFlowResult[]
): RequirementQaDecision | undefined {
  if (results.length === 0) {
    return undefined;
  }

  const assessments: FinalQaDecision[] = [];
  for (const result of results) {
    const assessment = result.reviewerResult?.overallAssessment;
    if (
      assessment !== "PASS" &&
      assessment !== "FAIL" &&
      assessment !== "INCONCLUSIVE"
    ) {
      return undefined;
    }
    assessments.push(assessment);
  }

  const decision: FinalQaDecision = assessments.includes("FAIL")
    ? "FAIL"
    : assessments.includes("INCONCLUSIVE")
      ? "INCONCLUSIVE"
      : "PASS";

  return {
    requirementId: results[0]?.requirementId ?? "",
    decision,
    taigaStatus: taigaStatusForDecision(decision),
  };
}

export function taigaStatusForDecision(
  decision: FinalQaDecision
): RequirementQaDecision["taigaStatus"] {
  if (decision === "PASS") {
    return "DONE";
  }
  if (decision === "FAIL") {
    return "RETURNED BY QA";
  }
  return "PENDING QA REVIEW";
}

export function logFinalQaFlow(
  results: TestCaseFlowResult[],
  requirementDecision?: RequirementQaDecision
): void {
  console.log("Final QA flow:");
  if (results.length === 0) {
    console.log("(no test cases)");
  }

  for (const result of results) {
    console.log(`${result.requirementId} / ${result.testCaseId}`);
    console.log(`Analyst: ${result.analystStatus}`);
    console.log(`Automation: ${result.automationStatus}`);
    console.log(`Reviewer: ${result.reviewerStatus}`);
    if (result.automationError) {
      console.log(`Automation error: ${result.automationError}`);
    }
    if (result.reviewerError) {
      console.log(`Reviewer error: ${result.reviewerError}`);
    }
  }
  console.log("");

  if (requirementDecision) {
    console.log(`Final Reviewer decision: ${requirementDecision.decision}`);
    console.log(`Taiga action: ${requirementDecision.taigaStatus}`);
  } else {
    console.log("Final Reviewer decision: unavailable");
    console.log("Taiga action: none");
  }
  console.log("");
}

async function writeTestCaseAutomationArtifact(
  artifactsDir: string,
  result: QaAutomationResult
): Promise<void> {
  const perTestCasePath = automationTestCasePath(
    result.requirementId,
    result.testCaseId,
    artifactsDir
  );
  await mkdir(path.dirname(perTestCasePath), { recursive: true });
  await writeFile(perTestCasePath, JSON.stringify(result, null, 2), "utf8");
}

async function writeRequirementAutomationArtifact(
  artifactsDir: string,
  results: QaAutomationResult[]
): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const byRequirement = new Map<string, QaAutomationResult[]>();
  for (const result of results) {
    const current = byRequirement.get(result.requirementId) ?? [];
    current.push(result);
    byRequirement.set(result.requirementId, current);
  }

  for (const [requirementId, requirementResults] of byRequirement) {
    const requirementPath = automationRequirementPath(
      requirementId,
      artifactsDir
    );
    await mkdir(path.dirname(requirementPath), { recursive: true });
    const payload =
      requirementResults.length === 1 && requirementResults[0]
        ? requirementResults[0]
        : {
            requirementId,
            testCases: requirementResults,
          };
    await writeFile(requirementPath, JSON.stringify(payload, null, 2), "utf8");
  }
}

async function writeReviewerArtifacts(
  artifactsDir: string,
  requirementId: string,
  testCaseId: string,
  reviewerResult: QaReviewResult,
  requirementTitle: string
): Promise<void> {
  const reports = reviewerReportPaths(requirementId, testCaseId, artifactsDir);
  await mkdir(path.dirname(reports.json), { recursive: true });
  const html = renderQaReviewHtml(reviewerResult, { requirementTitle });
  await writeFile(reports.json, JSON.stringify(reviewerResult, null, 2), "utf8");
  await writeFile(reports.html, html, "utf8");
}

async function writeRequirementReviewerArtifact(
  artifactsDir: string,
  results: TestCaseFlowResult[]
): Promise<void> {
  const reviewerResults = results.filter((result) => result.reviewerResult);
  if (reviewerResults.length === 0) {
    return;
  }

  const byRequirement = new Map<string, TestCaseFlowResult[]>();
  for (const result of reviewerResults) {
    const current = byRequirement.get(result.requirementId) ?? [];
    current.push(result);
    byRequirement.set(result.requirementId, current);
  }

  for (const [requirementId, requirementResults] of byRequirement) {
    const payload =
      requirementResults.length === 1 && requirementResults[0]?.reviewerResult
        ? requirementResults[0].reviewerResult
        : {
            requirementId,
            testCases: requirementResults.map((result) => ({
              testCaseId: result.testCaseId,
              reviewerResult: result.reviewerResult,
            })),
          };
    const reports = reviewerReportPaths(requirementId, undefined, artifactsDir);
    await mkdir(path.dirname(reports.json), { recursive: true });
    await writeFile(reports.json, JSON.stringify(payload, null, 2), "utf8");
    const lastReviewerResult =
      requirementResults[requirementResults.length - 1]?.reviewerResult;
    const title = requirementResults[0]?.requirementId ?? requirementId;
    if (lastReviewerResult) {
      await writeFile(
        reports.html,
        renderQaReviewHtml(lastReviewerResult, { requirementTitle: title }),
        "utf8"
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

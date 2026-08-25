/**
 * QA Automation Agent.
 *
 * Consumes QA Analyst output, reuses or generates Playwright automation
 * per requirementId + testCaseId, executes it, and writes evidence.
 *
 * Identity is requirementId + testCaseId. The agent never assumes
 * one requirement = one test case, and never assumes US-001 = TC-001.
 */

import "dotenv/config";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  loadAllAnalystTestCases,
  loadOptionalAnalysis,
  loadTestCase,
  loadTestCases,
  type AnalystTestCase,
} from "./analysis.js";
import { generatePlaywrightSpec } from "./generate.js";
import type { OverlayDismissalResult } from "./overlay.js";
import { toAutomationStatus, type ExecutionStatus } from "./status.js";
import {
  loadApprovedExcludeRules,
  type DiscoveryEvidence,
  type ScopeEvidence,
} from "./scope.js";
import {
  ARTIFACTS_DIR,
  automationDir,
  automationResultsPath,
  firstExistingPath,
  reviewerFeedbackPath,
  legacyReviewerFeedbackPath,
} from "../artifact-paths.js";

const execFileAsync = promisify(execFile);

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(AGENT_DIR, "../..");

const TESTS_DIR = path.resolve(PROJECT_ROOT, "tests");
const TEST_CASES_DIR = path.resolve(PROJECT_ROOT, "test-cases");
const ARTIFACTS_QA_DIR = automationDir(ARTIFACTS_DIR);
const REQUIREMENTS_DIR = path.resolve(PROJECT_ROOT, "requirements");
const PLAYWRIGHT_CONFIG = path.join(PROJECT_ROOT, "playwright.config.ts");

export type AutomationAction = "REUSED_EXISTING" | "GENERATED_NEW";

export type { ExecutionStatus } from "./status.js";

export type CoverageStatus = "COMPLETE" | "PARTIAL";

export type FailureClassification =
  | "PRODUCT_ISSUE"
  | "TEST_ISSUE"
  | "ENVIRONMENT_ISSUE"
  | "EXTERNAL_DEPENDENCY"
  | "INCONCLUSIVE";

export interface AutomationFailure {
  originalUrl?: string;
  finalUrl?: string;
  httpStatus?: number;
  browserNavigationSucceeded?: boolean;
  destinationLoaded?: boolean;
  navigationError?: string;
  classification?: FailureClassification;
  reason?: string;
  kind?: "TECHNICAL" | "FUNCTIONAL";
}

export interface AutomationExecution {
  requirementId: string;
  testCaseId: string;
  status: ExecutionStatus;
  specPath: string;
  evidencePath?: string;

  coverageStatus?: CoverageStatus;
  coverageNote?: string;

  linksDiscovered?: number;
  linksChecked?: number;

  failures: AutomationFailure[];

  command?: string;
  stdout?: string;
  stderr?: string;
  scope?: ScopeEvidence;
  discovery?: DiscoveryEvidence;
  approvedScopeUsed: boolean;
  approvedScopeDecisions: ScopeEvidence["approvedRules"];
  overlay?: OverlayDismissalResult;
}

export interface GeneratedPlaywrightTest {
  sourcePath: string;
  requirementId: string;
  testCaseId: string;
  action: AutomationAction;
}

export interface QaAutomationResult {
  requirementId: string;
  testCaseId: string;
  action: AutomationAction;
  generatedPlaywrightTest: GeneratedPlaywrightTest;
  execution: AutomationExecution;
}

export interface AutomationTarget {
  requirementId: string;
  testCaseId: string;
  testCase: AnalystTestCase;
}

/**
 * Automate and execute one functional test case for one requirement.
 */
export async function runQaAutomation(options: {
  requirementId: string;
  testCaseId: string;
}): Promise<QaAutomationResult> {
  const requirementId = options.requirementId.trim();
  const testCaseId = options.testCaseId.trim();

  if (!requirementId) {
    throw new Error("requirementId must be a non-empty string");
  }
  if (!testCaseId) {
    throw new Error("testCaseId must be a non-empty string");
  }

  const testCase = await loadTestCase(requirementId, testCaseId, TEST_CASES_DIR);

  console.log(
    `[QA Automation] Checking automation for ${requirementId} / ${testCaseId}`
  );

  const existingSpec = await findExistingAutomation(requirementId, testCaseId);

  let specPath: string;
  let action: AutomationAction;

  if (existingSpec) {
    action = "REUSED_EXISTING";
    specPath = existingSpec;

    console.log(
      `[QA Automation] ${requirementId} / ${testCaseId} -> existing automation found`
    );
    console.log("[QA Automation] Reusing existing automation");
    console.log(`[QA Automation] Reusing existing automation: ${specPath}`);
    console.log(`[QA Automation] Action: ${action}`);
  } else {
    action = "GENERATED_NEW";

    console.log(
      `[QA Automation] ${requirementId} / ${testCaseId} -> no existing automation found`
    );

    specPath = generatedSpecPath(requirementId, testCaseId);
    const evidencePath = generatedEvidencePath(requirementId, testCaseId);
    const requirementText = await readOptionalRequirement(requirementId);
    const analysisArtifact = await loadOptionalAnalysis(
      ARTIFACTS_DIR,
      requirementId
    );

    try {
      await generatePlaywrightSpec({
        requirementId,
        testCase,
        specPath,
        evidencePath,
        requirementText,
        analysis: analysisArtifact?.analysis,
        strategy: analysisArtifact?.strategy,
      });
    } catch (error: unknown) {
      const reason =
        error instanceof Error
          ? error.message
          : "Playwright spec generation failed.";
      console.log(`[QA Automation] Generation failed: ${reason}`);
      return {
        requirementId,
        testCaseId,
        action,
        generatedPlaywrightTest: {
          sourcePath: specPath,
          requirementId,
          testCaseId,
          action,
        },
        execution: {
          requirementId,
          testCaseId,
          status: "FAILED",
          specPath,
          coverageStatus: "PARTIAL",
          coverageNote: reason,
          failures: [{ reason }],
          approvedScopeUsed: false,
          approvedScopeDecisions: [],
        },
      };
    }

    console.log(`[QA Automation] Generated: ${specPath}`);
    console.log(`[QA Automation] Action: ${action}`);
  }

  const feedbackPath = await feedbackPathFor(requirementId);
  const approvedRules = await loadApprovedExcludeRules(
    feedbackPath,
    testCaseId,
    requirementId
  );

  console.log("[QA Automation] Loading approved QA scope decisions...");
  if (approvedRules.length === 0) {
    console.log("[QA Automation] No approved QA scope exclusions.");
  } else {
    for (const rule of approvedRules) {
      console.log(`[QA Automation] Approved exclusion: ${rule.target}`);
    }
  }

  console.log(`[QA Automation] Executing ${requirementId} / ${testCaseId}`);

  const execution = await executePlaywrightTest({
    requirementId,
    testCaseId,
    specPath,
    feedbackPath,
    approvedRules,
  });

  if (execution.scope) {
    console.log("[QA Automation] Automation scope:");
    console.log(`- Discovered: ${execution.scope.discovered}`);
    console.log(
      `- Approved exclusions: ${execution.scope.approvedRules.length}`
    );
    console.log(`- Excluded: ${execution.scope.excluded}`);
    console.log(`- Applicable: ${execution.scope.applicable}`);
  }

  return {
    requirementId,
    testCaseId,
    action,
    generatedPlaywrightTest: {
      sourcePath: specPath,
      requirementId,
      testCaseId,
      action,
    },
    execution,
  };
}

export async function listAutomationTargets(
  requirementId?: string
): Promise<AutomationTarget[]> {
  if (requirementId) {
    const testCases = await loadTestCases(requirementId, TEST_CASES_DIR);
    return testCases.map((testCase) => ({
      requirementId: testCase.requirementId,
      testCaseId: testCase.id,
      testCase,
    }));
  }

  const testCases = await loadAllAnalystTestCases(TEST_CASES_DIR);
  return testCases.map((testCase) => ({
    requirementId: testCase.requirementId,
    testCaseId: testCase.id,
    testCase,
  }));
}

/**
 * Find existing Playwright automation for a requirementId + testCaseId pair.
 *
 * Exact path only: tests/{requirementId}/{testCaseId}.spec.ts
 * No substring search. A spec for another pair is never reused.
 */
export async function findExistingAutomation(
  requirementId: string,
  testCaseId: string
): Promise<string | undefined> {
  const specPath = generatedSpecPath(requirementId, testCaseId);
  if (await fileExists(specPath)) {
    return specPath;
  }

  return undefined;
}

function generatedSpecPath(requirementId: string, testCaseId: string): string {
  return path.join(TESTS_DIR, requirementId, `${testCaseId}.spec.ts`);
}

function generatedEvidencePath(
  requirementId: string,
  testCaseId: string
): string {
  return automationResultsPath(requirementId, testCaseId, ARTIFACTS_DIR);
}

async function feedbackPathFor(requirementId: string): Promise<string> {
  if (process.env.QA_FEEDBACK_PATH) {
    return process.env.QA_FEEDBACK_PATH;
  }
  return (
    (await firstExistingPath(
      reviewerFeedbackPath(requirementId, ARTIFACTS_DIR),
      legacyReviewerFeedbackPath(requirementId, ARTIFACTS_DIR)
    )) ?? reviewerFeedbackPath(requirementId, ARTIFACTS_DIR)
  );
}

async function executePlaywrightTest(options: {
  requirementId: string;
  testCaseId: string;
  specPath: string;
  feedbackPath: string;
  approvedRules: ScopeEvidence["approvedRules"];
}): Promise<AutomationExecution> {
  const { requirementId, testCaseId, specPath, feedbackPath, approvedRules } =
    options;

  const specArg = specPath.startsWith(TESTS_DIR)
    ? path.relative(TESTS_DIR, specPath)
    : path.relative(PROJECT_ROOT, specPath);
  const outputDir = path.join(ARTIFACTS_QA_DIR, "test-results");
  const expectedEvidencePath = expectedEvidencePathFor(
    requirementId,
    testCaseId
  );

  const command = [
    "npx",
    "playwright",
    "test",
    specArg,
    "--config",
    PLAYWRIGHT_CONFIG,
    "--project=chromium",
    "--reporter=line",
    "--output",
    outputDir,
  ].join(" ");

  console.log(`[QA Automation] Command: ${command}`);

  let stdout = "";
  let stderr = "";
  let processFailed = false;

  try {
    const result = await execFileAsync(
      "npx",
      [
        "playwright",
        "test",
        specArg,
        "--config",
        PLAYWRIGHT_CONFIG,
        "--project=chromium",
        "--reporter=line",
        "--output",
        outputDir,
      ],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          FUNCTIONAL_TEST_CASE_ID: testCaseId,
          REQUIREMENT_ID: requirementId,
          QA_FEEDBACK_PATH: feedbackPath,
          EVIDENCE_PATH: expectedEvidencePath,
        },
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (error: unknown) {
    processFailed = true;

    if (isExecError(error)) {
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
    } else {
      stderr = error instanceof Error ? error.message : String(error);
    }
  }

  const evidence = await readExecutionEvidence(
    requirementId,
    testCaseId,
    expectedEvidencePath
  );

  const scope = evidence?.scope;
  const approvedScopeDecisions =
    scope?.approvedRules.length ? scope.approvedRules : approvedRules;
  const approvedScopeUsed = approvedScopeDecisions.length > 0;

  if (evidence) {
    let failures = evidenceFailures(evidence);
    if (
      evidence.overlay?.overlayDetected &&
      !evidence.overlay.functionalTestContinued
    ) {
      if (failures.length === 0) {
        failures = [
          {
            reason:
              evidence.overlay.reason ??
              "A blocking overlay could not be dismissed, so Playwright execution failed.",
          },
        ];
      }
    }
    const resolved = resolveExecutionFromEvidence(
      evidence,
      processFailed
    );

    if (evidence.overlay) {
      logOverlay(evidence.overlay);
    }

    return {
      requirementId,
      testCaseId,
      status: resolved.status,
      specPath,
      evidencePath: evidence.sourcePath,
      coverageStatus: resolved.coverageStatus,
      coverageNote: resolved.coverageNote,
      linksDiscovered: evidence.linksDiscovered,
      linksChecked: evidence.linksChecked,
      failures,
      command,
      stdout,
      stderr,
      scope,
      discovery: evidence.discovery,
      overlay: evidence.overlay,
      approvedScopeUsed,
      approvedScopeDecisions,
    };
  }

  return {
    requirementId,
    testCaseId,
    status: "FAILED",
    specPath,
    evidencePath: expectedEvidencePath,
    failures: [
      {
        classification: "ENVIRONMENT_ISSUE",
        reason: processFailed
          ? "Playwright execution failed or timed out before a usable automation evidence artifact was written."
          : "Playwright execution completed without a usable automation evidence artifact.",
      },
    ],
    command,
    stdout,
    stderr,
    approvedScopeUsed,
    approvedScopeDecisions,
  };
}

function expectedEvidencePathFor(
  requirementId: string,
  testCaseId: string
): string {
  return generatedEvidencePath(requirementId, testCaseId);
}

function resolveExecutionFromEvidence(
  evidence: AutomationEvidence,
  processFailed: boolean
): {
  status: ExecutionStatus;
  coverageStatus?: CoverageStatus;
  coverageNote?: string;
} {
  const status = toAutomationStatus({
    evidenceStatus: evidence.status,
    processFailed,
    validationsSatisfied: evidence.validationsSatisfied,
  });
  let coverageStatus = evidence.coverageStatus;
  let coverageNote = evidence.coverageNote;

  if (processFailed) {
    coverageStatus = coverageStatus ?? "PARTIAL";
    const timeoutNote =
      "Playwright execution stopped before the required Test Case scope was completed.";
    coverageNote = coverageNote?.includes(timeoutNote)
      ? coverageNote
      : [coverageNote, timeoutNote].filter(Boolean).join(" ");
  }

  if (
    evidence.overlay?.overlayDetected &&
    !evidence.overlay.functionalTestContinued
  ) {
    const overlayNote =
      evidence.overlay.reason ??
      "A blocking overlay could not be dismissed, so Playwright execution failed.";
    coverageStatus = coverageStatus ?? "PARTIAL";
    coverageNote = coverageNote?.includes(overlayNote)
      ? coverageNote
      : [coverageNote, overlayNote].filter(Boolean).join(" ");
  }

  return { status, coverageStatus, coverageNote };
}

async function readExecutionEvidence(
  requirementId: string,
  testCaseId: string,
  expectedEvidencePath: string
): Promise<(AutomationEvidence & { sourcePath: string }) | undefined> {
  const candidates = [
    expectedEvidencePath,
    generatedEvidencePath(requirementId, testCaseId),
    path.join(
      ARTIFACTS_QA_DIR,
      `${requirementId}-${testCaseId}-link-results.json`
    ),
  ];

  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (!(await fileExists(candidate))) {
      continue;
    }

    try {
      const raw = await readFile(candidate, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const evidence = asAutomationEvidence(parsed, requirementId, testCaseId);

      if (evidence) {
        return {
          ...evidence,
          sourcePath: candidate,
        };
      }
    } catch {
      // Continue with the next possible evidence file.
    }
  }

  return undefined;
}

interface AutomationEvidence {
  requirementId?: string;
  testCaseId: string;
  status?: string;
  validationsSatisfied?: boolean;
  linksDiscovered?: number;
  linksChecked?: number;
  coverageStatus?: CoverageStatus;
  coverageNote?: string;
  perLinkResults?: unknown[];
  failures?: unknown[];
  scope?: ScopeEvidence;
  discovery?: DiscoveryEvidence;
  overlay?: OverlayDismissalResult;
}

function asAutomationEvidence(
  value: unknown,
  requirementId: string,
  testCaseId: string
): AutomationEvidence | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const object = value as Record<string, unknown>;
  if (typeof object.testCaseId !== "string") {
    return undefined;
  }

  if (object.testCaseId.trim() !== testCaseId) {
    return undefined;
  }

  const evidenceRequirementId =
    typeof object.requirementId === "string"
      ? object.requirementId.trim()
      : "";

  if (evidenceRequirementId && evidenceRequirementId !== requirementId) {
    return undefined;
  }

  const hasLinkShape =
    Array.isArray(object.perLinkResults) &&
    (typeof object.linksDiscovered === "number" ||
      typeof object.linksChecked === "number" ||
      object.perLinkResults.length >= 0);

  const hasGenericShape =
    object.status === "PASSED" ||
    object.status === "FAILED" ||
    object.status === "INCONCLUSIVE" ||
    Array.isArray(object.failures);

  if (!hasLinkShape && !hasGenericShape) {
    return undefined;
  }

  return {
    requirementId: evidenceRequirementId || requirementId,
    testCaseId,
    status:
      object.status === "PASSED" ||
      object.status === "FAILED" ||
      object.status === "INCONCLUSIVE"
        ? object.status
        : undefined,
    validationsSatisfied:
      typeof object.validationsSatisfied === "boolean"
        ? object.validationsSatisfied
        : undefined,
    linksDiscovered:
      typeof object.linksDiscovered === "number"
        ? object.linksDiscovered
        : Array.isArray(object.perLinkResults)
          ? object.perLinkResults.length
          : undefined,
    linksChecked:
      typeof object.linksChecked === "number"
        ? object.linksChecked
        : Array.isArray(object.perLinkResults)
          ? object.perLinkResults.length
          : undefined,
    coverageStatus:
      object.coverageStatus === "COMPLETE" || object.coverageStatus === "PARTIAL"
        ? object.coverageStatus
        : undefined,
    coverageNote:
      typeof object.coverageNote === "string" ? object.coverageNote : undefined,
    perLinkResults: Array.isArray(object.perLinkResults)
      ? object.perLinkResults
      : undefined,
    failures: Array.isArray(object.failures) ? object.failures : undefined,
    scope: readScopeEvidence(object.scope),
    discovery: readDiscoveryEvidence(object.discovery),
    overlay: asOverlayDismissal(object.overlay),
  };
}

function asOverlayDismissal(value: unknown): OverlayDismissalResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.overlayDetected !== "boolean") {
    return undefined;
  }
  const method = record.dismissalMethod;
  if (
    method !== undefined &&
    method !== "click_outside" &&
    method !== "visible_dismiss_control" &&
    method !== "none"
  ) {
    return undefined;
  }
  return {
    overlayDetected: record.overlayDetected,
    dismissalAttempted: record.dismissalAttempted === true,
    dismissalMethod: method ?? "none",
    dismissalSucceeded: record.dismissalSucceeded === true,
    functionalTestContinued: record.functionalTestContinued === true,
    overlayDescription:
      typeof record.overlayDescription === "string"
        ? record.overlayDescription
        : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

function logOverlay(overlay: OverlayDismissalResult): void {
  console.log("[QA Automation] Overlay handling:");
  console.log(`- detected: ${overlay.overlayDetected}`);
  console.log(`- dismissal attempted: ${overlay.dismissalAttempted}`);
  console.log(`- dismissal method: ${overlay.dismissalMethod}`);
  console.log(`- dismissal succeeded: ${overlay.dismissalSucceeded}`);
  console.log(`- functional test continued: ${overlay.functionalTestContinued}`);
  if (overlay.overlayDescription) {
    console.log(`- description: ${overlay.overlayDescription}`);
  }
  if (overlay.reason) {
    console.log(`- reason: ${overlay.reason}`);
  }
}

function evidenceFailures(evidence: AutomationEvidence): AutomationFailure[] {
  if (Array.isArray(evidence.failures) && evidence.failures.length > 0) {
    return evidence.failures.map((item) => normalizeFailure(item));
  }

  if (!Array.isArray(evidence.perLinkResults)) {
    return [];
  }

  return evidence.perLinkResults
    .filter((item) => isFailedLinkResult(item))
    .map((item) => normalizeFailure(item));
}

function isFailedLinkResult(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Record<string, unknown>;
  const outcome =
    typeof item.outcome === "string"
      ? item.outcome
      : typeof item.result === "string"
        ? item.result
        : "";

  return outcome === "FAIL" || outcome === "FAILED";
}

function readScopeEvidence(value: unknown): ScopeEvidence | undefined {
  return isScopeEvidence(value) ? value : undefined;
}

function readDiscoveryEvidence(value: unknown): DiscoveryEvidence | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const discovery = value as Record<string, unknown>;
  if (
    typeof discovery.initialCount !== "number" ||
    typeof discovery.afterStabilizationCount !== "number" ||
    typeof discovery.finalDeduplicatedCount !== "number" ||
    typeof discovery.applicableCount !== "number" ||
    typeof discovery.checkedCount !== "number"
  ) {
    return undefined;
  }

  return {
    initialCount: discovery.initialCount,
    afterStabilizationCount: discovery.afterStabilizationCount,
    finalDeduplicatedCount: discovery.finalDeduplicatedCount,
    applicableCount: discovery.applicableCount,
    checkedCount: discovery.checkedCount,
    scrollPasses:
      typeof discovery.scrollPasses === "number"
        ? discovery.scrollPasses
        : undefined,
    stabilized:
      typeof discovery.stabilized === "boolean"
        ? discovery.stabilized
        : undefined,
  };
}

function isScopeEvidence(value: unknown): value is ScopeEvidence {
  if (!value || typeof value !== "object") {
    return false;
  }

  const scope = value as Record<string, unknown>;

  return (
    typeof scope.discovered === "number" &&
    typeof scope.excluded === "number" &&
    typeof scope.applicable === "number" &&
    Array.isArray(scope.approvedRules) &&
    Array.isArray(scope.excludedUrls)
  );
}

function normalizeFailure(value: unknown): AutomationFailure {
  if (!value || typeof value !== "object") {
    return {
      classification: "ENVIRONMENT_ISSUE",
      reason: "Invalid failure evidence.",
    };
  }

  const item = value as Record<string, unknown>;

  return {
    originalUrl:
      typeof item.originalUrl === "string"
        ? item.originalUrl
        : typeof item.discoveredUrl === "string"
          ? item.discoveredUrl
          : undefined,
    finalUrl:
      typeof item.finalUrl === "string"
        ? item.finalUrl
        : typeof item.observedUrl === "string"
          ? item.observedUrl
          : undefined,
    httpStatus: typeof item.httpStatus === "number" ? item.httpStatus : undefined,
    browserNavigationSucceeded:
      typeof item.browserNavigationSucceeded === "boolean"
        ? item.browserNavigationSucceeded
        : undefined,
    destinationLoaded:
      typeof item.destinationLoaded === "boolean"
        ? item.destinationLoaded
        : undefined,
    navigationError:
      typeof item.navigationError === "string"
        ? item.navigationError
        : undefined,
    classification: isFailureClassification(item.classification)
      ? item.classification
      : undefined,
    reason: typeof item.reason === "string" ? item.reason : undefined,
    kind: item.kind === "TECHNICAL" || item.kind === "FUNCTIONAL"
      ? item.kind
      : undefined,
  };
}

function isFailureClassification(
  value: unknown
): value is FailureClassification {
  return (
    value === "PRODUCT_ISSUE" ||
    value === "TEST_ISSUE" ||
    value === "ENVIRONMENT_ISSUE" ||
    value === "EXTERNAL_DEPENDENCY" ||
    value === "INCONCLUSIVE"
  );
}

function isExecError(error: unknown): error is {
  stdout?: string;
  stderr?: string;
  message?: string;
} {
  return typeof error === "object" && error !== null;
}

async function readOptionalRequirement(
  requirementId: string
): Promise<string | undefined> {
  try {
    return await readFile(
      path.join(REQUIREMENTS_DIR, `${requirementId}.md`),
      "utf8"
    );
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

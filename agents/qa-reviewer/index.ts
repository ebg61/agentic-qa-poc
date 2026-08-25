/**
 * QA Reviewer Agent.
 *
 * Reads existing Analyst and Automation artifacts, asks the LLM to assess
 * product quality, and returns a structured QA review.
 *
 * Does not execute Playwright, browse the product, or create tests.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmClient, type LlmClient } from "../qa-analyst/llm-client.js";
import { parseJsonObject } from "../qa-analyst/validate.js";
import {
  ARTIFACTS_DIR,
  analystArtifactPath,
  automationRequirementPath,
  automationResultsPath,
  automationTestCasePath,
  firstExistingPath,
  legacyAnalystArtifactPath,
  legacyAutomationRequirementPath,
  legacyAutomationTestCasePath,
  legacyReviewerFeedbackPath,
  reviewerFeedbackPath,
} from "../artifact-paths.js";

const agentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(agentDir, "../..");

const DEFAULT_REQUIREMENT_ID = "US-001";

const OUTPUT_CONTRACT = `
## Output format

Return a single JSON object only. No markdown. No commentary.

{
  "requirementId": string,
  "overallAssessment": "PASS" | "FAIL" | "INCONCLUSIVE",
  "functionalTestCases": [
    {
      "id": string,
      "status": "PASSED" | "FAILED" | "INCONCLUSIVE",
      "coverageStatus": "COMPLETE" | "PARTIAL" | "UNKNOWN",
      "linksDiscovered": number (optional; omit unless the Test Case is a link/destination collection),
      "linksChecked": number (optional; omit unless the Test Case is a link/destination collection)
    }
  ],
  "findings": [
    {
      "summary": string,
      "classification": "PRODUCT_ISSUE" | "TEST_ISSUE" | "ENVIRONMENT_ISSUE" | "EXTERNAL_DEPENDENCY" | "INCONCLUSIVE",
      "originalUrl": string,
      "httpStatus": number,
      "rationale": string
    }
  ],
  "productIssues": [
    {
      "summary": string,
      "originalUrl": string,
      "httpStatus": number,
      "rationale": string
    }
  ],
  "coverageGaps": [
    {
      "summary": string,
      "rationale": string
    }
  ],
  "artifactInconsistencies": [
    {
      "summary": string,
      "artifacts": string[],
      "strongerEvidence": string,
      "rationale": string
    }
  ],
  "recommendations": string[],
  "qaAssessment": string
}

Rules:

- Derive every value from the supplied artifacts. Do not hardcode counts.
- Do not invent missing evidence.
- Judge evidence against the Requirement/Test Case being validated. Evidence schemas vary.
- The current per-execution results artifact (artifacts/qa-automation/{requirementId}-{testCaseId}-results.json) is authoritative for functional evidence.
- Aggregate or historical Automation JSON may provide process context. It must not override contradictory current per-execution evidence when that artifact is internally consistent and complete.
- Do not require linksDiscovered, linksChecked, browserNavigationSucceeded, or destinationLoadedCount unless they are relevant to this Test Case.
- Do not treat those fields being zero or absent as missing evidence for a non-collection Test Case (for example a homepage-load / visible-content case).
- If Automation PASSED, coverage is complete for this Test Case, and the current artifact contains sufficient user-facing evidence for the acceptance criteria, return PASS.
- For a homepage-load requirement, valid evidence may include HTTP 200, correct final URL, visible brand/content, no unresolved overlay, no error-like page, visibility observations, screenshot, and complete coverage.
- Ask: does the evidence prove that the intended user can perform the required behavior and obtain the expected user-facing result?
- Treat browser/user interaction evidence as primary when the Test Case requires interaction.
- Treat HTTP/API/network/DOM evidence as supporting evidence unless the Test Case explicitly requires that technical behavior.
- Do not mark a Test Case PASS merely because an endpoint returns 200 or a technical request succeeds if the user-facing interaction was not validated.
- Do not mark a Test Case PASS if Automation silently tested only a subset of the required user behavior.
- Use PASS only when evidence demonstrates the required user-facing behavior works.
- Use FAIL only when evidence demonstrates an actual product/functional defect or the acceptance criterion is demonstrably not met.
- Automation FAILED does not imply Reviewer FAIL. Inspect why Automation failed.
- Decision order: (1) If the required functional result was evaluated and observed does not satisfy expected, return FAIL. (2) Else if the Test Case was successfully evaluated and satisfied, return PASS. (3) Else if execution or evidence is insufficient to determine the functional result, return INCONCLUSIVE.
- A technical error after a proven functional mismatch remains FAIL. A technical error that prevents the functional requirement from being evaluated is INCONCLUSIVE.
- Incomplete collection or coverage without a proven functional mismatch is INCONCLUSIVE. Do not treat incomplete discovery as proof that the product is missing the remaining items.
- TECHNICAL evidence by itself is not FAIL. A FUNCTIONAL expected-versus-observed mismatch remains FAIL even if overlays, retries, or later technical errors also occurred.
- Use INCONCLUSIVE when Automation failed to execute, the spec had a syntax error, a locator was missing, the environment blocked execution, a timeout occurred before usable product evidence, required user-facing evidence is missing, or the evidence is otherwise insufficient to prove PASS or FAIL.
- Keep productIssues empty unless the current execution evidence supports a product defect.
- Identify whether a failure affects the intended user's experience.
- Preserve requirementId on the review output. Keep each functionalTestCases[].id as the testCaseId. Identify requirementId and testCaseId in finding summaries or rationale.
- Base the primary assessment on the current per-execution results artifact.
- If current detailed evidence contradicts an older aggregate artifact, report the discrepancy and use the current per-execution evidence for the functional decision when it is internally consistent and complete.
- Do not merge historical failures into the current execution.
- Do not treat Playwright exit code 0 as a functional PASS.
- Do not copy Automation execution.status onto overallAssessment.
- Do not treat COMPLETE coverage as a functional PASS by itself.
- Do not automatically reclassify Automation classifications.
- Do not treat a third-party HTTP 400 as a product defect without evidence.
- Include artifact inconsistencies when the supplied Automation artifacts disagree.
- Keep qaAssessment concise and proportional.
- Never set approvedByQA.
- Never treat a finding as a scope recommendation.
- Do not create a scope recommendation only because a test remains FAIL or INCONCLUSIVE.
- A scope recommendation requires an independent scope rationale.
- If supplied human QA feedback already contains an approved exclusion for the same requirement, test case, and target, do not recommend another exclusion for that condition.
- If there is no independent scope rationale, omit scopeRecommendations or return an empty array.

Optional field:

"scopeRecommendations": [
  {
    "testCaseId": string,
    "target": string,
    "proposedAction": "EXCLUDE",
    "rationale": string
  }
]
`;

export type OverallAssessment = "PASS" | "FAIL" | "INCONCLUSIVE";
export type FunctionalStatus = "PASSED" | "FAILED" | "INCONCLUSIVE";
export type CoverageStatus = "COMPLETE" | "PARTIAL" | "UNKNOWN";
export type FailureClassification =
  | "PRODUCT_ISSUE"
  | "TEST_ISSUE"
  | "ENVIRONMENT_ISSUE"
  | "EXTERNAL_DEPENDENCY"
  | "INCONCLUSIVE";

export interface FunctionalTestCaseReview {
  id: string;
  status: FunctionalStatus;
  coverageStatus: CoverageStatus;
  linksDiscovered?: number;
  linksChecked?: number;
}

export interface ReviewFinding {
  summary: string;
  classification?: FailureClassification;
  originalUrl?: string;
  httpStatus?: number;
  rationale: string;
}

export interface CoverageGap {
  summary: string;
  rationale: string;
}

export interface ArtifactInconsistency {
  summary: string;
  artifacts: string[];
  strongerEvidence: string;
  rationale: string;
}

export interface ScopeRecommendation {
  testCaseId: string;
  target: string;
  proposedAction: "EXCLUDE";
  rationale: string;
}

export interface QaReviewResult {
  requirementId: string;
  overallAssessment: OverallAssessment;
  functionalTestCases: FunctionalTestCaseReview[];
  findings: ReviewFinding[];
  productIssues: ReviewFinding[];
  coverageGaps: CoverageGap[];
  artifactInconsistencies: ArtifactInconsistency[];
  recommendations: string[];
  scopeRecommendations: ScopeRecommendation[];
  qaAssessment: string;
}

export interface RunQaReviewOptions {
  requirementId?: string;
  testCaseId?: string;
  requirementPath?: string;
  requirementText?: string;
  analysisPath?: string;
  automationUsPath?: string;
  automationTcPath?: string;
  executionEvidencePath?: string;
  feedbackPath?: string;
  llm?: LlmClient;
}

export async function runQaReview(
  options: RunQaReviewOptions = {}
): Promise<QaReviewResult> {
  const requirementId = options.requirementId ?? DEFAULT_REQUIREMENT_ID;
  const testCaseId = options.testCaseId?.trim();
  const llm = options.llm ?? createLlmClient();

  const analysisPath =
    options.analysisPath ??
    ((await firstExistingPath(
      analystArtifactPath(requirementId, ARTIFACTS_DIR),
      legacyAnalystArtifactPath(requirementId, ARTIFACTS_DIR)
    )) ?? analystArtifactPath(requirementId, ARTIFACTS_DIR));
  const automationUsPath =
    options.automationUsPath ??
    ((await firstExistingPath(
      automationRequirementPath(requirementId, ARTIFACTS_DIR),
      legacyAutomationRequirementPath(requirementId, ARTIFACTS_DIR)
    )) ?? automationRequirementPath(requirementId, ARTIFACTS_DIR));
  const automationTcPath =
    options.automationTcPath ??
    (testCaseId
      ? ((await firstExistingPath(
          automationTestCasePath(requirementId, testCaseId, ARTIFACTS_DIR),
          legacyAutomationTestCasePath(
            requirementId,
            testCaseId,
            ARTIFACTS_DIR
          )
        )) ??
        automationTestCasePath(requirementId, testCaseId, ARTIFACTS_DIR))
      : automationRequirementPath(requirementId, ARTIFACTS_DIR));
  const executionEvidencePath =
    options.executionEvidencePath ??
    (testCaseId
      ? automationResultsPath(requirementId, testCaseId, ARTIFACTS_DIR)
      : automationResultsPath(requirementId, "TC-001", ARTIFACTS_DIR));
  const feedbackPath =
    options.feedbackPath ??
    ((await firstExistingPath(
      reviewerFeedbackPath(requirementId, ARTIFACTS_DIR),
      legacyReviewerFeedbackPath(requirementId, ARTIFACTS_DIR)
    )) ?? reviewerFeedbackPath(requirementId, ARTIFACTS_DIR));
  const requirementPath =
    options.requirementPath ??
    path.join(repoRoot, "requirements", `${requirementId}.md`);

  const [instructions, analysisJson] = await Promise.all([
    readText(path.join(agentDir, "instructions.md"), "reviewer instructions"),
    readText(analysisPath, "QA Analyst output"),
  ]);

  const requirementFromMarkdown = await readOptionalText(requirementPath);
  const requirement =
    options.requirementText?.trim() ||
    requirementFromMarkdown ||
    requirementContextFromAnalysis(analysisJson, requirementId);

  if (!requirement) {
    throw new Error(
      `Unable to load requirement ${requirementId}: requirements/${requirementId}.md was not found and the Analyst artifact did not contain usable requirement context.`
    );
  }

  if (!options.requirementText?.trim() && !requirementFromMarkdown) {
    console.log(
      `[QA Reviewer] Using Analyst artifact for requirement context (${requirementId}); local markdown was not found.`
    );
  }

  const automationUs = await readOptionalJson(
    automationUsPath,
    path.basename(automationUsPath)
  );
  const automationTc = await readOptionalJson(
    automationTcPath,
    path.basename(automationTcPath)
  );
  const executionEvidence = await readOptionalJson(
    executionEvidencePath,
    path.basename(executionEvidencePath)
  );
  const qaFeedback = await readOptionalJson(
    feedbackPath,
    path.basename(feedbackPath)
  );
  const testCasePath = testCaseId
    ? path.join(repoRoot, "test-cases", requirementId, `${testCaseId}.json`)
    : undefined;
  const canonicalTestCase = testCasePath
    ? await readOptionalJson(testCasePath, path.basename(testCasePath))
    : undefined;

  const userPrompt = [
    `Requirement ID: ${requirementId}`,
    testCaseId ? `Test case ID: ${testCaseId}` : "",
    "",
    "Original business requirement:",
    requirement,
    "",
    "QA Analyst output (JSON):",
    analysisJson,
    "",
    canonicalTestCase
      ? `Canonical Test Case: ${path.relative(repoRoot, canonicalTestCase.path)}`
      : "",
    canonicalTestCase ? stringifyArtifact(canonicalTestCase) : "",
    "",
    `AUTHORITATIVE current per-execution results: ${path.relative(repoRoot, executionEvidencePath)}`,
    stringifyArtifact(
      presentAuthoritativeExecutionEvidence(executionEvidence)
    ),
    "",
    "Secondary Automation artifacts (process context only; do not override the current per-execution results when those results are internally consistent):",
    `Automation artifact: ${path.relative(repoRoot, automationUsPath)}`,
    stringifyArtifact(automationUs),
    "",
    `Automation artifact: ${path.relative(repoRoot, automationTcPath)}`,
    stringifyArtifact(automationTc),
    "",
    `Automation process summary: ${path.relative(repoRoot, automationTcPath)}`,
    stringifyArtifact(summarizeAutomationProcess(automationTc ?? automationUs)),
    "",
    `Human QA feedback: ${path.relative(repoRoot, feedbackPath)}`,
    stringifyArtifact(qaFeedback),
    "",
    testCaseId
      ? `Focus this review on ${requirementId} / ${testCaseId}. Judge the Automation evidence against that Analyst Test Case.`
      : "",
    "Use the AUTHORITATIVE current per-execution results artifact as the primary functional evidence.",
    "Evaluate evidence according to this Requirement/Test Case. Do not require generic collection fields unless they are relevant.",
    "Do not downgrade a valid Automation PASS because linksDiscovered, linksChecked, browserNavigationSucceeded, or destinationLoadedCount are zero or absent.",
    "If current detailed evidence contradicts an older aggregate artifact, report the discrepancy and use the current per-execution evidence when it is internally consistent and complete.",
    "Judge whether that evidence proves the intended user can perform the Test Case behavior and obtain the expected user-facing result.",
    "Do not treat HTTP/API success as PASS if the required user interaction was not validated.",
    "If Automation PASSED and the current artifact contains sufficient user-facing evidence for the acceptance criteria, return PASS.",
    "Automation FAILED does not imply Reviewer FAIL. Inspect why Automation failed.",
    "If the required functional result was evaluated and observed does not satisfy expected, return FAIL even when overlays or later technical errors are also present.",
    "Use FAIL only when evidence demonstrates an actual product/functional defect.",
    "Use INCONCLUSIVE when the spec did not execute, the functional assertion never ran, coverage is incomplete without a proven functional mismatch, required evidence is missing, or the required user interaction never happened.",
    "Do not copy Automation execution.status onto overallAssessment.",
    "Preserve requirementId and testCaseId traceability in the review output.",
    "Human QA feedback is an approval artifact. Do not treat Reviewer findings as approved exclusions.",
    "Do not set approvedByQA. Only a human QA can approve a scope change.",
    "Do not create a scope recommendation merely because a result is FAIL or INCONCLUSIVE.",
    "If an approved human QA decision already covers the same requirement, test case, and target, do not recommend another exclusion for that condition.",
  ]
    .filter((section) => section !== undefined)
    .join("\n");

  const raw = await llm.completeJson(
    `${instructions}\n${OUTPUT_CONTRACT}`,
    userPrompt
  );

  return validateQaReviewResult(parseJsonObject(raw), requirementId, {
    executionNeverRan: automationNeverExecuted(automationTc ?? automationUs),
    hasUserFacingEvidence: hasUserFacingExecutionEvidence(executionEvidence),
    currentPassedWithUserFacingEvidence:
      currentExecutionSupportsPass(executionEvidence),
    executionEvidence: executionEvidence?.value,
  });
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

function requirementContextFromAnalysis(
  analysisJson: string,
  requirementId: string
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(analysisJson) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const analysis = isRecord(parsed.analysis) ? parsed.analysis : parsed;
  const understanding =
    typeof analysis.requirementUnderstanding === "string"
      ? analysis.requirementUnderstanding.trim()
      : "";
  const explicitBehavior = Array.isArray(analysis.explicitBehavior)
    ? analysis.explicitBehavior.filter(
        (item): item is string =>
          typeof item === "string" && Boolean(item.trim())
      )
    : [];

  if (!understanding && explicitBehavior.length === 0) {
    return undefined;
  }

  return [
    `Requirement ${requirementId}`,
    "Source: QA Analyst artifact (local requirement markdown was not present).",
    understanding,
    explicitBehavior.length > 0
      ? `Explicit behavior:\n${explicitBehavior
          .map((item) => `- ${item}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function readText(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${label} at "${filePath}": ${reason}`);
  }
}

async function readOptionalJson(
  filePath: string,
  label: string
): Promise<{ path: string; value: unknown } | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      path: filePath,
      value: JSON.parse(raw) as unknown,
    };
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`[QA Reviewer] Optional artifact not used (${label}): ${reason}`);
    return undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function stringifyArtifact(
  artifact: { path: string; value: unknown } | unknown
): string {
  if (artifact === undefined) {
    return "(not provided)";
  }
  return JSON.stringify(artifact, null, 2);
}

function summarizeAutomationProcess(artifact: {
  path: string;
  value: unknown;
} | undefined): unknown {
  if (!artifact || !isRecord(artifact.value)) {
    return artifact ?? "(not provided)";
  }

  const value = artifact.value;
  const execution = isRecord(value.execution) ? value.execution : value;
  const stdout = optionalString(execution.stdout);
  const stderr = optionalString(execution.stderr);
  const log = `${stdout}\n${stderr}`;
  const processSignals = detectAutomationProcessSignals(log);
  const failures = Array.isArray(execution.failures)
    ? execution.failures.filter(isRecord)
    : [];

  return {
    path: artifact.path,
    executionStatus:
      typeof execution.status === "string" ? execution.status : undefined,
    evidencePath:
      typeof execution.evidencePath === "string"
        ? execution.evidencePath
        : undefined,
    failureClassifications: failures
      .map((item) => item.classification)
      .filter((item): item is string => typeof item === "string"),
    processSignals,
    note:
      "This summary describes whether Automation executed. It is not a product result. Automation FAILED does not imply Reviewer FAIL.",
  };
}

function detectAutomationProcessSignals(log: string): string[] {
  const signals: string[] = [];
  if (/SyntaxError/i.test(log)) {
    signals.push("generated spec SyntaxError");
  }
  if (/No tests found/i.test(log)) {
    signals.push("Playwright found no tests");
  }
  if (/missing semicolon/i.test(log)) {
    signals.push("generated spec parse error");
  }
  if (
    /locator\.(click|fill|type)|strict mode violation|locator resolved to/i.test(
      log
    ) &&
    /timeout/i.test(log)
  ) {
    signals.push(
      "locator or pointer timeout before required interaction completed"
    );
  }
  if (/Error: (browser|context|page)/i.test(log)) {
    signals.push("browser/environment error");
  }
  return signals;
}

function automationNeverExecuted(artifact: {
  path: string;
  value: unknown;
} | undefined): boolean {
  if (!artifact || !isRecord(artifact.value)) {
    return true;
  }

  const value = artifact.value;
  const execution = isRecord(value.execution) ? value.execution : value;
  const log = `${optionalString(execution.stdout)}\n${optionalString(execution.stderr)}`;
  const signals = detectAutomationProcessSignals(log);
  return signals.some((signal) =>
    [
      "generated spec SyntaxError",
      "Playwright found no tests",
      "generated spec parse error",
    ].includes(signal)
  );
}

function hasUserFacingExecutionEvidence(artifact: {
  path: string;
  value: unknown;
} | undefined): boolean {
  return collectUserFacingSignals(artifact?.value).length > 0;
}

function currentExecutionSupportsPass(artifact: {
  path: string;
  value: unknown;
} | undefined): boolean {
  if (!artifact || !isRecord(artifact.value)) {
    return false;
  }

  const value = artifact.value;
  if (value.status !== "PASSED") {
    return false;
  }
  if (value.coverageStatus === "PARTIAL") {
    return false;
  }

  const overlay = isRecord(value.overlay) ? value.overlay : undefined;
  if (
    overlay?.overlayDetected === true &&
    overlay.functionalTestContinued === false
  ) {
    return false;
  }

  const failures = Array.isArray(value.failures) ? value.failures : [];
  if (failures.length > 0) {
    return false;
  }

  return hasUserFacingExecutionEvidence(artifact);
}

function presentAuthoritativeExecutionEvidence(artifact: {
  path: string;
  value: unknown;
} | undefined): unknown {
  if (!artifact || !isRecord(artifact.value)) {
    return {
      role: "authoritative_current_per_execution_results",
      available: false,
      note: "The current per-execution results artifact was not provided. Aggregate Automation JSON is not a substitute for missing current results.",
    };
  }

  return {
    role: "authoritative_current_per_execution_results",
    available: true,
    path: path.relative(repoRoot, artifact.path),
    artifact: compactExecutionArtifact(artifact.value),
    userFacingSignals: collectUserFacingSignals(artifact.value),
    collectionSummary: summarizeCollectionIfPresent(artifact.value),
    reviewerGuidance: [
      "This file is the authoritative current per-execution evidence.",
      "Evaluate these fields against the Requirement/Test Case.",
      "Do not require linksDiscovered, linksChecked, browserNavigationSucceeded, or destinationLoadedCount unless this Test Case is a collection of destinations/links.",
      "Do not treat absent or zero unrelated generic fields as missing evidence.",
      "A PASSED result with complete coverage and sufficient user-facing observations can support Reviewer PASS.",
      "A proven functional expected-versus-observed mismatch is FAIL even when technical errors also occurred.",
      "Incomplete coverage or technical execution without a proven functional mismatch is INCONCLUSIVE.",
      "Aggregate or historical Automation JSON must not override this artifact when it is internally consistent.",
    ].join(" "),
  };
}

function compactExecutionArtifact(
  value: Record<string, unknown>
): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "perLinkResults" && Array.isArray(entry) && entry.length > 8) {
      compacted[key] = summarizeCollectionIfPresent(value);
      continue;
    }
    compacted[key] = compactForPrompt(entry);
  }
  return compacted;
}

function compactForPrompt(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 1500
      ? `${value.slice(0, 1500)}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    const mapped = value.slice(0, 24).map((item) => compactForPrompt(item));
    if (value.length > 24) {
      mapped.push({ _truncated: true, omitted: value.length - 24 });
    }
    return mapped;
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = compactForPrompt(entry);
    }
    return next;
  }
  return value;
}

function summarizeCollectionIfPresent(
  value: Record<string, unknown>
): unknown {
  if (!Array.isArray(value.perLinkResults)) {
    return undefined;
  }

  const perLinkResults = value.perLinkResults.filter(isRecord);
  if (perLinkResults.length === 0) {
    return undefined;
  }

  const passed = perLinkResults.filter((item) =>
    isOutcome(item, ["PASS", "PASSED"])
  );
  const failed = perLinkResults.filter((item) =>
    isOutcome(item, ["FAIL", "FAILED"])
  );
  const inconclusive = perLinkResults.filter((item) =>
    isOutcome(item, ["INCONCLUSIVE"])
  );
  const hasNavigationFlag = perLinkResults.some(
    (item) => typeof item.browserNavigationSucceeded === "boolean"
  );
  const hasDestinationFlag = perLinkResults.some(
    (item) => typeof item.destinationLoaded === "boolean"
  );

  return {
    itemCount: perLinkResults.length,
    passed: passed.length,
    failed: failed.length,
    inconclusive: inconclusive.length,
    ...(hasNavigationFlag
      ? {
          browserNavigationSucceeded: perLinkResults.filter(
            (item) => item.browserNavigationSucceeded === true
          ).length,
          browserNavigationFailed: perLinkResults.filter(
            (item) => item.browserNavigationSucceeded === false
          ).length,
        }
      : {}),
    ...(hasDestinationFlag
      ? {
          destinationLoadedCount: perLinkResults.filter(
            (item) => item.destinationLoaded === true
          ).length,
        }
      : {}),
    failedSamples: failed.slice(0, 8).map((item) => compactForPrompt(item)),
    inconclusiveSamples: inconclusive
      .slice(0, 8)
      .map((item) => compactForPrompt(item)),
    passedSamples: passed.slice(0, 3).map((item) => compactForPrompt(item)),
  };
}

function isOutcome(item: Record<string, unknown>, matches: string[]): boolean {
  const outcome =
    typeof item.outcome === "string"
      ? item.outcome
      : typeof item.result === "string"
        ? item.result
        : typeof item.status === "string"
          ? item.status
          : "";
  return matches.includes(outcome);
}

function collectUserFacingSignals(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const signals: string[] = [];
  const observations = isRecord(value.observations)
    ? value.observations
    : undefined;
  const inspection = isRecord(observations?.inspection)
    ? observations.inspection
    : undefined;
  const overlay = isRecord(value.overlay) ? value.overlay : undefined;

  const finalUrl = firstString(
    value.finalUrl,
    inspection?.finalUrl,
    observations?.finalUrl
  );
  if (finalUrl) {
    signals.push(`finalUrl=${finalUrl}`);
  }

  const httpStatus = firstNumber(
    value.httpStatus,
    observations?.httpStatus,
    inspection?.httpStatus
  );
  if (httpStatus !== undefined) {
    signals.push(`httpStatus=${httpStatus}`);
  }

  const screenshotPath = firstString(
    value.screenshotPath,
    observations?.screenshotPath,
    inspection?.screenshotPath
  );
  if (screenshotPath) {
    signals.push("screenshot captured");
  }

  const pageTitle = firstString(
    observations?.pageTitle,
    inspection?.title,
    value.pageTitle,
    value.title
  );
  if (pageTitle) {
    signals.push("page title present");
  }

  collectVisibilitySignals(inspection ?? observations ?? value, signals);

  if (inspection?.errorLike === false || observations?.errorLike === false) {
    signals.push("errorLike=false");
  }
  if (inspection?.signInGate === false || observations?.signInGate === false) {
    signals.push("signInGate=false");
  }

  const sample = isRecord(inspection?.sample) ? inspection.sample : undefined;
  if (
    typeof sample?.viewportTextSnippet === "string" &&
    sample.viewportTextSnippet.trim().length > 20
  ) {
    signals.push("viewport text sample present");
  }
  if (
    Array.isArray(sample?.contentCandidates) &&
    sample.contentCandidates.length > 0
  ) {
    signals.push(`contentCandidates=${sample.contentCandidates.length}`);
  }
  if (sample?.brandByTextDetected === true) {
    signals.push("brandByTextDetected=true");
  }

  if (overlay) {
    if (overlay.overlayDetected === false) {
      signals.push("overlayDetected=false");
    }
    if (overlay.functionalTestContinued === true) {
      signals.push("functionalTestContinued=true");
    }
    if (
      overlay.overlayDetected === true &&
      overlay.dismissalSucceeded === true
    ) {
      signals.push("blocking overlay dismissed");
    }
  }

  if (value.browserNavigationSucceeded === true) {
    signals.push("browserNavigationSucceeded=true");
  }
  if (value.destinationLoaded === true) {
    signals.push("destinationLoaded=true");
  }

  if (Array.isArray(value.perLinkResults)) {
    const items = value.perLinkResults.filter(isRecord);
    if (items.length > 0) {
      const passed = items.filter((item) =>
        isOutcome(item, ["PASS", "PASSED"])
      ).length;
      const failed = items.filter((item) =>
        isOutcome(item, ["FAIL", "FAILED"])
      ).length;
      const navigated = items.filter(
        (item) =>
          item.browserNavigationSucceeded === true ||
          item.destinationLoaded === true
      ).length;
      signals.push(
        `collectionItems=${items.length} passed=${passed} failed=${failed}`
      );
      if (navigated > 0) {
        signals.push(`collectionDestinationsObserved=${navigated}`);
      }
    }
  }

  return [...new Set(signals)];
}

function collectVisibilitySignals(
  source: Record<string, unknown>,
  signals: string[]
): void {
  for (const [key, entry] of Object.entries(source)) {
    if (entry === true && /(Visible|Detected)$/.test(key)) {
      signals.push(`${key}=true`);
    }
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export interface ReviewerDecisionEvidence {
  executionNeverRan: boolean;
  hasUserFacingEvidence: boolean;
  currentPassedWithUserFacingEvidence: boolean;
  executionEvidence?: unknown;
}

const EXPECTED_FIELD_KEYS = [
  "expected",
  "expectedTitle",
  "expectedValue",
  "expectedResult",
] as const;

const OBSERVED_VALUE_KEYS = [
  "observed",
  "observedTitle",
  "observedValue",
  "actual",
  "actualTitle",
] as const;

const UNABLE_TO_EVALUATE =
  /no visible deal card was found|could not (?:be )?(?:located|discovered|identified)|required control was not found|controlnotfounderror|page is already closed|target closed|syntaxerror|no tests (?:were )?found|execution stopped|could not complete the required|incomplete coverage|unable to verify/i;

const TECHNICAL_EXECUTION =
  /technical activation error|timeouterror|locator\.apply|page is already closed|target closed|browser\/context|syntaxerror|no tests (?:were )?found/i;

const FUNCTIONAL_DESTINATION_FAILURE =
  /unusable|error destination|broken or empty|did not match/i;

function nonEmptyEvidenceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") {
    return undefined;
  }
  return trimmed;
}

function evidenceRecordText(record: Record<string, unknown>): string {
  return [
    record.reason,
    record.notes,
    record.message,
    record.coverageNote,
  ]
    .filter((entry): entry is string => typeof entry === "string")
    .join("\n");
}

function isTechnicalEvidenceText(text: string): boolean {
  return TECHNICAL_EXECUTION.test(text);
}

function quotedExpectedObservedMismatch(text: string): boolean {
  const expectedThenObserved = text.match(
    /expected\s+['"`]([^'"`]+)['"`][\s\S]{0,200}?observed\s+['"`]([^'"`]+)['"`]/i
  );
  if (
    expectedThenObserved &&
    expectedThenObserved[1].trim() &&
    expectedThenObserved[2].trim() &&
    expectedThenObserved[1].trim() !== expectedThenObserved[2].trim()
  ) {
    return true;
  }

  const observedThenExpected = text.match(
    /observed\s+['"`]([^'"`]+)['"`][\s\S]{0,200}?expected\s+['"`]([^'"`]+)['"`]/i
  );
  if (
    observedThenExpected &&
    observedThenExpected[1].trim() &&
    observedThenExpected[2].trim() &&
    observedThenExpected[1].trim() !== observedThenExpected[2].trim()
  ) {
    return true;
  }

  return (
    /did not match/i.test(text) &&
    /expected/i.test(text) &&
    /observed/i.test(text)
  );
}

function hasObservedVsExpectedMismatch(
  record: Record<string, unknown>
): boolean {
  const expected = firstString(
    ...EXPECTED_FIELD_KEYS.map((key) => record[key])
  );
  const observed = firstString(
    ...OBSERVED_VALUE_KEYS.map((key) => record[key])
  );
  if (expected && observed && expected !== observed) {
    return true;
  }
  return quotedExpectedObservedMismatch(evidenceRecordText(record));
}

function hasConcreteFunctionalObservation(
  record: Record<string, unknown>
): boolean {
  if (hasObservedVsExpectedMismatch(record)) {
    return true;
  }

  const text = evidenceRecordText(record);
  if (isTechnicalEvidenceText(text)) {
    return false;
  }

  const destination =
    nonEmptyEvidenceString(record.finalUrl) ??
    nonEmptyEvidenceString(record.destination);
  if (!destination) {
    return false;
  }

  const outcome = nonEmptyEvidenceString(record.observedOutcome);
  return (
    FUNCTIONAL_DESTINATION_FAILURE.test(text) ||
    (outcome !== undefined &&
      outcome.toLowerCase() !== "success" &&
      outcome.toLowerCase() !== "passed")
  );
}

function itemHasProvenFunctionalMismatch(
  record: Record<string, unknown>
): boolean {
  if (record.passed === true) {
    return false;
  }
  if (hasObservedVsExpectedMismatch(record)) {
    return true;
  }
  if (record.kind === "TECHNICAL") {
    return false;
  }
  if (isTechnicalEvidenceText(evidenceRecordText(record))) {
    return false;
  }
  return hasConcreteFunctionalObservation(record);
}

function collectEvidenceRecords(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }

  const failures = Array.isArray(value.failures)
    ? value.failures.filter(isRecord)
    : [];
  const items = Array.isArray(value.perLinkResults)
    ? value.perLinkResults.filter(isRecord)
    : Array.isArray(value.perItemResults)
      ? value.perItemResults.filter(isRecord)
      : [];
  return [value, ...failures, ...items];
}

export function hasProvenFunctionalMismatch(value: unknown): boolean {
  return collectEvidenceRecords(value).some(itemHasProvenFunctionalMismatch);
}

function isUnableToEvaluateRecord(record: Record<string, unknown>): boolean {
  if (
    hasObservedVsExpectedMismatch(record) ||
    itemHasProvenFunctionalMismatch(record)
  ) {
    return false;
  }
  const text = evidenceRecordText(record);
  return UNABLE_TO_EVALUATE.test(text) || isTechnicalEvidenceText(text);
}

export function isInsufficientFunctionalEvidence(value: unknown): boolean {
  if (hasProvenFunctionalMismatch(value)) {
    return false;
  }
  if (!isRecord(value)) {
    return true;
  }
  if (value.status === "PASSED") {
    return false;
  }

  const records = collectEvidenceRecords(value);
  const failures = Array.isArray(value.failures)
    ? value.failures.filter(isRecord)
    : [];
  const technicalOnlyFailures =
    failures.length > 0 &&
    failures.every(
      (failure) =>
        failure.kind === "TECHNICAL" ||
        isTechnicalEvidenceText(evidenceRecordText(failure))
    );

  if (technicalOnlyFailures) {
    return true;
  }
  if (value.coverageStatus === "PARTIAL") {
    return true;
  }

  const discovered =
    typeof value.linksDiscovered === "number"
      ? value.linksDiscovered
      : undefined;
  const checked =
    typeof value.linksChecked === "number" ? value.linksChecked : undefined;
  if (
    discovered !== undefined &&
    checked !== undefined &&
    discovered > 0 &&
    checked < discovered
  ) {
    return true;
  }

  const hasEvaluatedFunctionalFailure = failures.some(
    (failure) =>
      failure.kind !== "TECHNICAL" &&
      !isTechnicalEvidenceText(evidenceRecordText(failure)) &&
      !isUnableToEvaluateRecord(failure)
  );
  if (hasEvaluatedFunctionalFailure) {
    return false;
  }

  if (records.some(isUnableToEvaluateRecord)) {
    return true;
  }

  return (
    value.status === "FAILED" &&
    failures.length === 0 &&
    !Array.isArray(value.perLinkResults) &&
    !Array.isArray(value.perItemResults)
  );
}

function validateQaReviewResult(
  value: unknown,
  fallbackRequirementId: string,
  evidence: ReviewerDecisionEvidence
): QaReviewResult {
  if (!isRecord(value)) {
    throw new Error("QA Reviewer output must be a JSON object");
  }

  const overallAssessment = asOverallAssessment(value.overallAssessment);
  const functionalTestCases = asArray(value.functionalTestCases).map(
    (item, index) => asFunctionalTestCase(item, index)
  );

  if (functionalTestCases.length === 0) {
    throw new Error("QA Reviewer output must include functionalTestCases");
  }

  const findings = asArray(value.findings).map((item, index) =>
    asFinding(item, `findings[${index}]`)
  );
  const productIssues = asArray(value.productIssues).map((item, index) =>
    asFinding(item, `productIssues[${index}]`)
  );

  return applyReviewerDecisionGuard(
    {
      requirementId:
        optionalString(value.requirementId) || fallbackRequirementId,
      overallAssessment,
      functionalTestCases,
      findings,
      productIssues,
      coverageGaps: asArray(value.coverageGaps).map((item, index) =>
        asCoverageGap(item, index)
      ),
      artifactInconsistencies: asArray(value.artifactInconsistencies).map(
        (item, index) => asArtifactInconsistency(item, index)
      ),
      recommendations: asStringArray(value.recommendations),
      scopeRecommendations: asScopeRecommendations(
        value.scopeRecommendations,
        functionalTestCases[0]?.id ?? "TC-001"
      ),
      qaAssessment: asString(value.qaAssessment, "qaAssessment"),
    },
    evidence
  );
}

export function applyReviewerDecisionGuard(
  result: QaReviewResult,
  evidence: ReviewerDecisionEvidence
): QaReviewResult {
  if (
    result.overallAssessment === "INCONCLUSIVE" &&
    evidence.currentPassedWithUserFacingEvidence &&
    citesMissingGenericCollectionFields(result) &&
    result.productIssues.length === 0 &&
    !result.findings.some(
      (finding) => finding.classification === "PRODUCT_ISSUE"
    )
  ) {
    return toPassFromGenericFieldMisread(result);
  }

  const provenMismatch = hasProvenFunctionalMismatch(evidence.executionEvidence);
  const insufficient = isInsufficientFunctionalEvidence(
    evidence.executionEvidence
  );

  if (provenMismatch && result.overallAssessment !== "PASS") {
    return result.overallAssessment === "FAIL"
      ? result
      : toFailFromProvenMismatch(result);
  }

  if (result.overallAssessment === "PASS") {
    return result;
  }

  if (result.overallAssessment !== "FAIL") {
    return result;
  }

  if (evidence.executionNeverRan && !evidence.hasUserFacingEvidence) {
    return toInconclusive(result);
  }

  if (insufficient) {
    return toInconclusive(result);
  }

  const hasProductEvidence =
    result.productIssues.length > 0 ||
    result.findings.some(
      (finding) => finding.classification === "PRODUCT_ISSUE"
    );

  if (hasProductEvidence) {
    return result;
  }

  return toInconclusive(result);
}

const GENERIC_COLLECTION_FIELD =
  /\b(browserNavigationSucceeded|destinationLoadedCount|linksDiscovered|linksChecked|per-destination|per-link)\b/i;

function citesMissingGenericCollectionFields(result: QaReviewResult): boolean {
  const text = [
    result.qaAssessment,
    ...result.findings.map((item) => `${item.summary} ${item.rationale}`),
    ...result.coverageGaps.map((item) => `${item.summary} ${item.rationale}`),
  ].join("\n");
  return GENERIC_COLLECTION_FIELD.test(text);
}

function toPassFromGenericFieldMisread(result: QaReviewResult): QaReviewResult {
  const genericGap = (text: string): boolean =>
    GENERIC_COLLECTION_FIELD.test(text);

  return {
    ...result,
    overallAssessment: "PASS",
    functionalTestCases: result.functionalTestCases.map((testCase) =>
      testCase.status === "INCONCLUSIVE"
        ? { ...testCase, status: "PASSED" }
        : testCase
    ),
    findings: result.findings.filter(
      (finding) => !genericGap(`${finding.summary} ${finding.rationale}`)
    ),
    coverageGaps: result.coverageGaps.filter(
      (gap) => !genericGap(`${gap.summary} ${gap.rationale}`)
    ),
    recommendations: result.recommendations.filter(
      (item) => !genericGap(item)
    ),
    qaAssessment:
      "The current per-execution results artifact is internally consistent and contains sufficient user-facing evidence for this Test Case. Unrelated generic collection fields were not treated as missing evidence.",
  };
}

function toFailFromProvenMismatch(result: QaReviewResult): QaReviewResult {
  return {
    ...result,
    overallAssessment: "FAIL",
    functionalTestCases: result.functionalTestCases.map((testCase) =>
      testCase.status === "INCONCLUSIVE"
        ? { ...testCase, status: "FAILED" }
        : testCase
    ),
  };
}

function toInconclusive(result: QaReviewResult): QaReviewResult {
  return {
    ...result,
    overallAssessment: "INCONCLUSIVE",
    functionalTestCases: result.functionalTestCases.map((testCase) =>
      testCase.status === "FAILED"
        ? { ...testCase, status: "INCONCLUSIVE" }
        : testCase
    ),
  };
}

function asFunctionalTestCase(
  value: unknown,
  index: number
): FunctionalTestCaseReview {
  if (!isRecord(value)) {
    throw new Error(`functionalTestCases[${index}] must be an object`);
  }

  const status = value.status;
  if (status !== "PASSED" && status !== "FAILED" && status !== "INCONCLUSIVE") {
    throw new Error(
      `functionalTestCases[${index}].status must be PASSED, FAILED, or INCONCLUSIVE`
    );
  }

  const coverageStatus = value.coverageStatus;
  if (
    coverageStatus !== "COMPLETE" &&
    coverageStatus !== "PARTIAL" &&
    coverageStatus !== "UNKNOWN"
  ) {
    throw new Error(
      `functionalTestCases[${index}].coverageStatus must be COMPLETE, PARTIAL, or UNKNOWN`
    );
  }

  return {
    id: asString(value.id, `functionalTestCases[${index}].id`),
    status,
    coverageStatus,
    linksDiscovered:
      typeof value.linksDiscovered === "number"
        ? value.linksDiscovered
        : undefined,
    linksChecked:
      typeof value.linksChecked === "number" ? value.linksChecked : undefined,
  };
}

function asFinding(value: unknown, pathLabel: string): ReviewFinding {
  if (typeof value === "string") {
    return { summary: value, rationale: value };
  }

  if (!isRecord(value)) {
    throw new Error(`${pathLabel} must be an object`);
  }

  const classification = value.classification;
  if (
    classification !== undefined &&
    classification !== "PRODUCT_ISSUE" &&
    classification !== "TEST_ISSUE" &&
    classification !== "ENVIRONMENT_ISSUE" &&
    classification !== "EXTERNAL_DEPENDENCY" &&
    classification !== "INCONCLUSIVE"
  ) {
    throw new Error(`${pathLabel}.classification is not a valid classification`);
  }

  return {
    summary: asString(value.summary, `${pathLabel}.summary`),
    classification,
    originalUrl: optionalString(value.originalUrl) || undefined,
    httpStatus:
      typeof value.httpStatus === "number" ? value.httpStatus : undefined,
    rationale: asString(value.rationale, `${pathLabel}.rationale`),
  };
}

function asCoverageGap(value: unknown, index: number): CoverageGap {
  if (typeof value === "string") {
    return { summary: value, rationale: value };
  }

  if (!isRecord(value)) {
    throw new Error(`coverageGaps[${index}] must be an object`);
  }

  return {
    summary: asString(value.summary, `coverageGaps[${index}].summary`),
    rationale: asString(value.rationale, `coverageGaps[${index}].rationale`),
  };
}

function asArtifactInconsistency(
  value: unknown,
  index: number
): ArtifactInconsistency {
  if (!isRecord(value)) {
    throw new Error(`artifactInconsistencies[${index}] must be an object`);
  }

  return {
    summary: asString(
      value.summary,
      `artifactInconsistencies[${index}].summary`
    ),
    artifacts: asStringArray(value.artifacts),
    strongerEvidence: asString(
      value.strongerEvidence,
      `artifactInconsistencies[${index}].strongerEvidence`
    ),
    rationale: asString(
      value.rationale,
      `artifactInconsistencies[${index}].rationale`
    ),
  };
}

function asScopeRecommendations(
  value: unknown,
  fallbackTestCaseId: string
): ScopeRecommendation[] {
  if (value === undefined) {
    return [];
  }

  return asArray(value).flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const target = optionalString(item.target).trim();
    const rationale =
      optionalString(item.rationale).trim() ||
      optionalString(item.reason).trim();
    const testCaseId =
      optionalString(item.testCaseId).trim() || fallbackTestCaseId;
    const proposedAction = item.proposedAction ?? item.action;

    if (!target || !rationale || proposedAction !== "EXCLUDE") {
      return [];
    }

    return [
      {
        testCaseId,
        target,
        proposedAction: "EXCLUDE",
        rationale,
      },
    ];
  });
}

function asOverallAssessment(value: unknown): OverallAssessment {
  if (value === "PASS" || value === "FAIL" || value === "INCONCLUSIVE") {
    return value;
  }
  throw new Error("overallAssessment must be PASS, FAIL, or INCONCLUSIVE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Expected an array");
  }
  return value;
}

function asString(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${pathLabel} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Expected a string array");
  }
  return value.filter((item): item is string => typeof item === "string");
}

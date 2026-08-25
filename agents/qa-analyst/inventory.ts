/**
 * Deterministic inventory of Analyst-generated functional test cases.
 *
 * Canonical source: test-cases/{requirementId}/{testCaseId}.json
 * Lookup is by requirementId + testCaseId. The LLM does not decide
 * whether a test case already exists.
 *
 * artifacts/qa-analyst/{requirementId}.json remains an audit artifact only.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QaAnalysisResult, TestCase } from "./index.js";
import { analystDir } from "../artifact-paths.js";

const LEGACY_ANALYSIS_FILE_PATTERN = /^qa-analysis-(.+)\.json$/;
const ANALYSIS_FILE_PATTERN = /^(.+)\.json$/;
const TEST_CASE_FILE_PATTERN = /^(TC-\d+)\.json$/i;

/** Test Case IDs are scoped to a requirement. Each User Story uses TC-001. */
export const CANONICAL_TEST_CASE_ID = "TC-001";

export interface StoredAnalysis {
  requirementId: string;
  sourcePath: string;
  analysis: QaAnalysisResult["analysis"];
  strategy: QaAnalysisResult["strategy"];
  testCases: TestCase[];
  requirementFingerprint?: string;
}

export interface TestCaseInventory {
  analyses: StoredAnalysis[];
  testCases: TestCase[];
}

export async function loadTestCaseInventory(options: {
  artifactsDir: string;
  testCasesDir: string;
}): Promise<TestCaseInventory> {
  const analyses = await loadStoredAnalyses(options.artifactsDir);
  const testCases = await loadAllTestCases(options.testCasesDir);
  return { analyses, testCases };
}

export function existingTestCasesFor(
  inventory: TestCaseInventory,
  requirementId: string
): TestCase[] {
  return inventory.testCases.filter(
    (testCase) => testCase.requirementId === requirementId
  );
}

export function existingAnalysisFor(
  inventory: TestCaseInventory,
  requirementId: string
): StoredAnalysis | undefined {
  return inventory.analyses.find(
    (analysis) => analysis.requirementId === requirementId
  );
}

export function canonicalTestCaseId(): string {
  return CANONICAL_TEST_CASE_ID;
}

export function selectReusableTestCase(testCases: TestCase[]): TestCase | undefined {
  if (testCases.length === 0) {
    return undefined;
  }

  const canonical = testCases.find(
    (testCase) => testCase.id.trim().toUpperCase() === CANONICAL_TEST_CASE_ID
  );
  if (canonical) {
    return canonical;
  }

  return [...testCases].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true })
  )[0];
}

export function formatTestCaseId(number: number): string {
  return `TC-${String(number).padStart(3, "0")}`;
}

export function testCaseFilePath(
  testCasesDir: string,
  requirementId: string,
  testCaseId: string
): string {
  return path.join(testCasesDir, requirementId, `${testCaseId}.json`);
}

export async function loadAllTestCases(testCasesDir: string): Promise<TestCase[]> {
  const testCases: TestCase[] = [];
  let requirementDirs: string[] = [];

  try {
    requirementDirs = await readdir(testCasesDir);
  } catch {
    return testCases;
  }

  for (const requirementId of requirementDirs.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true })
  )) {
    testCases.push(
      ...(await loadTestCasesForRequirement(testCasesDir, requirementId))
    );
  }

  return testCases;
}

export async function loadTestCasesForRequirement(
  testCasesDir: string,
  requirementId: string
): Promise<TestCase[]> {
  const directory = path.join(testCasesDir, requirementId);
  let files: string[] = [];

  try {
    files = await readdir(directory);
  } catch {
    return [];
  }

  const testCases: TestCase[] = [];

  for (const name of files) {
    const match = TEST_CASE_FILE_PATTERN.exec(name);
    if (!match) {
      continue;
    }

    const testCase = await readStoredTestCase(
      path.join(directory, name),
      requirementId,
      match[1] ?? ""
    );
    if (testCase) {
      testCases.push(testCase);
    }
  }

  return testCases.sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true })
  );
}

export async function loadStoredTestCase(
  testCasesDir: string,
  requirementId: string,
  testCaseId: string
): Promise<TestCase> {
  const sourcePath = testCaseFilePath(testCasesDir, requirementId, testCaseId);
  const testCase = await readStoredTestCase(
    sourcePath,
    requirementId,
    testCaseId
  );

  if (!testCase) {
    throw new Error(
      `No test case ${testCaseId} found for ${requirementId} at ${sourcePath}`
    );
  }

  return testCase;
}

export async function persistTestCases(
  testCasesDir: string,
  testCases: TestCase[]
): Promise<void> {
  const persistedByRequirement = new Map<string, Set<string>>();

  for (const testCase of testCases) {
    const filePath = testCaseFilePath(
      testCasesDir,
      testCase.requirementId,
      testCase.id
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(toPersistedTestCase(testCase), null, 2)}\n`,
      "utf8"
    );

    const kept = persistedByRequirement.get(testCase.requirementId) ?? new Set();
    kept.add(testCase.id);
    persistedByRequirement.set(testCase.requirementId, kept);
  }

  for (const [requirementId, keep] of persistedByRequirement) {
    await removeUnlistedTestCases(testCasesDir, requirementId, keep);
  }
}

async function removeUnlistedTestCases(
  testCasesDir: string,
  requirementId: string,
  keep: Set<string>
): Promise<void> {
  const directory = path.join(testCasesDir, requirementId);
  let files: string[] = [];
  try {
    files = await readdir(directory);
  } catch {
    return;
  }

  for (const name of files) {
    const match = TEST_CASE_FILE_PATTERN.exec(name);
    const testCaseId = match?.[1];
    if (!testCaseId || keep.has(testCaseId)) {
      continue;
    }
    await rm(path.join(directory, name), { force: true });
  }
}

async function loadStoredAnalyses(artifactsDir: string): Promise<StoredAnalysis[]> {
  const fromOwned = await loadAnalysesFromDirectory(
    analystDir(artifactsDir),
    ANALYSIS_FILE_PATTERN
  );
  const fromLegacy = await loadAnalysesFromDirectory(
    artifactsDir,
    LEGACY_ANALYSIS_FILE_PATTERN
  );

  const byRequirement = new Map<string, StoredAnalysis>();
  for (const stored of [...fromLegacy, ...fromOwned]) {
    byRequirement.set(stored.requirementId, stored);
  }
  return [...byRequirement.values()];
}

async function loadAnalysesFromDirectory(
  directory: string,
  filenamePattern: RegExp
): Promise<StoredAnalysis[]> {
  const analyses: StoredAnalysis[] = [];
  let entries: string[] = [];

  try {
    entries = await readdir(directory);
  } catch {
    return analyses;
  }

  for (const name of entries) {
    const match = filenamePattern.exec(name);
    if (!match) {
      continue;
    }

    const stored = await readStoredAnalysis(
      path.join(directory, name),
      match[1] ?? ""
    );
    if (stored) {
      analyses.push(stored);
    }
  }

  return analyses;
}

async function readStoredAnalysis(
  sourcePath: string,
  filenameRequirementId: string
): Promise<StoredAnalysis | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sourcePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const analysisRequirementId =
      typeof record.requirementId === "string" && record.requirementId.trim()
        ? record.requirementId.trim()
        : filenameRequirementId.trim();

    if (
      !analysisRequirementId ||
      !record.analysis ||
      typeof record.analysis !== "object" ||
      !record.strategy ||
      typeof record.strategy !== "object"
    ) {
      return undefined;
    }

    return {
      requirementId: analysisRequirementId,
      sourcePath,
      analysis: record.analysis as QaAnalysisResult["analysis"],
      strategy: record.strategy as QaAnalysisResult["strategy"],
      testCases: Array.isArray(record.testCases)
        ? record.testCases.flatMap((item) => {
            const testCase = readTestCase(item, analysisRequirementId);
            return testCase ? [testCase] : [];
          })
        : [],
      requirementFingerprint:
        typeof record.requirementFingerprint === "string" &&
        record.requirementFingerprint.trim()
          ? record.requirementFingerprint.trim()
          : undefined,
    };
  } catch {
    return undefined;
  }
}

async function readStoredTestCase(
  sourcePath: string,
  directoryRequirementId: string,
  filenameTestCaseId: string
): Promise<TestCase | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sourcePath, "utf8"));
    return readTestCase(parsed, directoryRequirementId, filenameTestCaseId);
  } catch {
    return undefined;
  }
}

function toPersistedTestCase(testCase: TestCase): Record<string, unknown> {
  return {
    requirementId: testCase.requirementId,
    testCaseId: testCase.id,
    id: testCase.id,
    title: testCase.title,
    objective: testCase.objective,
    preconditions: testCase.preconditions,
    steps: testCase.steps,
    expectedResult: testCase.expectedResult,
    source: testCase.source,
    priority: testCase.priority,
    riskCovered: testCase.riskCovered,
  };
}

function readTestCase(
  value: unknown,
  fallbackRequirementId: string,
  fallbackTestCaseId?: string
): TestCase | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const testCase = value as Record<string, unknown>;
  const id =
    typeof testCase.testCaseId === "string" && testCase.testCaseId.trim()
      ? testCase.testCaseId.trim()
      : typeof testCase.id === "string" && testCase.id.trim()
        ? testCase.id.trim()
        : fallbackTestCaseId?.trim() ?? "";

  if (
    !id ||
    typeof testCase.title !== "string" ||
    typeof testCase.objective !== "string" ||
    typeof testCase.expectedResult !== "string" ||
    Array.isArray(testCase.preconditions) === false ||
    Array.isArray(testCase.steps) === false
  ) {
    return undefined;
  }

  const explicitRequirementId =
    typeof testCase.requirementId === "string"
      ? testCase.requirementId.trim()
      : "";

  if (explicitRequirementId && explicitRequirementId !== fallbackRequirementId) {
    return undefined;
  }

  const source =
    testCase.source === "GENERATED" || testCase.source === "REUSED_EXISTING"
      ? testCase.source
      : "REUSED_EXISTING";

  return {
    id,
    requirementId: explicitRequirementId || fallbackRequirementId,
    source,
    title: testCase.title,
    objective: testCase.objective,
    priority: testCase.priority as TestCase["priority"],
    preconditions: testCase.preconditions as string[],
    steps: testCase.steps as string[],
    expectedResult: testCase.expectedResult,
    riskCovered: Array.isArray(testCase.riskCovered)
      ? (testCase.riskCovered as unknown[]).filter(
          (item): item is string => typeof item === "string"
        )
      : [],
  };
}

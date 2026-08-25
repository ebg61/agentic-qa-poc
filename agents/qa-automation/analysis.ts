/**
 * Load functional test cases from the Analyst test-case store.
 *
 * Canonical source: test-cases/{requirementId}/{testCaseId}.json
 * Analyst artifacts are not required to discover test cases.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TestCase } from "../qa-analyst/index.js";
import {
  loadAllTestCases,
  loadStoredTestCase,
  loadTestCasesForRequirement,
} from "../qa-analyst/inventory.js";
import {
  analystArtifactPath,
  firstExistingPath,
  legacyAnalystArtifactPath,
} from "../artifact-paths.js";

export interface AnalystTestCase {
  id: string;
  requirementId: string;
  title: string;
  objective: string;
  priority: string;
  preconditions: string[];
  steps: string[];
  expectedResult: string;
  riskCovered: string[];
}

const DEFAULT_TEST_CASES_DIR = path.resolve("test-cases");

export async function discoverAnalystRequirementIds(
  testCasesDir: string = DEFAULT_TEST_CASES_DIR
): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(testCasesDir);
  } catch {
    return [];
  }

  const requirementIds: string[] = [];

  for (const name of entries) {
    const testCases = await loadTestCasesForRequirement(testCasesDir, name);
    if (testCases.length > 0) {
      requirementIds.push(name);
    }
  }

  return requirementIds.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true })
  );
}

export async function loadTestCases(
  requirementId: string,
  testCasesDir: string = DEFAULT_TEST_CASES_DIR
): Promise<AnalystTestCase[]> {
  const testCases = await loadTestCasesForRequirement(
    testCasesDir,
    requirementId
  );
  return testCases.map(toAnalystTestCase);
}

export async function loadTestCase(
  requirementId: string,
  testCaseId: string,
  testCasesDir: string = DEFAULT_TEST_CASES_DIR
): Promise<AnalystTestCase> {
  return toAnalystTestCase(
    await loadStoredTestCase(testCasesDir, requirementId, testCaseId)
  );
}

export async function loadAllAnalystTestCases(
  testCasesDir: string = DEFAULT_TEST_CASES_DIR
): Promise<AnalystTestCase[]> {
  return (await loadAllTestCases(testCasesDir)).map(toAnalystTestCase);
}

export async function loadOptionalAnalysis(
  artifactsDir: string,
  requirementId: string
): Promise<{ analysis?: unknown; strategy?: unknown } | undefined> {
  const sourcePath =
    (await firstExistingPath(
      analystArtifactPath(requirementId, artifactsDir),
      legacyAnalystArtifactPath(requirementId, artifactsDir)
    )) ?? analystArtifactPath(requirementId, artifactsDir);

  try {
    const parsed: unknown = JSON.parse(await readFile(sourcePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    return {
      analysis: record.analysis,
      strategy: record.strategy,
    };
  } catch {
    return undefined;
  }
}

function toAnalystTestCase(testCase: TestCase): AnalystTestCase {
  return {
    id: testCase.id,
    requirementId: testCase.requirementId,
    title: testCase.title,
    objective: testCase.objective,
    priority: testCase.priority,
    preconditions: testCase.preconditions,
    steps: testCase.steps,
    expectedResult: testCase.expectedResult,
    riskCovered: testCase.riskCovered,
  };
}

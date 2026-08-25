import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runQaAnalysis, type QaAnalysisResult } from "./index.js";
import {
  existingAnalysisFor,
  existingTestCasesFor,
  loadTestCaseInventory,
  persistTestCases,
} from "./inventory.js";
import {
  discoverLocalRequirementIds,
  loadLocalRequirement,
} from "./requirement.js";
import { analystArtifactPath } from "../artifact-paths.js";

const REQUIREMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function main(): Promise<void> {
  const artifactsDir = path.resolve("artifacts");
  const testCasesDir = path.resolve("test-cases");
  const requirementsDir = path.resolve("requirements");
  const requestedId = process.argv[2]?.trim();
  const requirementIds = requestedId
    ? [parseRequirementId(requestedId)]
    : await discoverLocalRequirementIds(requirementsDir);

  if (requirementIds.length === 0) {
    throw new Error(`No requirements found in ${requirementsDir}`);
  }

  console.log(
    `QA Analyst requirements: ${requirementIds.join(", ")}`
  );

  for (const requirementId of requirementIds) {
    await analyzeRequirement(
      requirementId,
      artifactsDir,
      testCasesDir,
      requirementsDir
    );
  }
}

async function analyzeRequirement(
  requirementId: string,
  artifactsDir: string,
  testCasesDir: string,
  requirementsDir: string
): Promise<void> {
  const outputPath = analystArtifactPath(requirementId, artifactsDir);

  console.log(`\nRunning QA Analyst for ${requirementId}...`);

  const inventory = await loadTestCaseInventory({
    artifactsDir,
    testCasesDir,
  });
  const existingTestCases = existingTestCasesFor(inventory, requirementId);
  const existingAnalysis = existingAnalysisFor(inventory, requirementId);
  const requirement = await loadLocalRequirement(
    requirementId,
    requirementsDir
  );

  if (existingTestCases.length > 0) {
    console.log(
      `Existing test cases for ${requirementId}: ${existingTestCases
        .map((testCase) => testCase.id)
        .join(", ")}`
    );
  } else {
    console.log(`No existing test cases found for ${requirementId}.`);
  }

  const result = await runQaAnalysis(requirement, {
    requirementId,
    existingTestCases,
    existingAnalysis,
  });

  await persistTestCases(testCasesDir, result.testCases);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");

  logResult(result, outputPath);
}

function logResult(result: QaAnalysisResult, outputPath: string): void {
  console.log(`QA analysis written to: ${outputPath}`);
  console.log(`requirementId: ${result.requirementId}`);
  console.log(`testCaseSource: ${result.testCaseSource}`);

  for (const testCase of result.testCases) {
    console.log(
      `- ${testCase.id} requirementId=${testCase.requirementId} source=${testCase.source}`
    );
  }
}

function parseRequirementId(value: string): string {
  if (!REQUIREMENT_ID_PATTERN.test(value)) {
    throw new Error(`Invalid requirement ID: ${value}`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

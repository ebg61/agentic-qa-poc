import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  listAutomationTargets,
  runQaAutomation,
  type QaAutomationResult,
} from "./index.js";
import {
  automationRequirementPath,
  automationTestCasePath,
} from "../artifact-paths.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function main(): Promise<void> {
  const artifactsDir = path.resolve("artifacts");
  const requestedRequirementId = process.argv[2]?.trim();
  const requestedTestCaseId = process.argv[3]?.trim();

  const targets = await resolveTargets(
    requestedRequirementId,
    requestedTestCaseId
  );

  if (targets.length === 0) {
    throw new Error("No Analyst test cases found to automate");
  }

  console.log(
    `QA Automation targets: ${targets
      .map((target) => `${target.requirementId}/${target.testCaseId}`)
      .join(", ")}`
  );

  const results: QaAutomationResult[] = [];

  for (const target of targets) {
    console.log(
      `\nRunning QA Automation for ${target.requirementId} / ${target.testCaseId}...`
    );
    results.push(
      await runQaAutomation({
        requirementId: target.requirementId,
        testCaseId: target.testCaseId,
      })
    );
  }

  await mkdir(artifactsDir, { recursive: true });
  await writeAutomationArtifacts(artifactsDir, results);
}

async function resolveTargets(
  requirementId: string | undefined,
  testCaseId: string | undefined
) {
  if (requirementId) {
    const parsedRequirementId = parseId(requirementId, "requirement ID");

    if (testCaseId) {
      return [
        {
          requirementId: parsedRequirementId,
          testCaseId: parseId(testCaseId, "test case ID"),
        },
      ];
    }

    return listAutomationTargets(parsedRequirementId);
  }

  if (testCaseId) {
    throw new Error(
      "testCaseId requires a requirementId. Example: npx tsx agents/qa-automation/run.ts US-002 TC-001"
    );
  }

  return listAutomationTargets();
}

async function writeAutomationArtifacts(
  artifactsDir: string,
  results: QaAutomationResult[]
): Promise<void> {
  for (const result of results) {
    logResult(result);

    const perTestCasePath = automationTestCasePath(
      result.requirementId,
      result.testCaseId,
      artifactsDir
    );
    await mkdir(path.dirname(perTestCasePath), { recursive: true });
    await writeFile(perTestCasePath, JSON.stringify(result, null, 2), "utf8");
    console.log(`QA Automation result written to: ${perTestCasePath}`);
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
    console.log(`QA Automation result written to: ${requirementPath}`);
  }
}

function logResult(result: QaAutomationResult): void {
  const { execution } = result;

  console.log(`requirementId: ${result.requirementId}`);
  console.log(`testCaseId: ${result.testCaseId}`);
  console.log(`Automation action: ${result.action}`);
  console.log(`Automation spec: ${result.generatedPlaywrightTest.sourcePath}`);
  console.log(`Execution status: ${execution.status}`);

  if (execution.evidencePath) {
    console.log(`Evidence: ${execution.evidencePath}`);
  }

  console.log(
    `Approved QA scope used: ${execution.approvedScopeUsed ? "yes" : "no"}`
  );

  if (execution.scope) {
    console.log(
      `Scope: discovered=${execution.scope.discovered} excluded=${execution.scope.excluded} applicable=${execution.scope.applicable} checked=${execution.linksChecked ?? "?"}`
    );
  }

  if (execution.discovery) {
    console.log("[QA Automation] Discovery evidence:");
    console.log(`- Initial: ${execution.discovery.initialCount}`);
    console.log(
      `- After stabilization: ${execution.discovery.afterStabilizationCount}`
    );
    console.log(
      `- Final deduplicated: ${execution.discovery.finalDeduplicatedCount}`
    );
    console.log(`- Applicable: ${execution.discovery.applicableCount}`);
    console.log(`- Checked: ${execution.discovery.checkedCount}`);
  } else if (
    execution.coverageStatus !== undefined &&
    execution.linksChecked !== undefined &&
    execution.linksDiscovered !== undefined
  ) {
    console.log(
      `Coverage: ${execution.coverageStatus} (${execution.linksChecked}/${execution.linksDiscovered} links checked)`
    );
  }

  if (execution.coverageNote) {
    console.log(execution.coverageNote);
  }

  if (execution.overlay) {
    console.log("[QA Automation] Overlay handling:");
    console.log(`- detected: ${execution.overlay.overlayDetected}`);
    console.log(
      `- dismissal attempted: ${execution.overlay.dismissalAttempted}`
    );
    console.log(`- dismissal method: ${execution.overlay.dismissalMethod}`);
    console.log(
      `- dismissal succeeded: ${execution.overlay.dismissalSucceeded}`
    );
    console.log(
      `- functional test continued: ${execution.overlay.functionalTestContinued}`
    );
    if (execution.overlay.reason) {
      console.log(`- reason: ${execution.overlay.reason}`);
    }
  }

  if (execution.failures.length > 0) {
    console.log("Failures:");

    for (const failure of execution.failures) {
      console.log(
        `- ${failure.originalUrl ?? ""} -> ${
          failure.finalUrl ?? ""
        } [${failure.httpStatus ?? "no status"}] ${
          failure.classification ?? ""
        } ${failure.reason ?? ""}`
      );
    }
  }
}

function parseId(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * Orchestrator → QA Analyst invocation.
 *
 * Builds a source-agnostic Requirement from board discovery and invokes
 * the existing QA Analyst. Does not import Taiga API types.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runQaAnalysis,
  type QaAnalysisResult,
} from "../qa-analyst/index.js";
import {
  existingAnalysisFor,
  existingTestCasesFor,
  loadTestCaseInventory,
  persistTestCases,
} from "../qa-analyst/inventory.js";
import type { Requirement } from "../qa-analyst/requirement.js";
import type { BoardRequirement } from "../../integrations/board.js";
import {
  findProcessedItem,
  loadProcessedItems,
  recordProcessedItem,
  type ProcessedWorkflowItem,
} from "./processed.js";
import {
  analystArtifactPath,
  firstExistingPath,
  orchestratorDir,
} from "../artifact-paths.js";

export interface AnalystInvocationResult {
  requirementId: string;
  taigaUserStoryId: string;
  taigaTaskId: string;
  alreadyProcessed: boolean;
  analysis: QaAnalysisResult;
  analysisArtifact: string;
}

export async function invokeQaAnalyst(
  boardItem: BoardRequirement,
  artifactsDir: string
): Promise<AnalystInvocationResult> {
  const requirement = toAnalystRequirement(boardItem);
  const orchestratorArtifactsDir = orchestratorDir(artifactsDir);
  const analysisArtifact = analystArtifactPath(
    requirement.requirementId,
    artifactsDir
  );

  const processed = await loadProcessedItems(orchestratorArtifactsDir);
  const existing = findProcessedItem(
    processed,
    requirement.requirementId,
    boardItem.boardTaskId
  );

  if (existing) {
    const analysis =
      (await readAnalysisArtifact(existing.analysisArtifact)) ??
      (await readAnalysisArtifact(analysisArtifact));
    if (analysis) {
      return {
        requirementId: requirement.requirementId,
        taigaUserStoryId: boardItem.sourceId,
        taigaTaskId: boardItem.boardTaskId,
        alreadyProcessed: true,
        analysis,
        analysisArtifact:
          (await firstExistingPath(
            existing.analysisArtifact,
            analysisArtifact
          )) ?? analysisArtifact,
      };
    }
  }

  const analysis = await runAnalyst(
    requirement,
    artifactsDir,
    path.resolve("test-cases"),
    analysisArtifact
  );

  await recordProcessedItem(orchestratorArtifactsDir, processed, {
    requirementId: requirement.requirementId,
    taigaUserStoryId: boardItem.sourceId,
    taigaTaskId: boardItem.boardTaskId,
    analysisArtifact,
  } satisfies ProcessedWorkflowItem);

  return {
    requirementId: requirement.requirementId,
    taigaUserStoryId: boardItem.sourceId,
    taigaTaskId: boardItem.boardTaskId,
    alreadyProcessed: false,
    analysis,
    analysisArtifact,
  };
}

export function toAnalystRequirement(
  boardItem: BoardRequirement
): Requirement {
  const requirementId = boardItem.requirementId?.trim();
  if (!requirementId) {
    throw new Error(
      `Cannot include Analyst for Taiga task ${boardItem.boardTaskId}: no explicit requirement ID was found`
    );
  }

  const description =
    boardItem.description?.trim() || boardItem.title.trim();
  if (!description) {
    throw new Error(
      `Cannot include Analyst for requirement ${requirementId}: description is empty`
    );
  }

  return {
    requirementId,
    title: boardItem.title.trim() || requirementId,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    source: "taiga",
    sourceId: boardItem.sourceId,
  };
}

async function runAnalyst(
  requirement: Requirement,
  artifactsDir: string,
  testCasesDir: string,
  outputPath: string
): Promise<QaAnalysisResult> {
  const inventory = await loadTestCaseInventory({
    artifactsDir,
    testCasesDir,
  });
  const existingTestCases = existingTestCasesFor(
    inventory,
    requirement.requirementId
  );
  const existingAnalysis = existingAnalysisFor(
    inventory,
    requirement.requirementId
  );

  const result = await runQaAnalysis(requirement, {
    requirementId: requirement.requirementId,
    existingTestCases,
    existingAnalysis,
  });

  await persistTestCases(testCasesDir, result.testCases);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");

  return result;
}

async function readAnalysisArtifact(
  filePath: string
): Promise<QaAnalysisResult | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Partial<QaAnalysisResult>;
    if (
      typeof record.requirementId !== "string" ||
      !Array.isArray(record.testCases)
    ) {
      return undefined;
    }

    return record as QaAnalysisResult;
  } catch {
    return undefined;
  }
}

function extractAcceptanceCriteria(markdown: string): string[] {
  const criteria: string[] = [];
  const acHeading = /^#{2,3}\s+(AC-\d+\b.*)$/gim;
  let match: RegExpExecArray | null = acHeading.exec(markdown);

  while (match) {
    const heading = match[1]?.trim();
    if (heading) {
      criteria.push(heading);
    }
    match = acHeading.exec(markdown);
  }

  return criteria;
}

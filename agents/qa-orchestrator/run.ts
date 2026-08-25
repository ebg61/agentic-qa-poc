import "dotenv/config";
import path from "node:path";
import {
  INTENDED_WORKFLOW_STATUSES,
  type BoardAdapter,
  type BoardRequirement,
  type BoardStatus,
} from "../../integrations/board.js";
import { createTaigaAdapter } from "../../integrations/taiga/adapter.js";
import { invokeQaAnalyst } from "./handoff.js";
import { buildQaAuditComment } from "./audit-comment.js";
import {
  aggregateRequirementQaDecision,
  continueAfterAnalyst,
  logFinalQaFlow,
} from "./pipeline.js";

/**
 * QA Orchestrator — Taiga discovery and agent coordination.
 *
 * READY FOR QA Tasks are the only input trigger.
 * includeAnalyst decides whether QA Analyst is invoked.
 * After Analyst Test Cases exist, Automation and Reviewer continue
 * automatically. The QA Reviewer result is the final QA decision and
 * the only input used to update the Taiga Task status. A Task is never
 * moved without a QA audit comment.
 */
async function main(): Promise<void> {
  const artifactsDir = path.resolve("artifacts");
  const adapter = createTaigaAdapter();

  console.log("QA Orchestrator");
  console.log("");
  console.log("Board source: Taiga");
  console.log("");

  const project = await adapter.getProject();
  console.log(`Project: ${project.name}`);
  console.log(`Project slug: ${project.slug}`);
  console.log(`Project ID: ${project.id}`);
  console.log("");

  const statuses = await adapter.getStatuses();
  printTaskStatuses(statuses);

  const readyStatus = statuses.find(
    (status) => status.intendedName === "READY FOR QA"
  );
  const pendingStatus = statuses.find(
    (status) => status.intendedName === "PENDING QA REVIEW"
  );

  if (!readyStatus) {
    console.log("READY FOR QA status was not found.");
    console.log("No statuses were created or renamed.");
    console.log("");
  } else {
    console.log(
      `READY FOR QA status identified: id ${readyStatus.id}, name "${readyStatus.name}"`
    );
    console.log("");
  }

  if (pendingStatus) {
    console.log(
      `PENDING QA REVIEW status identified: id ${pendingStatus.id}, name "${pendingStatus.name}"`
    );
    console.log("");
  }

  const ready = await adapter.getReadyForQA();
  printReadyForQA(ready);

  if (ready.length === 0) {
    console.log("No requirements currently in READY FOR QA.");
    console.log("includeAnalyst: false");
    console.log("Analyst was not invoked.");
    printSafetyFooter({ statusUpdated: false, commentAdded: false });
    return;
  }

  let statusUpdated = false;
  let commentAdded = false;
  let incompleteClose = false;
  for (const item of ready) {
    const outcome = await processReadyItem(item, artifactsDir, adapter);
    if (outcome.statusUpdated) {
      statusUpdated = true;
    }
    if (outcome.commentAdded) {
      commentAdded = true;
    }
    if (outcome.statusUpdated && !outcome.commentAdded) {
      incompleteClose = true;
    }
  }

  printSafetyFooter({ statusUpdated, commentAdded });
  if (incompleteClose) {
    console.log(
      "QA flow was not fully closed: a Taiga Task was moved but the audit comment could not be added."
    );
    process.exitCode = 1;
  }
}

async function processReadyItem(
  item: BoardRequirement,
  artifactsDir: string,
  adapter: BoardAdapter
): Promise<{ statusUpdated: boolean; commentAdded: boolean }> {
  console.log(
    `requirementId: ${item.requirementId ?? "(none)"}`
  );
  console.log(`taigaUserStoryId: ${item.sourceId}`);
  console.log(`taigaTaskId: ${item.boardTaskId}`);
  console.log("");

  const includeAnalyst = Boolean(item.requirementId?.trim());
  console.log(`includeAnalyst: ${includeAnalyst}`);

  if (!includeAnalyst) {
    console.log(
      `Skipping Taiga task ${item.boardTaskId}: no explicit requirement ID; none was invented.`
    );
    console.log("QA Analyst was not invoked.");
    console.log("");
    return { statusUpdated: false, commentAdded: false };
  }

  console.log("Handing requirement to QA Analyst...");
  console.log("");

  try {
    const analyst = await invokeQaAnalyst(item, artifactsDir);

    if (analyst.alreadyProcessed) {
      console.log(
        `This Task was already processed (requirementId=${analyst.requirementId}, taigaTaskId=${analyst.taigaTaskId}).`
      );
      console.log("Reusing existing Analyst artifact. Analyst was not invoked again.");
    }

    console.log("QA Analyst:");
    console.log(`Requirement: ${analyst.requirementId}`);
    console.log("Test cases:");
    if (analyst.analysis.testCases.length === 0) {
      console.log("- (none)");
    } else {
      for (const testCase of analyst.analysis.testCases) {
        console.log(`- ${testCase.id}`);
      }
    }
    console.log(`Artifact: ${analyst.analysisArtifact}`);
    console.log("");

    const flowResults = await continueAfterAnalyst({
      analyst,
      artifactsDir,
      requirementText: item.description?.trim() || item.title.trim(),
      requirementTitle: item.title.trim() || analyst.requirementId,
    });
    const requirementDecision = aggregateRequirementQaDecision(flowResults);
    logFinalQaFlow(flowResults, requirementDecision);

    if (!requirementDecision) {
      return { statusUpdated: false, commentAdded: false };
    }

    const comment = await buildQaAuditComment({
      requirementId: requirementDecision.requirementId,
      requirementTitle: item.title.trim() || requirementDecision.requirementId,
      decision: requirementDecision,
      results: flowResults,
      artifactsDir,
      repoRoot: path.resolve("."),
    });

    let statusUpdated = false;
    try {
      await adapter.setTaskStatus(item.boardTaskId, requirementDecision.taigaStatus);
      statusUpdated = true;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`Taiga status update failed: ${reason}`);
      console.log("QA audit comment was not added because the status update failed.");
      console.log("");
      return { statusUpdated: false, commentAdded: false };
    }

    console.log("Adding QA audit comment to Taiga...");
    try {
      await adapter.addTaskComment(item.boardTaskId, comment);
      console.log("Taiga audit comment added successfully.");
      console.log(
        `Taiga task ${item.boardTaskId} updated to ${requirementDecision.taigaStatus}.`
      );
      console.log("");
      return { statusUpdated: true, commentAdded: true };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(
        `Taiga task ${item.boardTaskId} was moved to ${requirementDecision.taigaStatus}, but the audit comment could not be added: ${reason}`
      );
      console.log("");
      return { statusUpdated, commentAdded: false };
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log("QA Analyst:");
    console.log(`Requirement: ${item.requirementId}`);
    console.log("status: FAILED");
    console.log(`error: ${reason}`);
    console.log("");
    console.log("Including QA Automation...");
    console.log("QA Automation: skipped because Analyst failed.");
    console.log("");
    console.log("Including QA Reviewer...");
    console.log("QA Reviewer: skipped because Analyst failed.");
    console.log("");
    console.log("Final QA flow:");
    console.log(`${item.requirementId} / (no test cases)`);
    console.log("Analyst: FAILED");
    console.log("Automation: NOT_RUN");
    console.log("Reviewer: NOT_RUN");
    console.log("");
    console.log("Final Reviewer decision: unavailable");
    console.log("Taiga action: none");
    console.log("");
    return { statusUpdated: false, commentAdded: false };
  }
}

function printTaskStatuses(statuses: BoardStatus[]): void {
  console.log("Task workflow statuses:");
  console.log("");

  if (statuses.length === 0) {
    console.log("- (none returned)");
    console.log("");
    return;
  }

  for (const status of statuses) {
    const arrow = status.intendedName
      ? ` → ${status.intendedName}`
      : " → (not in intended workflow)";
    console.log(`- ${status.name}${arrow}  (id ${status.id})`);
  }

  console.log("");
  console.log("Intended workflow coverage:");

  for (const intended of INTENDED_WORKFLOW_STATUSES) {
    const match = statuses.find((status) => status.intendedName === intended);
    if (match) {
      console.log(`- ${intended}: present (id ${match.id}, name "${match.name}")`);
    } else {
      console.log(`- ${intended}: MISSING`);
    }
  }

  console.log("");
}

function printReadyForQA(requirements: BoardRequirement[]): void {
  console.log("READY FOR QA tasks:");
  console.log("");

  if (requirements.length === 0) {
    return;
  }

  for (const requirement of requirements) {
    console.log("Task:");
    console.log(`  Taiga Task ID: ${requirement.boardTaskId}`);
    console.log(`  Title: ${requirement.boardTaskTitle}`);
    console.log(`  Status: ${requirement.boardTaskStatusName}`);
    console.log(`  Parent User Story ID: ${requirement.sourceId}`);
    console.log(
      `  Requirement ID: ${requirement.requirementId ?? "(no explicit requirement ID)"}`
    );
    console.log(`  Requirement title: ${requirement.title}`);
    console.log("");
  }
}

function printSafetyFooter(options: {
  statusUpdated: boolean;
  commentAdded: boolean;
}): void {
  if (options.statusUpdated && options.commentAdded) {
    console.log("This run did not add Taiga attachments.");
    return;
  }

  if (options.statusUpdated) {
    console.log(
      "This run updated a Taiga Task status but did not add the required audit comment."
    );
    return;
  }

  console.log("This run did not modify Taiga (no status changes, comments, or attachments).");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

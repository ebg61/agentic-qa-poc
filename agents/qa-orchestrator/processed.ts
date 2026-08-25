/**
 * Simple processed-work log for the Orchestrator.
 *
 * Identity is requirementId + boardTaskId. Not a database and not versioning.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProcessedWorkflowItem {
  requirementId: string;
  taigaUserStoryId: string;
  taigaTaskId: string;
  analysisArtifact: string;
}

const PROCESSED_FILE = "processed.json";

export function workflowIdentity(
  requirementId: string,
  boardTaskId: string
): string {
  return `${requirementId}::${boardTaskId}`;
}

export async function loadProcessedItems(
  orchestratorDir: string
): Promise<ProcessedWorkflowItem[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(orchestratorDir, PROCESSED_FILE), "utf8")
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) {
      return [];
    }
    return items.flatMap((item) => {
      const record = asProcessedItem(item);
      return record ? [record] : [];
    });
  } catch {
    return [];
  }
}

export function findProcessedItem(
  items: ProcessedWorkflowItem[],
  requirementId: string,
  boardTaskId: string
): ProcessedWorkflowItem | undefined {
  const key = workflowIdentity(requirementId, boardTaskId);
  return items.find(
    (item) => workflowIdentity(item.requirementId, item.taigaTaskId) === key
  );
}

export async function recordProcessedItem(
  orchestratorDir: string,
  items: ProcessedWorkflowItem[],
  item: ProcessedWorkflowItem
): Promise<ProcessedWorkflowItem[]> {
  const next = [
    ...items.filter(
      (existing) =>
        workflowIdentity(existing.requirementId, existing.taigaTaskId) !==
        workflowIdentity(item.requirementId, item.taigaTaskId)
    ),
    item,
  ];

  await mkdir(orchestratorDir, { recursive: true });
  await writeFile(
    path.join(orchestratorDir, PROCESSED_FILE),
    JSON.stringify({ items: next }, null, 2),
    "utf8"
  );

  return next;
}

function asProcessedItem(value: unknown): ProcessedWorkflowItem | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.requirementId !== "string" ||
    typeof record.taigaUserStoryId !== "string" ||
    typeof record.taigaTaskId !== "string" ||
    typeof record.analysisArtifact !== "string"
  ) {
    return undefined;
  }

  return {
    requirementId: record.requirementId,
    taigaUserStoryId: record.taigaUserStoryId,
    taigaTaskId: record.taigaTaskId,
    analysisArtifact: record.analysisArtifact,
  };
}

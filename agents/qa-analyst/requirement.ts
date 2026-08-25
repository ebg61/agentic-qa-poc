/**
 * Local filesystem requirement source for the PoC.
 *
 * This is not a plugin framework. Future board sources can return the
 * same Requirement shape without changing Analyst reasoning.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Requirement {
  requirementId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  source: "local" | "taiga";
  sourceId: string;
}

const REQUIREMENT_FILE_PATTERN = /^(.+)\.md$/;

export async function discoverLocalRequirementIds(
  requirementsDir: string
): Promise<string[]> {
  const entries = await readdir(requirementsDir);
  return entries
    .flatMap((name) => {
      const match = REQUIREMENT_FILE_PATTERN.exec(name);
      return match?.[1] ? [match[1]] : [];
    })
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export async function loadLocalRequirement(
  requirementId: string,
  requirementsDir: string
): Promise<Requirement> {
  const filePath = path.join(requirementsDir, `${requirementId}.md`);
  let markdown: string;

  try {
    markdown = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read requirement file at "${filePath}": ${reason}`
    );
  }

  if (!markdown.trim()) {
    throw new Error(`Requirement ${requirementId} is empty`);
  }

  return {
    requirementId,
    title: extractTitle(markdown, requirementId),
    description: markdown.trim(),
    acceptanceCriteria: extractAcceptanceCriteria(markdown),
    source: "local",
    sourceId: requirementId,
  };
}

function extractTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  const heading = match?.[1]?.trim();
  return heading || fallback;
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

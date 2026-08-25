/**
 * Reset PoC generated/runtime state for a clean first run.
 *
 * Does not modify Taiga, agents, integrations, .env, configuration,
 * persistent test-case definitions, or the US-001/TC-001 baseline spec.
 * Does not run Analyst, Automation, Reviewer, or Playwright.
 */

import { rm, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, "artifacts");
const TESTS_DIR = path.join(PROJECT_ROOT, "tests");

const PRESERVED_TEST_SPECS = new Set([
  "example.spec.ts",
  "groupon-homepage.spec.ts",
]);

const PRESERVED_REQUIREMENT_SPECS = new Set(["US-001/TC-001.spec.ts"]);

const ROOT_RUNTIME_DIRS = ["test-results", "playwright-report", "blob-report"];

async function main(): Promise<void> {
  const deleted: string[] = [];

  deleted.push(...(await cleanArtifacts(ARTIFACTS_DIR)));
  deleted.push(...(await cleanGeneratedSpecs(TESTS_DIR)));
  deleted.push(...(await cleanRootRuntimeDirs(PROJECT_ROOT)));

  console.log("PoC runtime reset complete.");
  console.log(`Removed ${deleted.length} generated/runtime path(s).`);
  for (const item of deleted.sort()) {
    console.log(`- ${path.relative(PROJECT_ROOT, item)}`);
  }
}

async function cleanArtifacts(artifactsDir: string): Promise<string[]> {
  const removed: string[] = [];
  let entries;

  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const fullPath = path.join(artifactsDir, entry.name);
    await rm(fullPath, { recursive: true, force: true });
    removed.push(fullPath);
  }

  return removed;
}

async function cleanGeneratedSpecs(testsDir: string): Promise<string[]> {
  const removed: string[] = [];
  let entries;

  try {
    entries = await readdir(testsDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const fullPath = path.join(testsDir, entry.name);

    if (entry.isFile()) {
      if (PRESERVED_TEST_SPECS.has(entry.name)) {
        continue;
      }
      if (await isGeneratedAutomationSpec(fullPath)) {
        await rm(fullPath, { force: true });
        removed.push(fullPath);
      }
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    removed.push(...(await cleanRequirementSpecs(fullPath, entry.name)));
  }

  return removed;
}

async function cleanRequirementSpecs(
  requirementDir: string,
  requirementId: string
): Promise<string[]> {
  const removed: string[] = [];
  let entries;

  try {
    entries = await readdir(requirementDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const relative = `${requirementId}/${entry.name}`;
    if (PRESERVED_REQUIREMENT_SPECS.has(relative)) {
      continue;
    }

    const fullPath = path.join(requirementDir, entry.name);
    if (await isGeneratedAutomationSpec(fullPath)) {
      await rm(fullPath, { force: true });
      removed.push(fullPath);
    }
  }

  return removed;
}

async function isGeneratedAutomationSpec(filePath: string): Promise<boolean> {
  if (!filePath.endsWith(".spec.ts") && !filePath.endsWith(".spec.js")) {
    return false;
  }

  try {
    const source = await readFile(filePath, "utf8");
    return source.includes("Generated QA Automation spec.");
  } catch {
    return false;
  }
}

async function cleanRootRuntimeDirs(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];

  for (const name of ROOT_RUNTIME_DIRS) {
    const fullPath = path.join(projectRoot, name);
    try {
      await stat(fullPath);
    } catch {
      continue;
    }

    await rm(fullPath, { recursive: true, force: true });
    removed.push(fullPath);
  }

  return removed;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

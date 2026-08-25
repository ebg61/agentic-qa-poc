import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runQaReview } from "./index.js";
import { readRequirementTitle, renderQaReviewHtml } from "./report.js";
import { reviewerReportPaths } from "../artifact-paths.js";

async function main(): Promise<void> {
  const requirementId = process.argv[2]?.trim() || "US-001";
  const testCaseId = process.argv[3]?.trim() || undefined;
  const targetLabel = testCaseId
    ? `${requirementId} / ${testCaseId}`
    : requirementId;

  const reports = reviewerReportPaths(requirementId, testCaseId);
  const jsonPath = reports.json;
  const htmlPath = reports.html;
  const requirementPath = path.resolve(
    "requirements",
    `${requirementId}.md`
  );

  console.log(`Running QA Reviewer for ${targetLabel}...`);

  const result = testCaseId
    ? await runQaReview({ requirementId, testCaseId })
    : await runQaReview({ requirementId });
  const requirementTitle = await readRequirementTitle(requirementPath);
  const html = renderQaReviewHtml(result, { requirementTitle });

  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");
  await writeFile(htmlPath, html, "utf8");

  console.log(`requirementId: ${requirementId}`);
  if (testCaseId) {
    console.log(`testCaseId: ${testCaseId}`);
  }
  console.log(`Overall assessment: ${result.overallAssessment}`);

  for (const testCase of result.functionalTestCases) {
    console.log(
      `${testCase.id}: ${testCase.status} coverage=${testCase.coverageStatus} (${testCase.linksChecked ?? "?"}/${testCase.linksDiscovered ?? "?"} links)`
    );
  }

  console.log(`Findings: ${result.findings.length}`);
  console.log(`Product issues: ${result.productIssues.length}`);
  console.log(`Coverage gaps: ${result.coverageGaps.length}`);
  console.log(
    `Artifact inconsistencies: ${result.artifactInconsistencies.length}`
  );
  console.log(`QA review written to: ${jsonPath}`);
  console.log(`HTML report written to: ${htmlPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import { readFile } from "node:fs/promises";
import type {
  ArtifactInconsistency,
  CoverageGap,
  FunctionalTestCaseReview,
  OverallAssessment,
  QaReviewResult,
  ReviewFinding,
  ScopeRecommendation,
} from "./index.js";

export interface HtmlReportOptions {
  requirementTitle?: string;
}

export function renderQaReviewHtml(
  review: QaReviewResult,
  options: HtmlReportOptions = {}
): string {
  const title =
    options.requirementTitle?.trim() ||
    review.requirementId ||
    "QA Review";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — QA Review</title>
  <style>
    :root {
      --bg: #f4f5f7;
      --card: #ffffff;
      --text: #1f2933;
      --muted: #5c6b73;
      --line: #d9e2ec;
      --pass: #0f7b3a;
      --pass-bg: #e3f6ea;
      --fail: #9b1c1c;
      --fail-bg: #fde8e8;
      --inconclusive: #8a5a00;
      --inconclusive-bg: #fff4db;
      --neutral: #334e68;
      --neutral-bg: #e8eef4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main {
      max-width: 880px;
      margin: 0 auto;
      padding: 28px 20px 48px;
    }
    h1, h2, h3 { margin: 0 0 10px; font-weight: 650; }
    h1 { font-size: 1.55rem; }
    h2 { font-size: 1.05rem; }
    h3 { font-size: 0.95rem; color: var(--muted); }
    p { margin: 0 0 10px; }
    .muted { color: var(--muted); }
    .header, .card, .warning {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 16px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .eyebrow {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 6px 12px;
      font-weight: 700;
      font-size: 0.88rem;
      white-space: nowrap;
    }
    .badge-pass { background: var(--pass-bg); color: var(--pass); }
    .badge-fail { background: var(--fail-bg); color: var(--fail); }
    .badge-inconclusive { background: var(--inconclusive-bg); color: var(--inconclusive); }
    .badge-neutral { background: var(--neutral-bg); color: var(--neutral); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 0.8rem; font-weight: 600; }
    .finding { border-top: 1px solid var(--line); padding: 12px 0; }
    .finding:first-of-type { border-top: 0; padding-top: 0; }
    .meta { font-size: 0.9rem; color: var(--muted); }
    ol { margin: 0; padding-left: 20px; }
    li { margin: 0 0 8px; }
    .empty { color: var(--muted); font-style: italic; }
    .warning { background: #fff7e6; border-color: #f0d58a; }
    .coverage-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 700px) {
      .header, .coverage-grid { display: block; }
    }
  </style>
</head>
<body>
  <main>
    <section class="header">
      <div>
        <div class="eyebrow">QA Review</div>
        <h1>${escapeHtml(title)}</h1>
        <p class="muted">Requirement ${escapeHtml(review.requirementId)}</p>
      </div>
      ${statusBadge(review.overallAssessment)}
    </section>

    <section class="card">
      <h2>Test case summary</h2>
      ${renderTestCases(review.functionalTestCases)}
    </section>

    <section class="card">
      <h2>Key findings</h2>
      ${renderFindings(review.findings)}
    </section>

    <section class="card">
      <h2>Scope refinement recommendations</h2>
      <p class="muted">These are Reviewer recommendations only. They are not human QA decisions and never set approvedByQA.</p>
      ${renderScopeRecommendations(review.scopeRecommendations)}
    </section>

    <section class="card">
      <h2>Product issues</h2>
      ${renderProductIssues(review.productIssues)}
    </section>

    <section class="card">
      <h2>Coverage</h2>
      <div class="coverage-grid">
        <div>
          <h3>Execution coverage</h3>
          ${renderExecutionCoverage(review.functionalTestCases)}
        </div>
        <div>
          <h3>Validation confidence</h3>
          ${renderCoverageGaps(review.coverageGaps)}
        </div>
      </div>
    </section>

    ${renderArtifactConsistency(review.artifactInconsistencies)}

    <section class="card">
      <h2>Recommendations</h2>
      ${renderRecommendations(review.recommendations)}
    </section>

    <section class="card">
      <h2>QA assessment</h2>
      ${renderAssessment(review.qaAssessment)}
    </section>
  </main>
</body>
</html>
`;
}

export async function readRequirementTitle(
  requirementPath: string
): Promise<string | undefined> {
  try {
    const markdown = await readFile(requirementPath, "utf8");
    const match = markdown.match(/^#\s+(.+)$/m);
    const heading = match?.[1]?.trim();
    return heading || undefined;
  } catch {
    return undefined;
  }
}

function renderTestCases(testCases: FunctionalTestCaseReview[]): string {
  if (testCases.length === 0) {
    return `<p class="empty">No functional test cases in this review.</p>`;
  }

  const rows = testCases
    .map((testCase) => {
      const discovered = formatCount(testCase.linksDiscovered);
      const checked = formatCount(testCase.linksChecked);
      return `<tr>
        <td><strong>${escapeHtml(testCase.id)}</strong></td>
        <td>${statusBadge(testCase.status)}</td>
        <td>${coverageBadge(testCase.coverageStatus)}</td>
        <td>${escapeHtml(`${checked} / ${discovered}`)}</td>
      </tr>`;
    })
    .join("");

  return `<table>
    <thead>
      <tr>
        <th>Test case</th>
        <th>Status</th>
        <th>Coverage</th>
        <th>Links checked</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return `<p class="empty">No key findings.</p>`;
  }

  return findings
    .map((finding) => {
      const classification = finding.classification
        ? statusBadge(finding.classification)
        : "";
      return `<article class="finding">
        <p><strong>${escapeHtml(finding.summary)}</strong> ${classification}</p>
        <p class="meta">${escapeHtml(findingMeta(finding))}</p>
        <p>${escapeHtml(finding.rationale)}</p>
      </article>`;
    })
    .join("");
}

function renderScopeRecommendations(
  recommendations: ScopeRecommendation[] | undefined
): string {
  if (!recommendations || recommendations.length === 0) {
    return `<p class="empty">No scope refinement recommendation available.</p>`;
  }

  return recommendations
    .map(
      (item) => `<article class="finding">
        <p><strong>${escapeHtml(item.target)}</strong> — ${escapeHtml(item.proposedAction)}</p>
        <p class="meta">${escapeHtml(item.testCaseId)}</p>
        <p>${escapeHtml(item.rationale)}</p>
      </article>`
    )
    .join("");
}

function renderProductIssues(issues: ReviewFinding[]): string {
  if (issues.length === 0) {
    return `<p>Product issues: <strong>0</strong></p>
      <p class="empty">No Groupon product defects were confirmed from the current execution evidence.</p>`;
  }

  const items = issues
    .map((issue) => {
      return `<article class="finding">
        <p><strong>${escapeHtml(issue.summary)}</strong></p>
        <p class="meta">${escapeHtml(findingMeta(issue))}</p>
        <p>${escapeHtml(issue.rationale)}</p>
      </article>`;
    })
    .join("");

  return `<p>Product issues: <strong>${issues.length}</strong></p>${items}`;
}

function renderExecutionCoverage(testCases: FunctionalTestCaseReview[]): string {
  if (testCases.length === 0) {
    return `<p class="empty">Execution coverage is unknown.</p>`;
  }

  return testCases
    .map((testCase) => {
      const discovered = formatCount(testCase.linksDiscovered);
      const checked = formatCount(testCase.linksChecked);
      return `<p><strong>${escapeHtml(testCase.id)}</strong></p>
        <p>${escapeHtml(`${checked} / ${discovered}`)} links checked</p>
        <p>${coverageBadge(testCase.coverageStatus)}</p>
        <p class="muted">COMPLETE execution coverage does not mean the product is fully validated.</p>`;
    })
    .join("");
}

function renderCoverageGaps(gaps: CoverageGap[]): string {
  if (gaps.length === 0) {
    return `<p class="empty">No coverage gaps were reported.</p>`;
  }

  return gaps
    .map(
      (gap) => `<p><strong>${escapeHtml(gap.summary)}</strong></p>
        <p class="muted">${escapeHtml(gap.rationale)}</p>`
    )
    .join("");
}

function renderArtifactConsistency(
  inconsistencies: ArtifactInconsistency[]
): string {
  if (inconsistencies.length === 0) {
    return `<section class="card">
      <h2>Artifact consistency</h2>
      <p>No artifact inconsistencies were reported.</p>
    </section>`;
  }

  const items = inconsistencies
    .map((item) => {
      const artifacts = item.artifacts
        .map((artifact) => `<li>${escapeHtml(artifact)}</li>`)
        .join("");
      return `<p><strong>WARNING</strong> — ${escapeHtml(item.summary)}</p>
        <p>Stronger evidence: ${escapeHtml(item.strongerEvidence)}</p>
        <p>${escapeHtml(item.rationale)}</p>
        ${artifacts ? `<ul>${artifacts}</ul>` : ""}`;
    })
    .join("");

  return `<section class="warning">
    <h2>Artifact consistency</h2>
    ${items}
  </section>`;
}

function renderRecommendations(recommendations: string[]): string {
  if (recommendations.length === 0) {
    return `<p class="empty">No recommendations were reported.</p>`;
  }

  const items = recommendations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `<ol>${items}</ol>`;
}

function renderAssessment(assessment: string): string {
  const sentences = assessment
    .split(/(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return `<p>${escapeHtml(assessment)}</p>`;
  }

  return sentences.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join("");
}

function findingMeta(finding: ReviewFinding): string {
  const parts: string[] = [];
  if (finding.httpStatus !== undefined) {
    parts.push(`HTTP ${finding.httpStatus}`);
  }
  if (finding.originalUrl) {
    parts.push(finding.originalUrl);
  }
  return parts.join(" · ");
}

function statusBadge(status: OverallAssessment | string): string {
  const normalized = status.toUpperCase();
  if (normalized === "PASS" || normalized === "PASSED") {
    return `<span class="badge badge-pass" title="Assessment: PASS">✓ PASS</span>`;
  }
  if (normalized === "FAIL" || normalized === "FAILED") {
    return `<span class="badge badge-fail" title="Assessment: FAIL">✕ FAIL</span>`;
  }
  return `<span class="badge badge-inconclusive" title="Assessment: INCONCLUSIVE">? INCONCLUSIVE</span>`;
}

function coverageBadge(status: string): string {
  return `<span class="badge badge-neutral" title="Execution coverage">${escapeHtml(status)}</span>`;
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Local QA Review UI.
 *
 * Distinguishes Reviewer findings, Reviewer scope recommendations,
 * human QA decisions, and applied QA decisions.
 *
 * Does not run Playwright, change tests, or call the LLM.
 * Reviewer never sets approvedByQA. Only an explicit human submit
 * may create or update qa-feedback.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRequirementTitle } from "../agents/qa-reviewer/report.js";
import type { QaReviewResult, ReviewFinding } from "../agents/qa-reviewer/index.js";
import {
  reviewerFeedbackPath,
  reviewerReportPaths,
} from "../agents/artifact-paths.js";

const PORT = Number(process.env.PORT) || 3000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_PATH = reviewerReportPaths("US-001").json;
const FEEDBACK_PATH = reviewerFeedbackPath("US-001");
const REQUIREMENT_PATH = path.join(repoRoot, "requirements", "US-001.md");
const REVIEW_ID = "qa-review-US-001";

type HumanDecisionValue =
  | "KEEP_IN_SCOPE"
  | "EXCLUDE"
  | "NEED_MORE_INVESTIGATION";

interface ScopeRecommendation {
  testCaseId: string;
  target: string;
  proposedAction: "EXCLUDE";
  rationale: string;
}

interface HumanQaDecision {
  type: "SCOPE_REFINEMENT";
  requirementId: string;
  testCaseId: string;
  target: string;
  action: HumanDecisionValue;
  proposedAction?: "EXCLUDE" | HumanDecisionValue | "";
  humanDecision: HumanDecisionValue;
  decision: "APPROVED" | HumanDecisionValue;
  approvedByQA: boolean;
  reason: string;
  qaRationale: string;
  timestamp: string;
  source: "human_qa";
}

interface QaFeedback {
  requirementId: string;
  reviewId: string;
  decisions: HumanQaDecision[];
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`QA Review UI: http://localhost:${PORT}`);
  console.log("Submitting a decision does not run Playwright or change tests.");
});

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/") {
      const html = await renderPage();
      send(res, 200, "text/html; charset=utf-8", html);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/decision") {
      const body = await readBody(req);
      await saveDecision(body);
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }

    send(res, 404, "text/plain; charset=utf-8", "Not found");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, 400, "text/plain; charset=utf-8", message);
  }
}

async function renderPage(): Promise<string> {
  const review = await loadReview();
  const feedback = await loadFeedback();
  const requirementTitle =
    (await readRequirementTitle(REQUIREMENT_PATH)) ?? review.requirementId;
  const recommendations = getScopeRecommendations(review);
  const testCase = review.functionalTestCases[0];
  const testCaseId = testCase?.id ?? "TC-001";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QA Review — ${escapeHtml(requirementTitle)}</title>
  <style>
    :root {
      --bg: #f4f5f7;
      --card: #fff;
      --text: #1f2933;
      --muted: #5c6b73;
      --line: #d9e2ec;
      --fail: #9b1c1c;
      --fail-bg: #fde8e8;
      --inconclusive: #8a5a00;
      --inconclusive-bg: #fff4db;
      --pass: #0f7b3a;
      --pass-bg: #e3f6ea;
      --neutral: #334e68;
      --neutral-bg: #e8eef4;
      --notice: #fff7e6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main { max-width: 880px; margin: 0 auto; padding: 28px 20px 48px; }
    h1, h2, h3 { margin: 0 0 10px; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1.05rem; }
    p { margin: 0 0 10px; }
    .muted { color: var(--muted); }
    .card, .notice {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px 20px;
      margin-bottom: 16px;
    }
    .notice { background: var(--notice); border-color: #f0d58a; }
    .header { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .eyebrow { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .badge { display: inline-flex; border-radius: 999px; padding: 6px 12px; font-weight: 700; font-size: 0.88rem; }
    .badge-fail { background: var(--fail-bg); color: var(--fail); }
    .badge-pass { background: var(--pass-bg); color: var(--pass); }
    .badge-inconclusive { background: var(--inconclusive-bg); color: var(--inconclusive); }
    .badge-neutral { background: var(--neutral-bg); color: var(--neutral); }
    .finding { border-top: 1px solid var(--line); padding: 12px 0; }
    .finding:first-of-type { border-top: 0; padding-top: 0; }
    .meta { color: var(--muted); font-size: 0.9rem; }
    label { display: block; margin: 8px 0; }
    input[type="text"],
    textarea {
      width: 100%;
      margin-top: 6px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      font: inherit;
    }
    textarea {
      min-height: 88px;
    }
    button {
      display: inline-block;
      background: #243b53;
      color: #fff;
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .empty { color: var(--muted); font-style: italic; }
    dl { display: grid; grid-template-columns: 180px 1fr; gap: 6px 12px; margin: 0 0 12px; }
    dt { color: var(--muted); }
    dd { margin: 0; }
  </style>
</head>
<body>
  <main>
    <section class="notice">
      <strong>Human-in-the-loop.</strong>
      Reviewer findings are not QA decisions. A Reviewer scope recommendation
      is not applied until a human QA submits a decision.
      Submitting a decision does not change tests and does not execute Playwright.
      Reviewer never sets <code>approvedByQA: true</code>.
    </section>

    <section class="card header">
      <div>
        <div class="eyebrow">QA Review</div>
        <h1>${escapeHtml(requirementTitle)}</h1>
        <p class="muted">Requirement ${escapeHtml(review.requirementId)} · Test case ${escapeHtml(testCaseId)}</p>
      </div>
      <div>
        <div class="eyebrow">Overall assessment</div>
        ${statusBadge(review.overallAssessment)}
      </div>
    </section>

    <section class="card">
      <h2>Test case summary</h2>
      ${renderTestCase(testCase, review.productIssues.length)}
    </section>

    <section class="card">
      <div class="eyebrow">Reviewer finding</div>
      <h2>Findings</h2>
      <p class="muted">These are Reviewer observations. They are not scope recommendations and cannot exclude URLs.</p>
      ${renderFindings(review.findings)}
    </section>

    <section class="card">
      <div class="eyebrow">Reviewer scope recommendation</div>
      <h2>Scope refinement recommendation</h2>
      ${renderScopeRecommendations(recommendations, review.requirementId)}
    </section>

    <section class="card">
      <div class="eyebrow">Human QA decision</div>
      <h2>Human QA decision</h2>
      ${renderHumanDecisionSection(recommendations, review.requirementId, testCaseId)}
    </section>

    <section class="card">
      <div class="eyebrow">Applied QA decision</div>
      <h2>Applied QA decision</h2>
      <p class="muted">Automation may apply an exclusion only for this requirement and test case after an explicit human submit. Decisions are not global host blacklists.</p>
      ${renderAppliedDecisions(feedback, review.requirementId, testCaseId)}
    </section>
  </main>
</body>
</html>`;
}

function renderTestCase(
  testCase: QaReviewResult["functionalTestCases"][0] | undefined,
  productIssueCount: number
): string {
  if (!testCase) {
    return `<p class="empty">No functional test case in the Reviewer JSON.</p>`;
  }

  const discovered = testCase.linksDiscovered ?? "—";
  const checked = testCase.linksChecked ?? "—";

  return `<dl>
    <dt>Test case</dt><dd><strong>${escapeHtml(testCase.id)}</strong></dd>
    <dt>Execution</dt><dd>${statusBadge(testCase.status)}</dd>
    <dt>Coverage</dt><dd>${escapeHtml(testCase.coverageStatus)} — ${escapeHtml(String(checked))} / ${escapeHtml(String(discovered))}</dd>
    <dt>Product issues</dt><dd><strong>${productIssueCount}</strong></dd>
  </dl>`;
}

function renderFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return `<p class="empty">No findings in the Reviewer JSON.</p>`;
  }

  return findings
    .map((finding) => {
      const meta = [
        finding.httpStatus !== undefined ? `HTTP ${finding.httpStatus}` : "",
        finding.originalUrl ?? "",
      ]
        .filter(Boolean)
        .join(" · ");
      const classification = finding.classification
        ? statusBadge(finding.classification)
        : "";
      return `<article class="finding">
        <p><strong>${escapeHtml(finding.summary)}</strong> ${classification}</p>
        <p class="meta">${escapeHtml(meta)}</p>
        <p>${escapeHtml(finding.rationale)}</p>
      </article>`;
    })
    .join("");
}

function renderScopeRecommendations(
  recommendations: ScopeRecommendation[],
  requirementId: string
): string {
  if (recommendations.length === 0) {
    return `<p class="empty">No scope refinement recommendation available.</p>`;
  }

  return recommendations
    .map(
      (recommendation) => `<article class="finding">
        <dl>
          <dt>Requirement ID</dt><dd>${escapeHtml(requirementId)}</dd>
          <dt>Test Case ID</dt><dd>${escapeHtml(recommendation.testCaseId)}</dd>
          <dt>Target</dt><dd>${escapeHtml(recommendation.target)}</dd>
          <dt>Proposed action</dt><dd>${escapeHtml(recommendation.proposedAction)}</dd>
          <dt>Rationale</dt><dd>${escapeHtml(recommendation.rationale)}</dd>
        </dl>
        <p class="meta">This is a Reviewer recommendation only. It is not a human QA decision and is not applied to Automation.</p>
      </article>`
    )
    .join("");
}

function renderHumanDecisionSection(
  recommendations: ScopeRecommendation[],
  requirementId: string,
  testCaseId: string
): string {
  const forTestCase = recommendations.filter(
    (item) => item.testCaseId === testCaseId
  );

  if (forTestCase.length === 0) {
    return `<p class="muted">No Reviewer scope recommendation is available. You can still submit a human QA decision for this requirement and test case. qa-feedback is not written until you click Submit Decision.</p>
      ${renderDecisionForm(requirementId, testCaseId)}`;
  }

  return forTestCase
    .map((recommendation) =>
      renderDecisionForm(requirementId, testCaseId, recommendation)
    )
    .join("");
}

function renderDecisionForm(
  requirementId: string,
  testCaseId: string,
  recommendation?: ScopeRecommendation
): string {
  const reviewerNote = recommendation
    ? `<p class="meta">Reviewer proposed ${escapeHtml(recommendation.proposedAction)} for ${escapeHtml(recommendation.target)}. That is not applied until you submit a human QA decision.</p>
        <p>${escapeHtml(recommendation.rationale)}</p>`
    : "";

  return `<form method="POST" action="/api/decision">
      <input type="hidden" name="requirementId" value="${escapeHtml(requirementId)}">
      <input type="hidden" name="testCaseId" value="${escapeHtml(testCaseId)}">
      <input type="hidden" name="proposedAction" value="${escapeHtml(recommendation?.proposedAction ?? "")}">
      <input type="hidden" name="reason" value="${escapeHtml(recommendation?.rationale ?? "")}">
      <dl>
        <dt>Recommendation</dt><dd>${recommendation ? "Reviewer scope recommendation" : "None — human-initiated"}</dd>
        <dt>Requirement ID</dt><dd>${escapeHtml(requirementId)}</dd>
        <dt>Test Case ID</dt><dd>${escapeHtml(testCaseId)}</dd>
        <dt>Proposed action</dt><dd>${escapeHtml(recommendation?.proposedAction ?? "—")}</dd>
      </dl>
      ${reviewerNote}
      <label>Target
        <input type="text" name="target" required value="${escapeHtml(recommendation?.target ?? "")}" placeholder="Hostname or URL for this test case">
      </label>
      <p>Human QA decision:</p>
      <label><input type="radio" name="humanDecision" value="KEEP_IN_SCOPE" required> KEEP IN SCOPE</label>
      <label><input type="radio" name="humanDecision" value="EXCLUDE"> EXCLUDE</label>
      <label><input type="radio" name="humanDecision" value="NEED_MORE_INVESTIGATION"> NEED MORE INVESTIGATION</label>
      <label>QA rationale
        <textarea name="qaRationale" required placeholder="Explain the human QA decision"></textarea>
      </label>
      <p><button type="submit">Submit Decision</button></p>
    </form>`;
}

function renderAppliedDecisions(
  feedback: QaFeedback | undefined,
  requirementId: string,
  testCaseId: string
): string {
  const decisions = (feedback?.decisions ?? []).filter(
    (item) =>
      item.requirementId === requirementId && item.testCaseId === testCaseId
  );

  if (decisions.length === 0) {
    return `<p class="empty">No human QA decision has been submitted for ${escapeHtml(requirementId)} / ${escapeHtml(testCaseId)}.</p>`;
  }

  return decisions
    .map(
      (decision) => `<article class="finding">
        <dl>
          <dt>Requirement ID</dt><dd>${escapeHtml(decision.requirementId)}</dd>
          <dt>Test Case ID</dt><dd>${escapeHtml(decision.testCaseId)}</dd>
          <dt>Target</dt><dd>${escapeHtml(decision.target)}</dd>
          <dt>Human QA decision</dt><dd>${escapeHtml(decision.humanDecision)}</dd>
          <dt>Action</dt><dd>${escapeHtml(decision.action)}</dd>
          <dt>approvedByQA</dt><dd>${decision.approvedByQA ? "true" : "false"}</dd>
          <dt>QA rationale</dt><dd>${escapeHtml(decision.qaRationale)}</dd>
          <dt>Timestamp</dt><dd>${escapeHtml(decision.timestamp)}</dd>
        </dl>
      </article>`
    )
    .join("");
}

function getScopeRecommendations(review: QaReviewResult): ScopeRecommendation[] {
  const extra = review as QaReviewResult & {
    scopeRecommendations?: unknown;
  };

  if (!Array.isArray(extra.scopeRecommendations)) {
    return [];
  }

  const fallbackTestCaseId = review.functionalTestCases[0]?.id ?? "TC-001";

  return extra.scopeRecommendations.flatMap((item) => {
    const recommendation = readScopeRecommendation(item, fallbackTestCaseId);
    return recommendation ? [recommendation] : [];
  });
}

function readScopeRecommendation(
  value: unknown,
  fallbackTestCaseId: string
): ScopeRecommendation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const target = typeof record.target === "string" ? record.target.trim() : "";
  const rationale =
    typeof record.rationale === "string"
      ? record.rationale.trim()
      : typeof record.reason === "string"
        ? record.reason.trim()
        : "";
  const testCaseId =
    typeof record.testCaseId === "string" && record.testCaseId.trim()
      ? record.testCaseId.trim()
      : fallbackTestCaseId;
  const proposedAction = record.proposedAction ?? record.action;

  if (!target || !rationale || proposedAction !== "EXCLUDE") {
    return undefined;
  }

  return {
    testCaseId,
    target,
    proposedAction: "EXCLUDE",
    rationale,
  };
}

async function saveDecision(body: string): Promise<void> {
  const params = new URLSearchParams(body);
  const review = await loadReview();

  const requirementId = params.get("requirementId")?.trim() || review.requirementId;
  const testCaseId = params.get("testCaseId")?.trim() ?? "";
  const target = params.get("target")?.trim() ?? "";
  const proposedAction = params.get("proposedAction")?.trim() ?? "";
  const reason = params.get("reason")?.trim() ?? "";
  const qaRationale = params.get("qaRationale")?.trim() ?? "";
  const humanDecision = params.get("humanDecision");

  if (!isHumanDecision(humanDecision)) {
    throw new Error(
      "A human QA must explicitly choose KEEP IN SCOPE, EXCLUDE, or NEED MORE INVESTIGATION."
    );
  }
  if (!testCaseId) {
    throw new Error("A testCaseId is required.");
  }
  if (!target) {
    throw new Error("A target is required.");
  }
  if (!qaRationale) {
    throw new Error("A QA rationale is required.");
  }

  const existing = (await loadFeedback()) ?? {
    requirementId,
    reviewId: REVIEW_ID,
    decisions: [],
  };

  const nextDecision: HumanQaDecision = {
    type: "SCOPE_REFINEMENT",
    requirementId,
    testCaseId,
    target,
    action: humanDecision,
    proposedAction:
      proposedAction === "EXCLUDE" ? "EXCLUDE" : humanDecision,
    humanDecision,
    decision: humanDecision === "EXCLUDE" ? "APPROVED" : humanDecision,
    approvedByQA: humanDecision === "EXCLUDE",
    reason: reason || qaRationale,
    qaRationale,
    timestamp: new Date().toISOString(),
    source: "human_qa",
  };

  const decisions = existing.decisions.filter(
    (item) =>
      !(
        item.type === "SCOPE_REFINEMENT" &&
        item.requirementId === requirementId &&
        item.testCaseId === testCaseId &&
        item.target === target
      )
  );
  decisions.push(nextDecision);

  const feedback: QaFeedback = {
    requirementId,
    reviewId: REVIEW_ID,
    decisions,
  };

  await mkdir(path.dirname(FEEDBACK_PATH), { recursive: true });
  await writeFile(FEEDBACK_PATH, JSON.stringify(feedback, null, 2), "utf8");
}

function isHumanDecision(value: string | null): value is HumanDecisionValue {
  return (
    value === "KEEP_IN_SCOPE" ||
    value === "EXCLUDE" ||
    value === "NEED_MORE_INVESTIGATION"
  );
}

async function loadReview(): Promise<QaReviewResult> {
  const raw = await readFile(REVIEW_PATH, "utf8");
  return JSON.parse(raw) as QaReviewResult;
}

async function loadFeedback(): Promise<QaFeedback | undefined> {
  try {
    const raw = await readFile(FEEDBACK_PATH, "utf8");
    const parsed = JSON.parse(raw) as QaFeedback;
    if (!parsed || !Array.isArray(parsed.decisions)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function statusBadge(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "PASS" || normalized === "PASSED" || normalized === "APPROVED") {
    return `<span class="badge badge-pass">✓ ${escapeHtml(normalized === "PASSED" ? "PASS" : normalized === "APPROVED" ? "APPROVED" : "PASS")}</span>`;
  }
  if (normalized === "FAIL" || normalized === "FAILED" || normalized === "REJECTED") {
    const label =
      normalized === "FAILED" ? "FAILED" : normalized === "REJECTED" ? "REJECTED" : "FAIL";
    return `<span class="badge badge-fail">✕ ${escapeHtml(label)}</span>`;
  }
  if (normalized === "COMPLETE") {
    return `<span class="badge badge-neutral">${escapeHtml(normalized)}</span>`;
  }
  return `<span class="badge badge-inconclusive">? ${escapeHtml(normalized)}</span>`;
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

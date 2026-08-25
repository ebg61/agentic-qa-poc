import { readFile } from "node:fs/promises";

export interface ApprovedExcludeRule {
  target: string;
  action: "EXCLUDE";
  source: "human_qa";
  requirementId?: string;
  testCaseId?: string;
}

export interface ScopeApplication {
  discovered: string[];
  excluded: string[];
  applicable: string[];
  approvedRules: ApprovedExcludeRule[];
}

export interface ScopeEvidence {
  discovered: number;
  excluded: number;
  applicable: number;
  approvedRules: ApprovedExcludeRule[];
  excludedUrls: string[];
}

export interface DiscoveryEvidence {
  initialCount: number;
  afterStabilizationCount: number;
  finalDeduplicatedCount: number;
  applicableCount: number;
  checkedCount: number;
  scrollPasses?: number;
  stabilized?: boolean;
}

/**
 * Load human-approved EXCLUDE rules from a QA feedback artifact.
 *
 * Missing files, rejected decisions, and unapproved decisions have no effect.
 * Reviewer findings are never treated as exclusions.
 */
export async function loadApprovedExcludeRules(
  feedbackPath: string,
  testCaseId?: string,
  requirementId?: string
): Promise<ApprovedExcludeRule[]> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(feedbackPath, "utf8"));
  } catch {
    return [];
  }

  return selectApprovedExcludeRules(
    parsed,
    testCaseId ?? process.env.FUNCTIONAL_TEST_CASE_ID,
    requirementId
  );
}

export function selectApprovedExcludeRules(
  feedback: unknown,
  testCaseId?: string,
  requirementId?: string
): ApprovedExcludeRule[] {
  if (!feedback || typeof feedback !== "object") {
    return [];
  }

  const currentTestCaseId = testCaseId?.trim();
  if (!currentTestCaseId) {
    return [];
  }

  const decisions = (feedback as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) {
    return [];
  }

  const rules: ApprovedExcludeRule[] = [];

  for (const decision of decisions) {
    if (
      !isApprovedExcludeDecision(
        decision,
        currentTestCaseId,
        requirementId?.trim()
      )
    ) {
      continue;
    }

    rules.push({
      target: decision.target.trim(),
      action: "EXCLUDE",
      source: "human_qa",
      requirementId:
        typeof decision.requirementId === "string"
          ? decision.requirementId.trim()
          : requirementId?.trim(),
      testCaseId: currentTestCaseId,
    });
  }

  return rules;
}

export function applyApprovedScope(
  urls: string[],
  rules: ApprovedExcludeRule[]
): ScopeApplication {
  if (rules.length === 0) {
    return {
      discovered: [...urls],
      excluded: [],
      applicable: [...urls],
      approvedRules: [],
    };
  }

  const excluded: string[] = [];
  const applicable: string[] = [];

  for (const url of urls) {
    if (isExcludedByApprovedRules(url, rules)) {
      excluded.push(url);
    } else {
      applicable.push(url);
    }
  }

  return {
    discovered: [...urls],
    excluded,
    applicable,
    approvedRules: rules,
  };
}

export function toScopeEvidence(scope: ScopeApplication): ScopeEvidence {
  return {
    discovered: scope.discovered.length,
    excluded: scope.excluded.length,
    applicable: scope.applicable.length,
    approvedRules: scope.approvedRules,
    excludedUrls: scope.excluded,
  };
}

export function isExcludedByApprovedRules(
  url: string,
  rules: ApprovedExcludeRule[]
): boolean {
  return rules.some((rule) => urlMatchesExcludeTarget(url, rule.target));
}

export function urlMatchesExcludeTarget(url: string, target: string): boolean {
  const hostname = hostnameFromUrl(url);
  const domain = normalizeDomainTarget(target);
  if (!hostname || !domain) {
    return false;
  }
  return hostnameMatchesDomain(hostname, domain);
}

export function hostnameMatchesDomain(
  hostname: string,
  domain: string
): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  const target = domain.replace(/\.$/, "").toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

function hostnameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeDomainTarget(target: string): string | undefined {
  const trimmed = target.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  try {
    if (trimmed.includes("://")) {
      return new URL(trimmed).hostname.replace(/^www\./, "");
    }
  } catch {
    return undefined;
  }

  return trimmed.replace(/^www\./, "").replace(/^\./, "");
}

function isApprovedExcludeDecision(
  value: unknown,
  testCaseId: string,
  requirementId?: string
): value is {
  type: "SCOPE_REFINEMENT";
  action: "EXCLUDE";
  target: string;
  testCaseId: string;
  requirementId?: string;
  approvedByQA: true;
  decision: "APPROVED";
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const decision = value as Record<string, unknown>;
  const decisionTestCaseId =
    typeof decision.testCaseId === "string" ? decision.testCaseId.trim() : "";
  const decisionRequirementId =
    typeof decision.requirementId === "string"
      ? decision.requirementId.trim()
      : "";

  if (
    decision.type !== "SCOPE_REFINEMENT" ||
    decision.action !== "EXCLUDE" ||
    decision.approvedByQA !== true ||
    decision.decision !== "APPROVED" ||
    decisionTestCaseId !== testCaseId ||
    typeof decision.target !== "string" ||
    decision.target.trim().length === 0
  ) {
    return false;
  }

  if (!requirementId) {
    return true;
  }

  return decisionRequirementId === requirementId;
}

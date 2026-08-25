/**
 * Interpret Analyst Test Case intent for Playwright generation.
 *
 * The complete Test Case determines WHAT to automate.
 * Product context and helpers determine HOW, and must not expand scope.
 *
 * Individual words such as search, find, deal, result, or link are clues,
 * not commands. Every Test Case is classified independently.
 */

import type { AnalystTestCase } from "./analysis.js";

export interface TestCaseIntent {
  search: boolean;
  firstDeal: boolean;
  linkCollection: boolean;
}

export function analyzeTestCaseIntent(testCase: AnalystTestCase): TestCaseIntent {
  const search = requiresExplicitSearch(testCase);
  const firstDeal = requiresVisibleDealVerification(testCase);
  const linkCollection = requiresLinkValidation(testCase);

  return { search, firstDeal, linkCollection };
}

export function describeRequiredJourney(intent: TestCaseIntent): string {
  return [
    "Required user journey for THIS Test Case only.",
    "Derived from the complete Test Case. Not from product features, helpers, or previous tests.",
    `- Explicit search interaction: ${intent.search ? "yes" : "no"}`,
    `- Visible deal/result verification: ${intent.firstDeal ? "yes" : "no"}`,
    `- Link collection/validation: ${intent.linkCollection ? "yes" : "no"}`,
    "Generate only the journeys marked yes. Do not add a journey marked no.",
    "Words such as search, find, locate, result, deal, link, or homepage are not commands by themselves.",
  ].join("\n");
}

export function testCaseSourceText(testCase: AnalystTestCase): string {
  return collectFields(testCase).join("\n");
}

export function extractSearchQuery(testCase: AnalystTestCase): string | undefined {
  const preferred = [
    ...(testCase.steps ?? []),
    ...optionalNarrativeList(testCase),
    testCase.objective,
    testCase.title,
    testCase.expectedResult,
    ...(testCase.preconditions ?? []),
  ];
  const quotedPatterns = [
    /search(?:es|ed|ing)?(?:\s+\w+){0,6}\s+['"]([^'"]+)['"]/i,
    /['"]([^'"]+)['"]\s+into (?:the )?(?:site(?:'s)? )?(?:primary )?search/i,
    /search (?:term|query)\s+['"]([^'"]+)['"]/i,
    /enter(?:s|ed)?\s+['"]([^'"]+)['"]\s+into\b/i,
    /type(?:s|d)?\s+['"]([^'"]+)['"]\s+into\b/i,
  ];

  for (const field of preferred) {
    if (!field) {
      continue;
    }
    for (const pattern of quotedPatterns) {
      const match = field.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
  }

  for (const field of preferred) {
    if (!field) {
      continue;
    }
    if (/\bsearch\s+the\s+page\s+for\b/i.test(field)) {
      continue;
    }
    const match = field.match(
      /\bsearch(?:es|ed|ing)?\s+for\s+([A-Za-z][A-Za-z0-9'-]{0,40})\b/i
    );
    if (match?.[1]?.trim() && !/^(the|a|an|from|this)$/i.test(match[1])) {
      return match[1].trim();
    }
  }

  return undefined;
}

function requiresExplicitSearch(testCase: AnalystTestCase): boolean {
  const actions = actionText(testCase);
  if (hasObservationalOnlySearch(actions) && !hasSearchAction(actions)) {
    return false;
  }
  if (hasSearchAction(actions)) {
    return true;
  }

  const expected = (testCase.expectedResult ?? "").toLowerCase();
  if (hasSearchAction(expected) && hasSearchAction(testCase.objective ?? "")) {
    return true;
  }

  return false;
}

function requiresVisibleDealVerification(testCase: AnalystTestCase): boolean {
  const actions = actionText(testCase);
  const proof = proofText(testCase);

  if (isDealsNavigationOnly(actions) && !verifiesDealItem(proof)) {
    return false;
  }
  if (verifiesDealItem(actions) || verifiesDealItem(proof)) {
    return true;
  }
  return false;
}

function requiresLinkValidation(testCase: AnalystTestCase): boolean {
  const proof = proofText(testCase);
  if (!hasLinkCollectionLanguage(proof)) {
    return false;
  }
  if (requiresExplicitSearch(testCase) && !hasLinkCollectionLanguage(actionText(testCase))) {
    return false;
  }
  return true;
}

function hasSearchAction(text: string): boolean {
  const value = text.toLowerCase();
  if (!value.trim()) {
    return false;
  }
  if (/\bsearch\s+the\s+page\s+for\b/.test(value)) {
    return false;
  }

  return (
    /\bsearch(?:es|ed)?\s+for\b/.test(value) ||
    /\b(?:perform|submit|run|execute)\s+(?:a\s+|an\s+|the\s+)?search\b/.test(value) ||
    /\buse\s+(?:the\s+)?(?:site(?:'s)?\s+)?(?:primary\s+)?search(?:\s+(?:field|input|box|bar|control))?\b/.test(
      value
    ) ||
    /\b(?:enter|type|input|fill|paste)\b[\s\S]{0,80}\bsearch(?:\s+(?:field|input|box|bar|control|query|term)|box)?\b/.test(
      value
    ) ||
    /\bsearch\s+(?:field|input|box|bar|control|query|term)\b[\s\S]{0,80}\b(?:enter|type|input|fill|submit|use)\b/.test(
      value
    ) ||
    /\benter\s+(?:the\s+)?(?:search\s+)?(?:query|term)\b/.test(value) ||
    /\bsubmit\s+(?:the\s+)?search\b/.test(value) ||
    /\bsearch\s+(?:function(?:ality)?|feature)\s+(?:works|functions|succeeds)\b/.test(value)
  );
}

function hasObservationalOnlySearch(text: string): boolean {
  const value = text.toLowerCase();
  if (!/\bsearch\b/.test(value)) {
    return false;
  }
  return (
    /\bsearch(?:\s+(?:field|input|box|bar|control|feature|functionality))?\s+(?:is|are|remains?|stay|stays)\s+(?:visible|present|displayed|shown|available)\b/.test(
      value
    ) ||
    /\b(?:visible|present|displayed|shown|available)\b[\s\S]{0,40}\bsearch\b/.test(value)
  );
}

function verifiesDealItem(text: string): boolean {
  const value = text.toLowerCase();
  if (!value.trim()) {
    return false;
  }
  return (
    /\bfirst\s+(?:visible\s+|displayed\s+|initially\s+displayed\s+)?(?:deal|result)\b/.test(
      value
    ) ||
    /\b(?:deal|result)\s+(?:title|card|item)\b/.test(value) ||
    /\b(?:read|check|verify|inspect|observe|confirm|assert|identify)\b[\s\S]{0,80}\b(?:visible\s+|displayed\s+)?(?:deal|result)(?:\s+title|\s+card|\s+item)?\b/.test(
      value
    )
  );
}

function isDealsNavigationOnly(text: string): boolean {
  const value = text.toLowerCase();
  const nav = /\b(?:click|open|activate|select)\b[\s\S]{0,40}\bdeals?\s+link\b/.test(
    value
  );
  return nav && !verifiesDealItem(value);
}

function hasLinkCollectionLanguage(text: string): boolean {
  const value = text.toLowerCase();
  if (!value.trim()) {
    return false;
  }
  return (
    /\blink collection\b/.test(value) ||
    /\bnavigable links\b/.test(value) ||
    /\bcustomer-facing links\b/.test(value) ||
    /\b(?:all|every|each|applicable)\b[\s\S]{0,50}\blinks?\b/.test(value) ||
    /\blinks?\s+(?:lead|leads|go|goes|navigate|navigates)\s+to\b/.test(value) ||
    /\b(?:validate|verify|check|exercise|test)\b[\s\S]{0,40}\b(?:all\s+)?(?:the\s+)?(?:homepage\s+|customer-facing\s+)?links\b/.test(
      value
    )
  );
}

function actionText(testCase: AnalystTestCase): string {
  return [
    ...(testCase.steps ?? []),
    ...optionalNarrativeList(testCase),
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

function proofText(testCase: AnalystTestCase): string {
  return [
    ...(testCase.steps ?? []),
    testCase.expectedResult,
    testCase.objective,
    ...optionalNarrativeList(testCase),
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

function collectFields(testCase: AnalystTestCase): string[] {
  return [
    testCase.title,
    testCase.objective,
    testCase.expectedResult,
    ...(testCase.preconditions ?? []),
    ...(testCase.steps ?? []),
    ...optionalNarrativeList(testCase),
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function optionalNarrativeList(testCase: AnalystTestCase): string[] {
  const record = testCase as AnalystTestCase & Record<string, unknown>;
  const values: string[] = [];
  for (const key of [
    "description",
    "testData",
    "test_data",
    "acceptanceCriteria",
    "acceptance_criteria",
    "expectedResults",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      values.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) {
          values.push(item);
        }
      }
    }
  }
  return values;
}

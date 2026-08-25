/**
 * Test Case-derived validations for generated Playwright specs.
 *
 * Expected values come only from the Analyst Test Case. This module does
 * not hard-code User Story ids, deal titles, or URLs.
 */

import type { AnalystTestCase } from "./analysis.js";
import { extractHttpUrl } from "./app-url.js";
import {
  analyzeTestCaseIntent,
  extractSearchQuery,
  testCaseSourceText,
} from "./intent.js";

export type RequiredValidation =
  | { type: "firstVisibleDealTitle"; expected: string }
  | { type: "visibleDealTitle"; expected: string }
  | { type: "visibleText"; expected: string }
  | { type: "linkDestinationsUsable"; expectedCount?: number }
  | { type: "pageHost"; host: string }
  | { type: "recognizableContent"; tokens: string[] }
  | { type: "pageNotBlank" };

export function requiredValidations(
  testCase: AnalystTestCase
): RequiredValidation[] {
  const intent = analyzeTestCaseIntent(testCase);
  const text = testCaseSourceText(testCase);
  const validations: RequiredValidation[] = [];
  const query = extractSearchQuery(testCase)?.trim();
  const quoted = quotedValues(text).filter((value) =>
    isExpectedEntityValue(value, query)
  );

  const firstScoped = isFirstDisplayedScope(text);
  const appearsInResults = mentionsAppearingInResults(text);
  const expectedTitle = selectExpectedTitle(quoted, text);

  if (expectedTitle && firstScoped) {
    validations.push({ type: "firstVisibleDealTitle", expected: expectedTitle });
  } else if (expectedTitle && (appearsInResults || intent.firstDeal)) {
    validations.push({ type: "visibleDealTitle", expected: expectedTitle });
  } else if (
    expectedTitle &&
    mentionsVisibleExpectedContent(text) &&
    !intent.firstDeal
  ) {
    validations.push({ type: "visibleText", expected: expectedTitle });
  }

  if (intent.linkCollection && mentionsUsableDestination(text)) {
    validations.push({
      type: "linkDestinationsUsable",
      expectedCount: extractCollectionSize(text),
    });
  }

  const host = expectedHost(text);
  if (host && mentionsUrlOrDomain(text)) {
    validations.push({ type: "pageHost", host });
  }

  if (mentionsRecognizableContent(text)) {
    const tokens = brandTokens(text, host);
    if (tokens.length > 0) {
      validations.push({ type: "recognizableContent", tokens });
    }
  }

  if (validations.length === 0) {
    validations.push({ type: "pageNotBlank" });
  }

  return validations;
}

export function observedMatchesExpected(
  observed: string | undefined | null,
  expected: string
): boolean {
  return normalizeVisibleText(observed) === normalizeVisibleText(expected);
}

export function assertObservedMatchesExpected(
  observed: string | undefined | null,
  expected: string,
  label: string
): void {
  if (!observedMatchesExpected(observed, expected)) {
    throw new Error(
      `${label}: observed ${JSON.stringify(observed ?? "")} did not match expected ${JSON.stringify(expected)}`
    );
  }
}

export function firstDisplayedMatchesExpected(
  deals: Array<{ title?: string; text?: string }>,
  expected: string
): boolean {
  const first = deals[0];
  return observedMatchesExpected(first?.title ?? first?.text, expected);
}

export function visibleResultsIncludeTitle(
  deals: Array<{ title?: string; text?: string }>,
  expected: string
): boolean {
  return deals.some((deal) =>
    observedMatchesExpected(deal.title ?? deal.text, expected)
  );
}

export function assertVisibleResultsIncludeTitle(
  deals: Array<{ title?: string; text?: string }>,
  expected: string
): void {
  if (!visibleResultsIncludeTitle(deals, expected)) {
    const observed = deals
      .map((deal) => deal.title ?? deal.text ?? "")
      .filter(Boolean);
    throw new Error(
      `Expected result ${JSON.stringify(expected)} was not present in the displayed results. Observed: ${JSON.stringify(observed)}`
    );
  }
}

export function destinationHasMeaningfulContent(observation: {
  pageOpen?: boolean;
  bodyLength?: number;
  bodyText?: string;
}): boolean {
  if (observation.pageOpen === false) {
    return false;
  }
  const length =
    observation.bodyLength ?? observation.bodyText?.trim().length ?? 0;
  return length >= 40;
}

export function hostMatchesExpected(url: string, host: string): boolean {
  const expected = host.replace(/^www\./i, "").toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase().includes(expected);
  } catch {
    return url.toLowerCase().includes(expected);
  }
}

export function assertHostMatchesExpected(url: string, host: string): void {
  if (!hostMatchesExpected(url, host)) {
    throw new Error(
      `Observed URL ${JSON.stringify(url)} was not on expected host ${JSON.stringify(host)}`
    );
  }
}

export function pageShowsRecognizableContent(
  bodyText: string,
  tokens: string[]
): boolean {
  const haystack = bodyText.toLowerCase();
  return tokens.some((token) => haystack.includes(token.toLowerCase()));
}

export function assertRecognizableContent(
  bodyText: string,
  tokens: string[]
): void {
  if (!pageShowsRecognizableContent(bodyText, tokens)) {
    throw new Error(
      `Page did not show recognizable content from the Test Case (${tokens.join(", ")})`
    );
  }
}

export function assertPageNotBlank(bodyText: string): void {
  if (bodyText.trim().length < 40) {
    throw new Error("Page did not display visible content required by the Test Case");
  }
}

export function pageShowsExpectedText(
  bodyText: string,
  expected: string
): boolean {
  return normalizeVisibleText(bodyText)
    .toLowerCase()
    .includes(normalizeVisibleText(expected).toLowerCase());
}

export function assertVisibleText(bodyText: string, expected: string): void {
  if (!pageShowsExpectedText(bodyText, expected)) {
    throw new Error(
      `Expected visible content ${JSON.stringify(expected)} was not present on the page`
    );
  }
}

function quotedValues(text: string): string[] {
  const found: string[] = [];
  const pattern = /['"]([^'"]{2,160})['"]/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const value = match[1]?.trim();
    if (value) {
      found.push(value);
    }
    match = pattern.exec(text);
  }
  return [...new Set(found)];
}

function isExpectedEntityValue(value: string, query?: string): boolean {
  if (query && value.toLowerCase() === query.toLowerCase()) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    return false;
  }
  if (
    /^(pass|fail|inconclusive|pass-with-auth|auth_required|search)$/i.test(value)
  ) {
    return false;
  }
  return value.length >= 3;
}

function isFirstDisplayedScope(text: string): boolean {
  return (
    /\bfirst\s+(?:visible|displayed|initially[-\s]?displayed)\s+(?:deal|result)\b/i.test(
      text
    ) ||
    /\bfirst deal (?:visible|displayed|shown)\b/i.test(text) ||
    (/\bexact title\b/i.test(text) && /\bfirst\b/i.test(text))
  );
}

function mentionsAppearingInResults(text: string): boolean {
  return (
    /\bappears?\b[\s\S]{0,60}\b(?:search\s+)?results?\b/i.test(text) ||
    /\b(?:in|among)\s+(?:the\s+)?(?:search\s+)?results\b/i.test(text)
  );
}

function selectExpectedTitle(quoted: string[], text: string): string | undefined {
  const exact = extractExactTitlePhrase(text);
  if (exact) {
    return exact;
  }
  const nearTitle = quoted.find((value) => {
    const escaped = escapeRegExp(value);
    return new RegExp(
      `(?:title|deal|result|heading|content)[\\s\\S]{0,48}${escaped}|${escaped}[\\s\\S]{0,48}(?:title|deal|result|heading|content)`,
      "i"
    ).test(text);
  });
  return nearTitle ?? quoted[0];
}

function extractExactTitlePhrase(text: string): string | undefined {
  const quoted = text.match(/\bexact title[:\s]+['"]([^'"]+)['"]/i);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim();
  }
  const unquoted = text.match(/\bexact title[:\s]+([^.\n]+)/i);
  const value = unquoted?.[1]?.replace(/^['"]|['"]$/g, "").trim();
  return value || undefined;
}

function mentionsVisibleExpectedContent(text: string): boolean {
  return /\b(visible|shown|displayed|presents?|sees?|observe)\b/i.test(text);
}

function mentionsUsableDestination(text: string): boolean {
  return /\b(usable|meaningful|broken|unusable|destination)\b/i.test(text);
}

function extractCollectionSize(text: string): number | undefined {
  const match = text.match(/\b(?:first|exactly)\s+(\d+)\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

function expectedHost(text: string): string | undefined {
  const url = extractHttpUrl(text);
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      return undefined;
    }
  }
  const domain = text.match(
    /\b(?:domain|address bar|url)\b[\s\S]{0,40}\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i
  );
  return domain?.[1]?.replace(/^www\./i, "");
}

function mentionsUrlOrDomain(text: string): boolean {
  return /\b(domain|address bar|url|redirect|hostname|host)\b/i.test(text);
}

function mentionsRecognizableContent(text: string): boolean {
  return (
    /\brecognizable\b/i.test(text) ||
    /\bbrand(?:ed|ing)\b/i.test(text) ||
    /\blogo\b/i.test(text)
  );
}

function brandTokens(text: string, host?: string): string[] {
  const tokens = new Set<string>();
  const patterns = [
    /\brecognizable\s+([A-Z][A-Za-z0-9]+)/g,
    /\b([A-Z][A-Za-z0-9]+)-branded\b/g,
    /\b([A-Z][A-Za-z0-9]+)\s+logo\b/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match) {
      const token = match[1]?.trim();
      if (token && token.length > 2 && !/^(The|And|For|With)$/i.test(token)) {
        tokens.add(token);
      }
      match = pattern.exec(text);
    }
  }
  if (host) {
    const label = host.split(".")[0];
    if (label && label.length > 2) {
      tokens.add(label);
    }
  }
  return [...tokens];
}

function normalizeVisibleText(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

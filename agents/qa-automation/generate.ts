/**
 * Generate a Playwright spec from a QA Analyst functional test case.
 *
 * The spec is derived from structured TestCase fields. This module does
 * not hardcode product-specific behavior for any test case id.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmClient, type LlmClient } from "../qa-analyst/llm-client.js";
import { parseJsonObject } from "../qa-analyst/validate.js";
import type { AnalystTestCase } from "./analysis.js";
import { extractHttpUrl } from "./app-url.js";
import {
  analyzeTestCaseIntent,
  describeRequiredJourney,
  extractSearchQuery,
  testCaseSourceText,
  type TestCaseIntent,
} from "./intent.js";
import { PRODUCT_CONTEXT } from "./product-context.js";
import {
  requiredValidations,
  type RequiredValidation,
} from "./validation.js";

export {
  analyzeTestCaseIntent,
  extractSearchQuery,
  type TestCaseIntent,
} from "./intent.js";

const agentDir = path.dirname(fileURLToPath(import.meta.url));

/** Bounded generate → validate → regenerate attempts. Not an infinite loop. */
export const MAX_GENERATION_ATTEMPTS = 3;

export interface GenerateSpecInput {
  requirementId: string;
  testCase: AnalystTestCase;
  specPath: string;
  evidencePath: string;
  requirementText?: string;
  analysis?: unknown;
  strategy?: unknown;
  llm?: LlmClient;
}

export type GeneratedCandidate =
  | { ok: true; spec: string }
  | { ok: false; problem: string; spec?: string };

export async function generatePlaywrightSpec(
  input: GenerateSpecInput
): Promise<void> {
  const llm = input.llm ?? createLlmClient();
  const instructions = await readInstructions();
  const testCaseUrl = extractHttpUrl(testCaseSourceText(input.testCase));
  const systemPrompt = `${instructions}\n${PRODUCT_CONTEXT}\n${generationContract(input.requirementId, input.testCase.id, input.evidencePath, testCaseUrl)}`;
  const basePrompt = buildGenerationPrompt(input, testCaseUrl);

  let lastProblem: string | undefined;
  let lastSpec: string | undefined;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const userPrompt =
      attempt === 1
        ? basePrompt
        : buildRecoveryPrompt(basePrompt, lastProblem ?? "validation failed", lastSpec);

    let raw: string;
    try {
      raw = await llm.completeJson(systemPrompt, userPrompt);
    } catch (error: unknown) {
      lastProblem = errorMessage(error);
      lastSpec = undefined;
      if (attempt >= MAX_GENERATION_ATTEMPTS) {
        break;
      }
      continue;
    }

    const candidate = evaluateGeneratedCandidate(raw, {
      requirementId: input.requirementId,
      testCase: input.testCase,
      testCaseUrl,
    });

    if (candidate.ok) {
      await mkdir(path.dirname(input.specPath), { recursive: true });
      await writeFile(input.specPath, candidate.spec, "utf8");
      return;
    }

    lastProblem = candidate.problem;
    lastSpec = candidate.spec;
    if (attempt < MAX_GENERATION_ATTEMPTS) {
      console.log(
        `[QA Automation] Generation attempt ${attempt}/${MAX_GENERATION_ATTEMPTS} failed validation; recovering.`
      );
    }
  }

  throw new Error(
    `Generated Playwright spec is invalid after ${MAX_GENERATION_ATTEMPTS} generation attempts: ${lastProblem ?? "validation failed"}`
  );
}

export function evaluateGeneratedCandidate(
  rawLlmJson: string,
  input: {
    requirementId: string;
    testCase: AnalystTestCase;
    testCaseUrl?: string;
  }
): GeneratedCandidate {
  let extracted: string;
  try {
    extracted = extractSource(parseJsonObject(rawLlmJson));
  } catch (error: unknown) {
    return { ok: false, problem: errorMessage(error) };
  }

  let spec: string;
  try {
    spec = withIdentityHeader(
      normalizeGeneratedSource(extracted, {
        testCaseUrl: input.testCaseUrl,
        testCase: input.testCase,
      }),
      input.requirementId,
      input.testCase.id
    );
  } catch (error: unknown) {
    return { ok: false, problem: errorMessage(error), spec: extracted };
  }

  try {
    assertGeneratedSourceExecutable(
      spec,
      analyzeTestCaseIntent(input.testCase),
      input.testCase
    );
  } catch (error: unknown) {
    return { ok: false, problem: errorMessage(error), spec };
  }

  return { ok: true, spec };
}

function buildRecoveryPrompt(
  originalPrompt: string,
  problem: string,
  previousSource: string | undefined
): string {
  return [
    originalPrompt,
    "",
    "The previous generation attempt failed validation. Produce a complete corrected Playwright spec for the SAME Test Case.",
    "Do not remove, weaken, or bypass required Test Case validations to make the source compile or parse.",
    "Keep every Test Case-derived validation. Fix the generation defect. Do not replace a specific expected result with a generic exists/loaded check.",
    "",
    "Validation problem from the previous attempt:",
    problem,
    "",
    "Previous generated source:",
    previousSource?.trim() ? previousSource : "(no source was produced)",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readInstructions(): Promise<string> {
  return readFile(path.join(agentDir, "instructions.md"), "utf8");
}

function buildGenerationPrompt(
  input: GenerateSpecInput,
  testCaseUrl?: string
): string {
  const testCase = input.testCase;

  return [
    `Requirement ID: ${input.requirementId}`,
    `Test case ID: ${testCase.id}`,
    `Spec output path: ${input.specPath}`,
    `Evidence output path: ${input.evidencePath}`,
    "",
    "Generate Playwright automation for this functional test case only.",
    "The Analyst Test Case is the source of truth. Automate that Test Case.",
    "Read the complete Test Case before generating: title, objective, description, preconditions, test data, steps, expected result, and any other explicit instructions.",
    "Determine the actual user journey required to prove THIS Test Case. Analyze it independently of previous Test Cases.",
    "Product context describes how the application behaves. It must not expand the functional scope of this Test Case.",
    "Words such as search, find, locate, look for, result, deal, link, homepage, click, or open are clues, not commands. Do not infer a journey from vocabulary alone.",
    "Generate the smallest reliable UI journey that can establish whether the Test Case passes or fails.",
    describeRequiredJourney(analyzeTestCaseIntent(testCase)),
    "Do not reinterpret the requirement into a different or broader test.",
    "Do not invent additional functionality, destinations, or checks that are not in the Test Case.",
    "Do not generate automation for any other test case.",
    "Do not copy or reuse tests/US-001/TC-001.spec.ts or any other existing spec.",
    "This repository is an ES module. Never use require(). Import filesystem helpers from node:fs and node:path.",
    "Do not invent environment variables, URLs, credentials, selectors, ARIA roles, or files that the Test Case and project infrastructure do not already provide.",
    "Navigate with resolveApplicationUrl from ../../agents/qa-automation/app-url.js. Example: await page.goto(APPLICATION_URL) after const APPLICATION_URL = resolveApplicationUrl();",
    "Never read process.env.HOMEPAGE or process.env.BASE_URL in generated source. Never throw if they are unset. resolveApplicationUrl() applies those optional overrides internally.",
    testCaseUrl
      ? `This Test Case includes the URL ${testCaseUrl}. Pass it as resolveApplicationUrl({ testCaseUrl: ${JSON.stringify(testCaseUrl)} }). That Test Case URL takes precedence over HOMEPAGE/BASE_URL. Use HOMEPAGE/BASE_URL only when the Test Case has no URL.`
      : "This Test Case does not include an explicit URL. If it refers to the application homepage, use resolveApplicationUrl() so optional HOMEPAGE/BASE_URL or the Groupon project default homepage is used. Do not invent HOMEPAGE as a mandatory prerequisite.",
    "The application under test is Groupon. Default homepage: https://www.groupon.com/. That is reusable application context, not a reason to add homepage, search, deal, or link checks.",
    "If this Test Case requires an explicit search interaction, implement it with submitSearch (text input + Enter). A Search button is optional and is never the search input. If this Test Case does not require search, do not search.",
    "If this Test Case requires verifying a visible deal/result, use readFirstVisibleDeal for /deals/<slug> cards. Never use a generic heading or the first page link. If the Test Case names a specific expected title/entity, validate that exact value. Do not substitute a generic first-result-exists check. If this Test Case does not require deal verification, do not discover deals.",
    "If this Test Case requires link collection/validation, use listNavigableLinks and recordLinkDestination. If it does not, do not audit links.",
    "Do not use listNavigableLinks unless this Test Case requires link validation. Do not use submitSearch unless this Test Case requires search. Do not use readFirstVisibleDeal unless this Test Case requires deal verification.",
    "Do not invent SEARCH_URL, APP_URL, or similar environment variables. Do not construct a search-result URL. Do not require a CSS selector or ARIA role to exist unless the live UI actually exposes it.",
    "Execute the user's actual actions from the Test Case. Do not replace them with HTTP, API, network, or DOM shortcuts.",
    "Translate each Test Case step into the corresponding user-facing browser interaction. Preserve the step order, scope, and assertions.",
    "When the Test Case requires search, use submitSearch(page, query) from ../../agents/qa-automation/discover.js. Locate the search text input, type the query, and press Enter. A Search button is optional and must not be treated as the search input.",
    "Do not fail search merely because a Search button is missing if Enter submits the query. Only click a search-submit control when the live UI requires it because Enter does not submit.",
    "Do not navigate directly to a search URL.",
    "Do not scroll, paginate, or load additional results unless the Test Case requires it.",
    "When the Test Case scopes validation to the first initially displayed deal/result, inspect only that item with readFirstVisibleDeal(page). Identify actual /deals/<slug> cards in the viewport, then extract the title from that selected card. If the Test Case names the expected first-result title, compare the observed first title to that expected value and FAIL when they differ. Do not use h1-h4 or role=heading as deal discovery. Do not treat the first <a> as a deal. Do not search later results to satisfy a first-displayed expected title.",
    "Do not add exploratory checks, extra destinations, or coverage beyond the Test Case.",
    "Activate links and controls with Playwright locator.click(), never HTMLElement.click() inside page.evaluate().",
    "Locate required controls with findUserFacingControl(page, { kind, names }) from ../../agents/qa-automation/discover.js. Do not assume getByRole, a CSS class, id, placeholder, or test id.",
    "kind: \"search-input\" must resolve to a text-entry control (input/textarea/combobox/searchbox), never a Search button. Do not use location, city, ZIP, address, or other geo/contextual fields as the site search control.",
    "For homepage/link collection, use listNavigableLinks(page), activateNavigableLink(page, locator), and recordLinkDestination from ../../agents/qa-automation/interaction.js.",
    "Skip non-navigating hrefs such as #, javascript:, mailto:, and tel:. Clicking href=\"#\" must not wait for navigation or close the page.",
    "When the Test Case requires destinations to be usable or to display meaningful user-facing content, validate that observed destination content after navigation. FAIL that item when the destination is blank, missing, or has no meaningful visible content. Do not compare href against finalUrl. A redirect or domain/path change is not itself a failure unless the Test Case requires a specific destination.",
    "finalUrl, title, body length/snippet, and navigation kind are evidence. Do not infer an expected destination URL from the href unless the Test Case specifies one.",
    "Do not invent failure categories such as kind FUNCTIONAL or TECHNICAL. Classify PASSED/FAILED only from Test Case validations and whether the journey could be executed.",
    "Never call page.close(), context.close(), or browser.close() on the original page. After a popup, inspect it then closeOpenedPageIfDifferent(original, popup). After same-tab navigation, restorePage(page, originalUrl).",
    "Before page.evaluate, the page must still be open. Helpers skip evaluate when the page is closed. If navigation closes a page, continue on the remaining open page via resolveOpenPage / the activation.page returned by activateNavigableLink.",
    "If the first locator strategy misses, the helper inspects the live UI (accessible name, text, placeholder, name, id, test id) and continues. Do not fail the Test Case solely because one locator strategy failed.",
    "The generated spec MUST include at least one explicit validation derived from the Test Case expected result, steps, or objective. Validate the specific condition the Test Case requires.",
    "PASSED requires the user journey AND every Test Case validation. Navigating, clicking, searching, or finishing Playwright without throwing is not PASSED.",
    "If the Test Case names a particular user-visible outcome, entity, title, result, URL, state, or condition, assert that exact requirement. Do not replace it with a weaker generic check such as page loaded, any result exists, first result exists, or a generic keyword match.",
    "Record observed titles, URLs, visible text, navigation kind, overlay events, and validation results as evidence.",
    "Follow the Analyst Test Case literally. Do not reinterpret the requirement or invent extra checks.",
    "Do not encode an expected PASSED or FAILED product outcome for any requirement or test case id. Compute PASSED/FAILED from the Test Case validations at runtime.",
    "When embedding Test Case title, objective, steps, expectedResult, or any other Test Case text, use JSON.stringify quoting or TEST_CASE_* constants. Never wrap Test Case prose in a single-quoted JavaScript string.",
    "The Automation Agent status may only be PASSED or FAILED. PASSED means the required user journey executed and every Test Case validation succeeded. FAILED means a required validation did not hold, or the journey could not be executed. Never write INCONCLUSIVE. Never write kind FUNCTIONAL or TECHNICAL. The Reviewer reviews this result and makes the final QA decision.",
    "Evidence status PASSED is allowed only after the Test Case validations succeeded. Do not set PASSED because Playwright completed without an exception.",
    "If a required user action cannot be automated or the spec cannot execute, write FAILED with a reason describing what stopped execution and fail the Playwright test.",
    "Continue remaining collection items after one item cannot be inspected, whenever an open page remains.",
    "After every page.goto / navigation, call preparePageForInteraction(page) from ../../agents/qa-automation/overlay.js.",
    "preparePageForInteraction installs a reusable modal guard for later click/fill/press/keyboard and later navigations on the same page. Do not reimplement modal logic in the spec.",
    "Optional: withModalHandling(page, () => locator.click()) wraps one action and retries it at most once if a modal intercepts it.",
    "If preparePageForInteraction throws because a modal cannot be dismissed, write FAILED evidence including overlay details, then rethrow. Never write INCONCLUSIVE.",
    "Do not hard-code product-specific overlay selectors. Do not log in, change location, or click arbitrary elements to bypass overlays.",
    "Do not use locator.click({ force: true }) or otherwise bypass normal user interaction.",
    "",
    input.requirementText
      ? `Original requirement:\n${input.requirementText}`
      : "",
    "",
    input.analysis
      ? `QA Analyst analysis (JSON):\n${JSON.stringify(input.analysis, null, 2)}`
      : "",
    "",
    input.strategy
      ? `QA Analyst strategy (JSON):\n${JSON.stringify(input.strategy, null, 2)}`
      : "",
    "",
    "Functional test case (JSON):",
    JSON.stringify(
      {
        id: testCase.id,
        requirementId: testCase.requirementId,
        title: testCase.title,
        objective: testCase.objective,
        priority: testCase.priority,
        preconditions: testCase.preconditions,
        steps: testCase.steps,
        expectedResult: testCase.expectedResult,
        riskCovered: testCase.riskCovered,
      },
      null,
      2
    ),
  ]
    .filter((section) => section !== "")
    .join("\n");
}

function extractSource(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LLM spec generation did not return a JSON object");
  }

  const record = value as Record<string, unknown>;
  const source =
    typeof record.source === "string"
      ? record.source
      : typeof record.playwrightSource === "string"
        ? record.playwrightSource
        : "";

  const cleaned = stripMarkdownFence(source).trim();
  if (!cleaned) {
    throw new Error("LLM spec generation returned empty Playwright source");
  }

  if (!cleaned.includes("@playwright/test")) {
    throw new Error(
      "LLM spec generation did not return a Playwright test file"
    );
  }

  return `${cleaned}\n`;
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:ts|typescript|js)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? trimmed;
}

function ensureEsmCompatible(source: string): string {
  let next = source.replace(
    /^\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"](?:node:)?(?:fs|path)['"]\s*\)\s*;?\s*$/gm,
    ""
  );
  next = next.replace(/\brequire\s*\(\s*['"](?:node:)?path['"]\s*\)/g, "path");
  next = next.replace(/\brequire\s*\(\s*['"](?:node:)?fs['"]\s*\)/g, "fs");

  const hasPathImport = /from\s+['"](?:node:)?path['"]/.test(next);
  const hasFsImport = /from\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(next);
  const usesPath = /\bpath\.(?:dirname|join|resolve|basename)\b/.test(next);
  const usesFsNamespace = /\bfs\.(?:mkdirSync|writeFileSync|readFileSync|existsSync)\b/.test(
    next
  );
  const usesNamedFs = /\b(?:mkdirSync|writeFileSync)\s*\(/.test(next);

  const imports: string[] = [];
  if (usesPath && !hasPathImport) {
    imports.push('import path from "node:path";');
  }
  if (usesFsNamespace && !hasFsImport) {
    imports.push('import fs from "node:fs";');
  } else if (usesNamedFs && !hasFsImport && !usesFsNamespace) {
    imports.push('import { mkdirSync, writeFileSync } from "node:fs";');
  }

  if (imports.length > 0) {
    next = insertAfterImports(next, `${imports.join("\n")}\n`);
  }

  if (/\brequire\s*\(/.test(next)) {
    throw new Error(
      "Generated Playwright spec used CommonJS require(), which is not valid in this ESM project"
    );
  }

  return next;
}

export function ensurePassFailOnly(source: string): string {
  return source
    .replaceAll('classification: "INCONCLUSIVE"', 'classification: "ENVIRONMENT_ISSUE"')
    .replaceAll("classification: 'INCONCLUSIVE'", "classification: 'ENVIRONMENT_ISSUE'")
    .replaceAll('"INCONCLUSIVE"', '"FAILED"')
    .replaceAll("'INCONCLUSIVE'", "'FAILED'");
}

export function stripProductJudgments(source: string): string {
  return source
    .replace(/,\s*kind:\s*["'](?:FUNCTIONAL|TECHNICAL)["']/g, "")
    .replace(/kind:\s*["'](?:FUNCTIONAL|TECHNICAL)["']\s*,/g, "")
    .replace(/kind:\s*["'](?:FUNCTIONAL|TECHNICAL)["']/g, "")
    .replace(
      /,\s*observedOutcome\s*[:=]\s*["']authentication_required["']/g,
      ""
    )
    .replace(
      /observedOutcome\s*[:=]\s*["']authentication_required["']\s*,/g,
      ""
    )
    .replace(/\bobservedOutcome\s*[:=]\s*["']authentication_required["']/g, "")
    .replace(
      /\boutcome\s*=\s*["'](?:broken_unusable|auth_required)["']/g,
      "outcome = null"
    )
    .replace(/\{\s{2,}/g, "{ ");
}

export function normalizeGeneratedSource(
  source: string,
  options: { testCaseUrl?: string; testCase?: AnalystTestCase } = {}
): string {
  const intent = options.testCase
    ? analyzeTestCaseIntent(options.testCase)
    : { search: false, firstDeal: false, linkCollection: false };

  let next = ensureEsmCompatible(source);
  next = ensureOverlayHandling(next);
  next = ensureApplicationUrl(next, { testCaseUrl: options.testCaseUrl });
  next = stripOutOfScopeJourneys(next, intent);
  if (intent.linkCollection || usesInteractionHelpers(next)) {
    next = ensureInteractionHandling(
      next,
      intent.linkCollection
        ? [...INTERACTION_NAMES, "recordLinkDestination", "observePage"]
        : INTERACTION_NAMES
    );
  }
  next = ensureCanonicalJourneys(next, intent, options.testCase);
  if (options.testCase) {
    next = ensureTestCaseValidations(next, options.testCase, intent);
  }
  next = ensureDiscoverHandling(next, {
    names: discoverNamesFor(intent, next),
  });
  next = ensurePassFailOnly(next);
  next = stripProductJudgments(next);
  if (options.testCase) {
    next = embedTestCaseTextSafely(next, options.testCase);
  }
  return next;
}

const OVERLAY_IMPORT =
  'import { preparePageForInteraction } from "../../agents/qa-automation/overlay.js";';

const APP_URL_IMPORT =
  'import { resolveApplicationUrl } from "../../agents/qa-automation/app-url.js";';

const CANONICAL_DISCOVER_NAMES = [
  "findUserFacingControl",
  "readFirstDisplayedItemTitle",
  "readFirstVisibleDeal",
  "submitSearch",
];

const INTERACTION_NAMES = [
  "listNavigableLinks",
  "activateNavigableLink",
  "restorePage",
  "closeOpenedPageIfDifferent",
];

export function ensureDiscoverHandling(
  source: string,
  options: { names?: string[] } = {}
): string {
  const names = options.names ?? CANONICAL_DISCOVER_NAMES;
  let next = collapseDuplicateModuleImports(source, "discover.js");
  if (names.length === 0) {
    return next;
  }
  if (/from\s+['"][^'"]*discover\.js['"]/.test(next)) {
    return ensureNamedImports(next, "discover.js", names);
  }
  return insertAfterImports(
    next,
    `import { ${names.join(", ")} } from "../../agents/qa-automation/discover.js";\n`
  );
}

export function ensureInteractionHandling(
  source: string,
  names: string[] = INTERACTION_NAMES
): string {
  let next = collapseDuplicateModuleImports(source, "interaction.js");
  if (/from\s+['"][^'"]*interaction\.js['"]/.test(next)) {
    return ensureNamedImports(next, "interaction.js", names);
  }
  return insertAfterImports(
    next,
    `import { ${names.join(", ")} } from "../../agents/qa-automation/interaction.js";\n`
  );
}

export function ensureApplicationUrl(
  source: string,
  options: { testCaseUrl?: string } = {}
): string {
  let next = source;

  if (!/from\s+['"][^'"]*app-url\.js['"]/.test(next)) {
    next = insertAfterImports(next, `${APP_URL_IMPORT}\n`);
  }

  next = stripMissingHomepageGuards(next);
  next = rewriteEnvHomepageAccess(next);
  next = stripMissingHomepageGuards(next);

  if (!/\bresolveApplicationUrl\s*\(/.test(next)) {
    next = insertAfterImports(
      next,
      applicationUrlDeclaration(options.testCaseUrl)
    );
  } else if (
    /\bAPPLICATION_URL\b/.test(next) &&
    !/\bconst\s+APPLICATION_URL\b/.test(next)
  ) {
    next = insertAfterImports(
      next,
      applicationUrlDeclaration(options.testCaseUrl)
    );
  }

  return next;
}

function rewriteEnvHomepageAccess(source: string): string {
  let next = source.replace(
    /(?:const|let|var)\s*\{\s*(?:HOMEPAGE\s*,\s*BASE_URL|BASE_URL\s*,\s*HOMEPAGE|HOMEPAGE|BASE_URL)\s*\}\s*=\s*process\.env\s*;?/g,
    "const HOMEPAGE = APPLICATION_URL;"
  );

  const aliases = [
    ...next.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*process\.env\s*;?/g),
  ].map((match) => match[1]);
  for (const alias of aliases) {
    next = next.replace(
      new RegExp(`\\b${alias}\\s*\\??\\s*\\.\\s*HOMEPAGE\\b`, "g"),
      "APPLICATION_URL"
    );
    next = next.replace(
      new RegExp(`\\b${alias}\\s*\\??\\s*\\.\\s*BASE_URL\\b`, "g"),
      "APPLICATION_URL"
    );
    next = next.replace(
      new RegExp(`\\b${alias}\\s*\\[[\\s'\`"]*HOMEPAGE[\\s'\`"]*\\]`, "g"),
      "APPLICATION_URL"
    );
    next = next.replace(
      new RegExp(`\\b${alias}\\s*\\[[\\s'\`"]*BASE_URL[\\s'\`"]*\\]`, "g"),
      "APPLICATION_URL"
    );
  }

  next = next.replace(
    /\bprocess\.env\s*\??\s*\.\s*HOMEPAGE\b/g,
    "APPLICATION_URL"
  );
  next = next.replace(
    /\bprocess\.env\s*\??\s*\.\s*BASE_URL\b/g,
    "APPLICATION_URL"
  );
  next = next.replace(
    /\bprocess\.env\s*\[[\s'"`]*HOMEPAGE[\s'"`]*\]/g,
    "APPLICATION_URL"
  );
  next = next.replace(
    /\bprocess\.env\s*\[[\s'"`]*BASE_URL[\s'"`]*\]/g,
    "APPLICATION_URL"
  );

  return stripUnusedProcessEnvAliases(next);
}

function stripUnusedProcessEnvAliases(source: string): string {
  return source.replace(
    /(?:const|let|var)\s+(\w+)\s*=\s*process\.env\s*;?\n?/g,
    (full, name: string) => {
      const remainder = source.replace(full, "");
      return new RegExp(`\\b${name}\\b`).test(remainder) ? full : "";
    }
  );
}

function stripMissingHomepageGuards(source: string): string {
  const missingEnv =
    /(?:HOMEPAGE|BASE_URL|homepage|homepageUrl|baseUrl|APPLICATION_URL)/i;
  const optionalTrim = "(?:\\s*\\??\\.\\s*trim\\s*\\(\\s*\\))?";
  return source
    .replace(
      new RegExp(
        `\\n[ \\t]*if\\s*\\(\\s*!+\\s*[\\w.$?]*HOMEPAGE[\\w.$?]*${optionalTrim}\\s*\\)\\s*\\{(?:[^{}]|\\{[^{}]*\\})*\\}`,
        "g"
      ),
      ""
    )
    .replace(
      new RegExp(
        `\\n[ \\t]*if\\s*\\(\\s*!+\\s*[\\w.$?]*BASE_URL[\\w.$?]*${optionalTrim}\\s*\\)\\s*\\{(?:[^{}]|\\{[^{}]*\\})*\\}`,
        "g"
      ),
      ""
    )
    .replace(
      new RegExp(
        `\\n[ \\t]*if\\s*\\(\\s*!+\\s*(?:homepage|homepageUrl|baseUrl|APPLICATION_URL|HOMEPAGE|BASE_URL)${optionalTrim}\\s*\\)\\s*\\{(?:[^{}]|\\{[^{}]*\\})*(?:HOMEPAGE|BASE_URL)(?:[^{}]|\\{[^{}]*\\})*\\}`,
        "gi"
      ),
      ""
    )
    .replace(
      new RegExp(
        `\\n[ \\t]*if\\s*\\(\\s*!+\\s*[\\w.$?]*(?:HOMEPAGE|BASE_URL)[\\w.$?]*${optionalTrim}\\s*\\)\\s*throw\\s+new\\s+Error\\([^;]*\\);?`,
        "g"
      ),
      ""
    )
    .replace(
      new RegExp(
        `\\n[ \\t]*if\\s*\\(\\s*!+\\s*(?:homepage|homepageUrl|baseUrl|APPLICATION_URL|HOMEPAGE|BASE_URL)${optionalTrim}\\s*\\)\\s*throw\\s+new\\s+Error\\([^;]*\\);?`,
        "gi"
      ),
      (full) => (missingEnv.test(full) ? "" : full)
    );
}

function applicationUrlDeclaration(testCaseUrl?: string): string {
  if (testCaseUrl) {
    return `const APPLICATION_URL = resolveApplicationUrl({ testCaseUrl: ${JSON.stringify(testCaseUrl)} });\n`;
  }
  return "const APPLICATION_URL = resolveApplicationUrl();\n";
}

function ensureNamedImports(
  source: string,
  moduleSuffix: string,
  names: string[]
): string {
  const escaped = moduleSuffix.replace(".", "\\.");
  const importPattern = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*(['"][^'"]*${escaped}['"])`
  );
  const match = source.match(importPattern);
  if (!match?.[1] || !match[2]) {
    return source;
  }

  const existing = match[1]
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim())
    .filter((name): name is string => Boolean(name));
  const missing = names.filter((name) => !existing.includes(name));
  if (missing.length === 0) {
    return source;
  }

  const merged = [...existing, ...missing].join(", ");
  return source.replace(
    importPattern,
    `import { ${merged} } from ${match[2]}`
  );
}

function collapseDuplicateModuleImports(
  source: string,
  moduleSuffix: string
): string {
  const escaped = moduleSuffix.replace(".", "\\.");
  const importPattern = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*(['"][^'"]*${escaped}['"]);?\\s*\\n?`,
    "g"
  );
  const matches = [...source.matchAll(importPattern)];
  if (matches.length <= 1) {
    return source;
  }

  const names: string[] = [];
  let specifier = matches[0]?.[2];
  for (const match of matches) {
    specifier = match[2] ?? specifier;
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  if (!specifier) {
    return source;
  }

  const withoutDuplicates = source.replace(importPattern, "");
  return insertAfterImports(
    withoutDuplicates,
    `import { ${names.join(", ")} } from ${specifier}\n`
  );
}

function discoverNamesFor(intent: TestCaseIntent, source: string): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    if (!names.includes(name)) {
      names.push(name);
    }
  };
  if (/\bfindUserFacingControl\s*\(/.test(source)) {
    add("findUserFacingControl");
  }
  if (intent.search || /\bsubmitSearch\s*\(/.test(source)) {
    add("submitSearch");
  }
  if (/\breadFirstDisplayedItemTitle\s*\(/.test(source)) {
    add("readFirstDisplayedItemTitle");
  }
  if (intent.firstDeal || /\breadFirstVisibleDeal\s*\(/.test(source)) {
    add("readFirstVisibleDeal");
  }
  if (/\blistVisibleDeals\s*\(/.test(source)) {
    add("listVisibleDeals");
  }
  return names;
}

function usesInteractionHelpers(source: string): boolean {
  return /\b(?:listNavigableLinks|activateNavigableLink|restorePage|closeOpenedPageIfDifferent|recordLinkDestination|assessLinkDestination|observePage|resolveOpenPage)\s*\(/.test(
    source
  );
}

function ensureCanonicalJourneys(
  source: string,
  intent: TestCaseIntent,
  testCase?: AnalystTestCase
): string {
  let next = source;
  const statements: string[] = [];

  if (intent.search) {
    const query = resolveSearchQuery(testCase, next);
    next = stripObsoleteSearch(next);
    if (!/\bsubmitSearch\s*\(/.test(next)) {
      if (query !== undefined) {
        statements.push(
          `await submitSearch(page, ${JSON.stringify(query)});`
        );
      } else if (/\b(?:const|let|var)\s+query\b/.test(next)) {
        statements.push("await submitSearch(page, query);");
      }
    }
  }

  if (intent.firstDeal) {
    next = stripGenericDealDetection(next);
    next = next.replace(
      /\breadFirstDisplayedItemTitle\s*\(/g,
      "readFirstVisibleDeal("
    );
    const validations = testCase ? requiredValidations(testCase) : [];
    const appearsOnly =
      validations.some((item) => item.type === "visibleDealTitle") &&
      !validations.some((item) => item.type === "firstVisibleDealTitle");
    if (appearsOnly) {
      if (!/\blistVisibleDeals\s*\(/.test(next)) {
        statements.push("const visibleDeals = await listVisibleDeals(page);");
      }
    } else if (!/\breadFirstVisibleDeal\s*\(/.test(next)) {
      statements.push(
        "const firstVisibleDeal = await readFirstVisibleDeal(page);"
      );
    }
  }

  if (intent.linkCollection && !/\blistNavigableLinks\s*\(/.test(next)) {
    statements.push("const links = await listNavigableLinks(page);");
  }

  if (statements.length === 0) {
    return next;
  }

  if (/\bsubmitSearch\s*\(/.test(next) && intent.firstDeal) {
    const dealOnly = statements.filter(
      (statement) =>
        statement.includes("readFirstVisibleDeal") ||
        statement.includes("listVisibleDeals")
    );
    if (dealOnly.length > 0 && dealOnly.length === statements.length) {
      return insertAfterCall(next, "submitSearch", dealOnly);
    }
    if (dealOnly.length > 0) {
      next = insertAfterCall(next, "submitSearch", dealOnly);
      const remaining = statements.filter(
        (statement) =>
          !statement.includes("readFirstVisibleDeal") &&
          !statement.includes("listVisibleDeals")
      );
      if (remaining.length === 0) {
        return next;
      }
      return insertStatementsAfterPageReady(next, remaining);
    }
  }

  return insertStatementsAfterPageReady(next, statements);
}

function ensureTestCaseValidations(
  source: string,
  testCase: AnalystTestCase,
  intent: TestCaseIntent
): string {
  let next = source;
  const validations = requiredValidations(testCase);
  const importNames = validationImportNames(validations);
  if (importNames.length > 0) {
    next = ensureValidationHandling(next, importNames);
  }

  for (const validation of validations) {
    next = injectValidation(next, validation, intent);
  }
  return next;
}

function validationImportNames(validations: RequiredValidation[]): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    if (!names.includes(name)) {
      names.push(name);
    }
  };
  for (const validation of validations) {
    if (validation.type === "firstVisibleDealTitle") {
      add("assertObservedMatchesExpected");
    }
    if (validation.type === "visibleDealTitle") {
      add("assertVisibleResultsIncludeTitle");
    }
    if (validation.type === "visibleText") {
      add("assertVisibleText");
    }
    if (validation.type === "linkDestinationsUsable") {
      add("destinationHasMeaningfulContent");
    }
    if (validation.type === "pageHost") {
      add("assertHostMatchesExpected");
    }
    if (validation.type === "recognizableContent") {
      add("assertRecognizableContent");
    }
    if (validation.type === "pageNotBlank") {
      add("assertPageNotBlank");
    }
  }
  return names;
}

function ensureValidationHandling(source: string, names: string[]): string {
  let next = collapseDuplicateModuleImports(source, "validation.js");
  if (/from\s+['"][^'"]*validation\.js['"]/.test(next)) {
    return ensureNamedImports(next, "validation.js", names);
  }
  return insertAfterImports(
    next,
    `import { ${names.join(", ")} } from "../../agents/qa-automation/validation.js";\n`
  );
}

function injectValidation(
  source: string,
  validation: RequiredValidation,
  intent: TestCaseIntent
): string {
  if (validation.type === "firstVisibleDealTitle") {
    return injectFirstVisibleTitleValidation(source, validation.expected);
  }
  if (validation.type === "visibleDealTitle") {
    return injectVisibleResultsTitleValidation(source, validation.expected);
  }
  if (validation.type === "visibleText") {
    return injectVisibleTextValidation(source, validation.expected);
  }
  if (validation.type === "linkDestinationsUsable") {
    return injectLinkDestinationValidation(source, validation.expectedCount);
  }
  if (validation.type === "pageHost") {
    return injectPageHostValidation(source, validation.host);
  }
  if (validation.type === "recognizableContent") {
    return injectRecognizableContentValidation(source, validation.tokens);
  }
  if (validation.type === "pageNotBlank") {
    return injectPageNotBlankValidation(source, intent);
  }
  return source;
}

function injectFirstVisibleTitleValidation(
  source: string,
  expected: string
): string {
  let next = stripLaterResultHunting(source);
  if (!hasCanonicalExpectedResultAssertion(next)) {
    const binding = firstDealBinding(next);
    next = insertAfterCall(next, "readFirstVisibleDeal", [
      `assertObservedMatchesExpected(${binding}.title ?? ${binding}.text, TEST_CASE_EXPECTED_VISIBLE_RESULT, "First visible result title");`,
    ]);
  }
  return stripWeakFirstResultAssertions(next, expected);
}

function injectVisibleTextValidation(source: string, expected: string): string {
  if (hasVisibleTextAssertion(source, expected)) {
    return source;
  }
  return insertStatementsAfterPageReady(source, [
    `assertVisibleText(await page.locator("body").innerText(), ${JSON.stringify(expected)});`,
  ]);
}

function injectVisibleResultsTitleValidation(
  source: string,
  expected: string
): string {
  let next = source;
  if (!/\blistVisibleDeals\s*\(/.test(next)) {
    if (/\bsubmitSearch\s*\(/.test(next)) {
      next = insertAfterCall(next, "submitSearch", [
        "const visibleDeals = await listVisibleDeals(page);",
      ]);
    } else {
      next = insertStatementsAfterPageReady(next, [
        "const visibleDeals = await listVisibleDeals(page);",
      ]);
    }
  }
  if (!hasCanonicalExpectedResultAssertion(next)) {
    const binding = visibleDealListBinding(next);
    next = insertAfterCall(next, "listVisibleDeals", [
      `assertVisibleResultsIncludeTitle(${binding}, TEST_CASE_EXPECTED_VISIBLE_RESULT);`,
    ]);
  }
  return stripWeakFirstResultAssertions(next, expected);
}

function injectLinkDestinationValidation(
  source: string,
  expectedCount?: number
): string {
  let next = source;
  if (expectedCount !== undefined) {
    next = next.replace(
      /\blistNavigableLinks\s*\(\s*page\s*(?:,\s*\{[^}]*\}\s*)?\)/,
      `listNavigableLinks(page, { limit: ${expectedCount} })`
    );
  }
  if (/\bdestinationHasMeaningfulContent\s*\(/.test(next)) {
    return next;
  }
  if (/\brecordLinkDestination\s*\(/.test(next)) {
    const binding = recordBinding(next);
    return insertAfterCall(next, "recordLinkDestination", [
      `if (!destinationHasMeaningfulContent(${binding})) { throw new Error("Destination did not display meaningful user-facing content"); }`,
    ]);
  }
  if (/\bobservePage\s*\(/.test(next)) {
    const binding = observationBinding(next);
    return insertAfterCall(next, "observePage", [
      `if (!destinationHasMeaningfulContent(${binding})) { throw new Error("Destination did not display meaningful user-facing content"); }`,
    ]);
  }
  if (/\blistNavigableLinks\s*\(/.test(next)) {
    const binding = linkListBinding(next);
    const items =
      expectedCount !== undefined
        ? `${binding}.slice(0, ${expectedCount})`
        : binding;
    return insertAfterCall(next, "listNavigableLinks", [
      "const originalUrl = page.url();",
      `for (const item of ${items}) {`,
      "  const activation = await activateNavigableLink(page, item.locator);",
      "  const observed = await observePage(activation.page);",
      "  const destination = recordLinkDestination({ href: item.href, originalUrl, finalUrl: observed.url, title: observed.title, bodyText: observed.bodyText, navigationKind: activation.kind, reached: observed.pageOpen });",
      '  if (!destinationHasMeaningfulContent(destination)) { throw new Error("Destination did not display meaningful user-facing content"); }',
      "  await closeOpenedPageIfDifferent(page, activation.page);",
      "  if (activation.kind === \"same-tab\") { await restorePage(page, originalUrl); }",
      "}",
    ]);
  }
  return next;
}

function linkListBinding(source: string): string {
  const match = source.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*await\s+listNavigableLinks\s*\(/
  );
  return match?.[1] ?? "links";
}

function recordBinding(source: string): string {
  const match = source.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?recordLinkDestination\s*\(/
  );
  return match?.[1] ?? "destination";
}

function injectPageHostValidation(source: string, host: string): string {
  if (
    /\bassertHostMatchesExpected\s*\(/.test(source) &&
    source.includes(host)
  ) {
    return source;
  }
  return insertStatementsAfterPageReady(source, [
    `assertHostMatchesExpected(page.url(), ${JSON.stringify(host)});`,
  ]);
}

function injectRecognizableContentValidation(
  source: string,
  tokens: string[]
): string {
  if (/\bassertRecognizableContent\s*\(/.test(source)) {
    return source;
  }
  return insertStatementsAfterPageReady(source, [
    "const visiblePageText = await page.locator(\"body\").innerText();",
    `assertRecognizableContent(visiblePageText, ${JSON.stringify(tokens)});`,
  ]);
}

function injectPageNotBlankValidation(
  source: string,
  intent: TestCaseIntent
): string {
  if (/\bassertPageNotBlank\s*\(/.test(source)) {
    return source;
  }
  const statement =
    'assertPageNotBlank(await page.locator("body").innerText());';
  if (intent.search && /\bsubmitSearch\s*\(/.test(source)) {
    return insertAfterCall(source, "submitSearch", [statement]);
  }
  return insertStatementsAfterPageReady(source, [statement]);
}

function firstDealBinding(source: string): string {
  const match = source.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*await\s+readFirstVisibleDeal\s*\(/
  );
  return match?.[1] ?? "firstVisibleDeal";
}

function visibleDealListBinding(source: string): string {
  const match = source.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*await\s+listVisibleDeals\s*\(/
  );
  return match?.[1] ?? "visibleDeals";
}

function observationBinding(source: string): string {
  const match = source.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*await\s+observePage\s*\(/
  );
  return match?.[1] ?? "observation";
}

function hasCanonicalExpectedResultAssertion(source: string): boolean {
  return (
    /\bassertObservedMatchesExpected\s*\(/.test(source) ||
    /\bfirstDisplayedMatchesExpected\s*\(/.test(source) ||
    /\bassertVisibleResultsIncludeTitle\s*\(/.test(source)
  );
}

function hasFirstResultExactAssertion(source: string, expected: string): boolean {
  if (
    !source.includes(expected) &&
    !/\bTEST_CASE_EXPECTED_VISIBLE_RESULT\b/.test(source)
  ) {
    return false;
  }
  return (
    /\bassertObservedMatchesExpected\s*\(/.test(source) ||
    /\bfirstDisplayedMatchesExpected\s*\(/.test(source) ||
    /\.to(?:Be|Equal|HaveText)\s*\(\s*(?:TEST_CASE_EXPECTED_VISIBLE_RESULT|["'])/.test(
      source
    ) ||
    /(?:observedTitle|firstVisibleDeal\.(?:title|text))\s*(?:!==|===|==)\s*/.test(
      source
    )
  );
}

function hasExpectedTitleAssertion(source: string, expected: string): boolean {
  if (hasFirstResultExactAssertion(source, expected)) {
    return true;
  }
  if (
    !source.includes(expected) &&
    !/\bTEST_CASE_EXPECTED_VISIBLE_RESULT\b/.test(source)
  ) {
    return false;
  }
  return /\bassertVisibleResultsIncludeTitle\s*\(/.test(source);
}

function hasVisibleTextAssertion(source: string, expected: string): boolean {
  return (
    /\bassertVisibleText\s*\(/.test(source) &&
    (source.includes(expected) || /\bTEST_CASE_EXPECTED_VISIBLE_TEXT\b/.test(source))
  );
}

function stripLaterResultHunting(source: string): string {
  return source.replace(
    /\n[ \t]*assertVisibleResultsIncludeTitle\s*\([^;]*\)\s*;?/g,
    ""
  );
}

function stripWeakFirstResultAssertions(
  source: string,
  expected: string
): string {
  if (!expected) {
    return source;
  }
  return source.replace(
    /\n[ \t]*expect\(\s*(?:firstVisibleDeal|firstDeal|first|visibleDeals)\s*\)\.toBe(?:Truthy|Defined)\(\s*\)\s*;?/g,
    ""
  );
}

function stripOutOfScopeJourneys(
  source: string,
  intent: TestCaseIntent
): string {
  let next = source;
  if (!intent.search) {
    next = stripObsoleteSearch(next);
    next = stripHelperCalls(next, "submitSearch");
  }
  if (!intent.firstDeal) {
    next = stripGenericDealDetection(next);
    next = stripHelperCalls(next, "readFirstVisibleDeal");
    next = stripHelperCalls(next, "readFirstDisplayedItemTitle");
    next = stripHelperCalls(next, "listVisibleDeals");
  }
  if (!intent.linkCollection) {
    next = stripHelperCalls(next, "listNavigableLinks");
    next = stripHelperCalls(next, "recordLinkDestination");
    next = stripHelperCalls(next, "assessLinkDestination");
    next = stripHelperCalls(next, "observePage");
  }
  return next;
}

function stripHelperCalls(source: string, functionName: string): string {
  const prefix = new RegExp(
    `[ \\t]*(?:(?:const|let|var)\\s+\\w+\\s*=\\s*)?(?:await\\s+)?${functionName}\\s*\\(`
  );
  let next = source;
  let match = next.search(prefix);
  while (match >= 0) {
    const open = next.indexOf("(", match);
    let end = closeBalanced(next, open);
    if (end < 0) {
      break;
    }
    while (end < next.length && /\s/.test(next[end])) {
      end += 1;
    }
    if (next[end] === ";") {
      end += 1;
    }
    if (next[end] === "\n") {
      end += 1;
    }
    next = `${next.slice(0, match)}${next.slice(end)}`;
    match = next.search(prefix);
  }
  return next;
}

function stripGenericDealDetection(source: string): string {
  return source
    .replace(
      /[ \t]*(?:(?:const|let|var)\s+\w+\s*=\s*)?await\s+page\.locator\(\s*['"]a['"]\s*\)\.first\(\s*\)[^\n]*\n?/g,
      ""
    )
    .replace(
      /[ \t]*(?:const|let|var)\s+\w+\s*=\s*page\.locator\(\s*['"]a['"]\s*\)\.first\(\s*\)\s*;?\n?/g,
      ""
    )
    .replace(
      /[ \t]*(?:(?:const|let|var)\s+\w+\s*=\s*)?await\s+page\.getByRole\(\s*['"]heading['"][\s\S]*?\)\.first\(\s*\)[^\n]*\n?/g,
      ""
    )
    .replace(
      /[ \t]*(?:(?:const|let|var)\s+\w+\s*=\s*)?await\s+page\.locator\(\s*['"]h[1-4]['"]\s*\)[^\n]*\n?/g,
      ""
    );
}

function resolveSearchQuery(
  testCase: AnalystTestCase | undefined,
  source: string
): string | undefined {
  const fromCase = testCase ? extractSearchQuery(testCase) : undefined;
  if (fromCase) {
    return fromCase;
  }

  const fromSubmit = source.match(
    /\bsubmitSearch\s*\(\s*[\w.]+\s*,\s*(['"])([^'"]+)\1/
  );
  if (fromSubmit?.[2]) {
    return fromSubmit[2];
  }

  const fromFill = source.match(/\.fill\(\s*(['"])([^'"]+)\1\s*\)/);
  if (fromFill?.[2]) {
    return fromFill[2];
  }

  const queryVar = source.match(/(?:const|let|var)\s+query\s*=\s*(['"])([^'"]+)\1/);
  if (queryVar?.[2]) {
    return queryVar[2];
  }

  return undefined;
}

function stripObsoleteSearch(source: string): string {
  let next = source;
  next = next.replace(
    /[ \t]*await\s+[\w.]*(?:page\.)?getByRole\(\s*['"]button['"]\s*,\s*\{[^}]*name:\s*(?:['"]Search['"]|\/[Ss]earch\/i)\s*[^}]*\}\s*\)\s*\.click\(\s*(?:\{[^}]*\}\s*)?\)\s*;?[ \t]*\n?/g,
    ""
  );
  next = next.replace(
    /[ \t]*await\s+page\.(?:getByPlaceholder|getByLabel)\(\s*['"][^'"]*[Ss]earch[^'"]*['"]\s*\)\s*\.fill\([^;]*\)\s*;?[ \t]*\n?/g,
    ""
  );
  next = next.replace(
    /[ \t]*await\s+page\.getByRole\(\s*['"](?:textbox|searchbox|combobox)['"]\s*,\s*\{[^}]*[Ss]earch[^}]*\}\s*\)\s*\.fill\([^;]*\)\s*;?[ \t]*\n?/g,
    ""
  );
  next = next.replace(
    /[ \t]*await\s+page\.keyboard\.press\(\s*['"]Enter['"]\s*\)\s*;?[ \t]*\n?/g,
    ""
  );
  return next;
}

function insertAfterCall(
  source: string,
  functionName: string,
  statements: string[]
): string {
  const start = source.search(new RegExp(`\\b${functionName}\\s*\\(`));
  if (start < 0) {
    return insertStatementsAfterPageReady(source, statements);
  }
  const open = source.indexOf("(", start);
  let end = closeBalanced(source, open);
  if (end < 0) {
    return insertStatementsAfterPageReady(source, statements);
  }
  while (end < source.length && /\s/.test(source[end])) {
    end += 1;
  }
  if (source[end] === ";") {
    end += 1;
  }
  const indent = indentAt(source, start);
  const block = statements.map((statement) => `\n${indent}${statement}`).join("");
  return `${source.slice(0, end)}${block}${source.slice(end)}`;
}

function insertStatementsAfterPageReady(
  source: string,
  statements: string[]
): string {
  if (statements.length === 0) {
    return source;
  }

  const continued = source.match(
    /if\s*\(\s*!overlay\.functionalTestContinued\s*\)\s*\{[\s\S]*?\n[ \t]*\}/
  );
  if (continued?.index !== undefined) {
    const insertAt = continued.index + continued[0].length;
    const indent = indentAt(source, continued.index);
    const block = statements.map((statement) => `\n${indent}${statement}`).join("");
    return `${source.slice(0, insertAt)}${block}${source.slice(insertAt)}`;
  }

  const overlayCall = source.search(/\bpreparePageForInteraction\s*\(/);
  if (overlayCall >= 0) {
    const open = source.indexOf("(", overlayCall);
    let end = closeBalanced(source, open);
    if (end >= 0) {
      while (end < source.length && /\s/.test(source[end])) {
        end += 1;
      }
      if (source[end] === ";") {
        end += 1;
      }
      const indent = indentAt(source, overlayCall);
      const block = statements
        .map((statement) => `\n${indent}${statement}`)
        .join("");
      return `${source.slice(0, end)}${block}${source.slice(end)}`;
    }
  }

  const gotoEnd = endOfGotoStatement(source);
  if (gotoEnd !== undefined) {
    const indent = indentAt(source, source.search(/\bpage\.goto\s*\(/));
    const block = statements.map((statement) => `\n${indent}${statement}`).join("");
    return `${source.slice(0, gotoEnd)}${block}${source.slice(gotoEnd)}`;
  }

  return source;
}

export function toTypeScriptLiteral(value: unknown): string {
  return JSON.stringify(value);
}

function embedTestCaseTextSafely(
  source: string,
  testCase: AnalystTestCase
): string {
  let next = source;
  for (const value of testCaseTextValues(testCase)) {
    next = replaceQuotedCopies(next, value);
  }
  next = rewritePlaywrightTestTitle(next);
  return insertTestCaseConstants(next, testCase);
}

function testCaseTextValues(testCase: AnalystTestCase): string[] {
  const values = [
    testCase.title,
    testCase.objective,
    testCase.expectedResult,
    ...(testCase.preconditions ?? []),
    ...(testCase.steps ?? []),
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0
  );
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function replaceQuotedCopies(source: string, raw: string): string {
  if (!raw) {
    return source;
  }

  let next = source;
  let from = 0;
  const encoded = toTypeScriptLiteral(raw);

  while (from < next.length) {
    const idx = next.indexOf(raw, from);
    if (idx < 0) {
      break;
    }

    const before = next[idx - 1];
    const after = next[idx + raw.length];
    if (
      before === '"' &&
      after === '"' &&
      encoded === `"${raw}"`
    ) {
      from = idx + raw.length;
      continue;
    }

    if (before === "'" || before === '"' || before === "`") {
      const closeIndex =
        after === before ? idx + raw.length + 1 : idx + raw.length;
      next = `${next.slice(0, idx - 1)}${encoded}${next.slice(closeIndex)}`;
      from = idx - 1 + encoded.length;
      continue;
    }

    from = idx + raw.length;
  }

  return next;
}

function rewritePlaywrightTestTitle(source: string): string {
  const match = /\btest\s*\(\s*/.exec(source);
  if (!match) {
    return source;
  }
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  if (rest.startsWith("TEST_CASE_TITLE")) {
    return source;
  }
  const endMatch = /,\s*async\s*\(/.exec(rest);
  if (!endMatch) {
    return source;
  }
  return `${source.slice(0, start)}TEST_CASE_TITLE${rest.slice(endMatch.index)}`;
}

function insertTestCaseConstants(
  source: string,
  testCase: AnalystTestCase
): string {
  const validations = requiredValidations(testCase);
  const expectedVisible = validations.find(
    (
      item
    ): item is Extract<
      RequiredValidation,
      { type: "firstVisibleDealTitle" | "visibleDealTitle" | "visibleText" }
    > =>
      item.type === "firstVisibleDealTitle" ||
      item.type === "visibleDealTitle" ||
      item.type === "visibleText"
  );
  let next = source;
  if (!/\bconst\s+TEST_CASE_TITLE\b/.test(next)) {
    const block = [
      `const TEST_CASE_TITLE = ${toTypeScriptLiteral(testCase.title)};`,
      `const TEST_CASE_OBJECTIVE = ${toTypeScriptLiteral(testCase.objective ?? "")};`,
      `const TEST_CASE_EXPECTED_RESULT = ${toTypeScriptLiteral(testCase.expectedResult ?? "")};`,
      ...(expectedVisible
        ? [
            `const TEST_CASE_EXPECTED_VISIBLE_RESULT = ${toTypeScriptLiteral(expectedVisible.expected)};`,
          ]
        : []),
      "",
    ].join("\n");
    next = insertAfterImports(next, block);
  } else if (
    expectedVisible &&
    !/\bTEST_CASE_EXPECTED_VISIBLE_RESULT\b/.test(next)
  ) {
    next = insertAfterImports(
      next,
      `const TEST_CASE_EXPECTED_VISIBLE_RESULT = ${toTypeScriptLiteral(expectedVisible.expected)};\n`
    );
  }
  return next;
}

export function assertGeneratedSourceExecutable(
  source: string,
  intent: TestCaseIntent = { search: false, firstDeal: false, linkCollection: false },
  testCase?: AnalystTestCase
): void {
  if (!source.includes("@playwright/test")) {
    throw new Error(
      "Generated Playwright spec is missing @playwright/test and cannot execute"
    );
  }
  if (/\brequire\s*\(/.test(source)) {
    throw new Error(
      "Generated Playwright spec used CommonJS require() and cannot execute"
    );
  }
  if (hasMandatoryHomepagePrerequisite(source)) {
    throw new Error(
      "Generated Playwright spec still requires process.env.HOMEPAGE and cannot execute"
    );
  }
  if (intent.search && !/\bsubmitSearch\s*\(/.test(source)) {
    throw new Error(
      "Generated Playwright spec performs search but does not call submitSearch"
    );
  }
  if (!intent.search && /\bsubmitSearch\s*\(/.test(source)) {
    throw new Error(
      "Generated Playwright spec introduces search that the Test Case does not require"
    );
  }
  if (intent.firstDeal && !/\breadFirstVisibleDeal\s*\(/.test(source)) {
    const validations = testCase ? requiredValidations(testCase) : [];
    const appearsOnly =
      validations.some((item) => item.type === "visibleDealTitle") &&
      !validations.some((item) => item.type === "firstVisibleDealTitle");
    if (appearsOnly) {
      if (!/\blistVisibleDeals\s*\(/.test(source)) {
        throw new Error(
          "Generated Playwright spec must inspect displayed results for the expected title"
        );
      }
    } else {
      throw new Error(
        "Generated Playwright spec verifies a deal/result but does not call readFirstVisibleDeal"
      );
    }
  }
  if (
    !intent.firstDeal &&
    /\breadFirstVisibleDeal\s*\(/.test(source) &&
    !(testCase && requiredValidations(testCase).some((item) => item.type === "visibleDealTitle"))
  ) {
    throw new Error(
      "Generated Playwright spec introduces deal discovery that the Test Case does not require"
    );
  }
  if (intent.linkCollection && !/\blistNavigableLinks\s*\(/.test(source)) {
    throw new Error(
      "Generated Playwright spec validates links but does not call listNavigableLinks"
    );
  }
  if (!intent.linkCollection && /\blistNavigableLinks\s*\(/.test(source)) {
    throw new Error(
      "Generated Playwright spec introduces link collection that the Test Case does not require"
    );
  }

  const syntaxError = findSyntaxProblem(source);
  if (syntaxError) {
    throw new Error(`Generated Playwright spec is not executable: ${syntaxError}`);
  }

  if (testCase) {
    assertSourceValidatesTestCase(source, testCase);
  }
}

function assertSourceValidatesTestCase(
  source: string,
  testCase: AnalystTestCase
): void {
  const validations = requiredValidations(testCase);
  if (validations.length === 0 || !sourceHasTestCaseValidation(source)) {
    throw new Error(
      "Generated Playwright spec does not include a Test Case-derived validation"
    );
  }
  for (const validation of validations) {
    if (validation.type === "firstVisibleDealTitle") {
      if (!hasFirstResultExactAssertion(source, validation.expected)) {
        throw new Error(
          "Generated Playwright spec does not validate the Test Case expected first result"
        );
      }
    }
    if (validation.type === "visibleDealTitle") {
      if (!hasExpectedTitleAssertion(source, validation.expected)) {
        throw new Error(
          "Generated Playwright spec does not validate the Test Case expected result"
        );
      }
    }
    if (
      validation.type === "visibleText" &&
      !hasVisibleTextAssertion(source, validation.expected)
    ) {
      throw new Error(
        "Generated Playwright spec does not validate the expected visible content required by the Test Case"
      );
    }
    if (
      validation.type === "linkDestinationsUsable" &&
      !/\bdestinationHasMeaningfulContent\s*\(/.test(source)
    ) {
      throw new Error(
        "Generated Playwright spec does not validate destination content required by the Test Case"
      );
    }
    if (
      validation.type === "pageHost" &&
      !/\bassertHostMatchesExpected\s*\(/.test(source)
    ) {
      throw new Error(
        "Generated Playwright spec does not validate the Test Case expected URL/host"
      );
    }
    if (
      validation.type === "recognizableContent" &&
      !/\bassertRecognizableContent\s*\(/.test(source)
    ) {
      throw new Error(
        "Generated Playwright spec does not validate recognizable content required by the Test Case"
      );
    }
    if (
      validation.type === "pageNotBlank" &&
      !/\bassertPageNotBlank\s*\(/.test(source)
    ) {
      throw new Error(
        "Generated Playwright spec does not validate the observable page condition required by the Test Case"
      );
    }
  }
}

function sourceHasTestCaseValidation(source: string): boolean {
  return (
    /\bassertObservedMatchesExpected\s*\(/.test(source) ||
    /\bfirstDisplayedMatchesExpected\s*\(/.test(source) ||
    /\bassertVisibleResultsIncludeTitle\s*\(/.test(source) ||
    /\bassertVisibleText\s*\(/.test(source) ||
    /\bdestinationHasMeaningfulContent\s*\(/.test(source) ||
    /\bassertHostMatchesExpected\s*\(/.test(source) ||
    /\bassertRecognizableContent\s*\(/.test(source) ||
    /\bassertPageNotBlank\s*\(/.test(source)
  );
}

function hasMandatoryHomepagePrerequisite(source: string): boolean {
  if (/\bprocess\.env\s*\??\s*\.\s*HOMEPAGE\b/.test(source)) {
    return true;
  }
  if (/\bprocess\.env\s*\[[^\]]*HOMEPAGE[^\]]*\]/.test(source)) {
    return true;
  }
  if (/\bprocess\.env\s*\??\s*\.\s*BASE_URL\b/.test(source)) {
    return true;
  }
  if (/\bprocess\.env\s*\[[^\]]*BASE_URL[^\]]*\]/.test(source)) {
    return true;
  }
  if (/\{\s*(?:HOMEPAGE|BASE_URL)[\s\S]{0,40}\}\s*=\s*process\.env/.test(source)) {
    return true;
  }
  if (/process\.env[\s\S]{0,80}HOMEPAGE/.test(source)) {
    return true;
  }
  if (/throw new Error\([^)]*HOMEPAGE[^)]*\)/.test(source)) {
    return true;
  }
  return false;
}

function findSyntaxProblem(source: string): string | undefined {
  const scanned = scanUnterminatedDelimiters(source);
  if (scanned) {
    return scanned;
  }
  return compilerSyntaxProblem(source);
}

function compilerSyntaxProblem(source: string): string | undefined {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qa-generated-spec-"));
  const filePath = path.join(dir, "generated.spec.ts");
  try {
    writeFileSync(filePath, source, "utf8");
    const tsc = path.resolve(agentDir, "../../node_modules/typescript/bin/tsc");
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        "--ignoreConfig",
        "--noEmit",
        "--pretty",
        "false",
        "--skipLibCheck",
        "--noResolve",
        "--target",
        "ESNext",
        "--module",
        "ESNext",
        "--isolatedModules",
        filePath,
      ],
      { encoding: "utf8" }
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return firstTypeScriptSyntaxError(output);
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function firstTypeScriptSyntaxError(output: string): string | undefined {
  const match = output.match(/error TS(1\d{3}):\s*(.+)/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const message = match[2].trim();
  if (/unterminated string literal/i.test(message)) {
    return "unterminated string";
  }
  if (/unterminated template literal/i.test(message)) {
    return "unterminated template literal";
  }
  return `malformed TypeScript: ${message}`;
}

function scanUnterminatedDelimiters(source: string): string | undefined {
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  const stack: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quote === "`") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "`") {
        quote = undefined;
        continue;
      }
      if (char === "$" && next === "{") {
        stack.push("${");
        quote = undefined;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "/" && next === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        return "unterminated comment";
      }
      index = end + 1;
      continue;
    }

    if (char === "(" || char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === ")" || char === "}" || char === "]") {
      const open = stack.pop();
      if (open === "${" && char === "}") {
        quote = "`";
        continue;
      }
      if (!open || !matchesDelimiter(open, char)) {
        return `unbalanced ${char}`;
      }
    }
  }

  if (quote === "`") {
    return "unterminated template literal";
  }
  if (quote) {
    return "unterminated string";
  }
  if (stack.length > 0) {
    return `unbalanced ${stack[stack.length - 1]}`;
  }
  return undefined;
}

function matchesDelimiter(open: string, close: string): boolean {
  return (
    (open === "(" && close === ")") ||
    (open === "{" && close === "}") ||
    (open === "[" && close === "]")
  );
}

export function ensureOverlayHandling(source: string): string {
  let next = source;

  if (!/from\s+['"][^'"]*overlay\.js['"]/.test(next)) {
    next = insertAfterImports(next, `${OVERLAY_IMPORT}\n`);
  }

  if (/\bpreparePageForInteraction\s*\(/.test(next)) {
    return next;
  }

  const gotoEnd = endOfGotoStatement(next);
  if (gotoEnd === undefined) {
    return next;
  }

  const indent = indentAt(next, next.search(/\bpage\.goto\s*\(/));
  const block = overlayReadyBlock(indent);
  return `${next.slice(0, gotoEnd)}\n${block}${next.slice(gotoEnd)}`;
}

function overlayReadyBlock(indent: string): string {
  const lines = [
    `${indent}const overlay = await preparePageForInteraction(page);`,
    `${indent}if (!overlay.functionalTestContinued) {`,
    `${indent}  throw new Error(overlay.reason ?? "A blocking overlay could not be dismissed.");`,
    `${indent}}`,
  ];
  return lines.join("\n");
}

function indentAt(source: string, index: number): string {
  if (index < 0) {
    return "    ";
  }
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const match = source.slice(lineStart, index).match(/^[ \t]*/);
  return match?.[0] || "    ";
}

function endOfGotoStatement(source: string): number | undefined {
  const start = source.search(/\bpage\.goto\s*\(/);
  if (start < 0) {
    return undefined;
  }
  const openParen = source.indexOf("(", start);
  let cursor = closeBalanced(source, openParen);
  if (cursor < 0) {
    return undefined;
  }

  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }

  if (source.startsWith(".catch", cursor) || source.startsWith(".then", cursor)) {
    const nextParen = source.indexOf("(", cursor);
    cursor = closeBalanced(source, nextParen);
    if (cursor < 0) {
      return undefined;
    }
    while (cursor < source.length && /\s/.test(source[cursor])) {
      cursor += 1;
    }
  }

  if (source[cursor] === ";") {
    cursor += 1;
  }
  return cursor;
}

function closeBalanced(source: string, openIndex: number): number {
  if (openIndex < 0) {
    return -1;
  }

  let depth = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

function insertAfterImports(source: string, importBlock: string): string {
  const importPattern = /^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match = importPattern.exec(source);
  while (match) {
    lastMatch = match;
    match = importPattern.exec(source);
  }

  if (!lastMatch) {
    return `${importBlock}${source}`;
  }

  const insertAt = lastMatch.index + lastMatch[0].length;
  return `${source.slice(0, insertAt)}\n${importBlock}${source.slice(insertAt)}`;
}

function withIdentityHeader(
  source: string,
  requirementId: string,
  testCaseId: string
): string {
  const header = [
    "/**",
    " * Generated QA Automation spec.",
    ` * requirementId: ${requirementId}`,
    ` * testCaseId: ${testCaseId}`,
    " * Identity is requirementId + testCaseId. Do not reuse for another pair.",
    " */",
    "",
  ].join("\n");

  if (
    source.includes(`requirementId: ${requirementId}`) &&
    source.includes(`testCaseId: ${testCaseId}`)
  ) {
    return source.startsWith("/**") ? source : `${header}${source}`;
  }

  return `${header}${source}`;
}

function generationContract(
  requirementId: string,
  testCaseId: string,
  evidencePath: string,
  testCaseUrl?: string
): string {
  return `

## Playwright generation output

Return a single JSON object only. No markdown. No commentary.

{
  "source": string
}

\`source\` must be a complete Playwright TypeScript spec file.

Rules:

- Import from @playwright/test.
- This repository is ESM ("type": "module", TypeScript NodeNext). Generated specs must be ES modules.
- Never use CommonJS require(). require is not defined at Playwright runtime.
- For filesystem and path operations, use ES module imports only, for example:
  import { mkdirSync, writeFileSync } from "node:fs";
  import path from "node:path";
- Create the evidence directory if it does not exist, then write the file. Example:
  function writeEvidence(data: unknown): void {
    mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(EVIDENCE_PATH, JSON.stringify(data, null, 2), "utf8");
  }
- Do not include markdown fences.
- Do not include explanations outside the JSON object.
- The spec must be valid TypeScript.
- The spec will be written to tests/${requirementId}/${testCaseId}.spec.ts.
- If importing project modules, use paths valid from that nested location, for example ../../agents/qa-automation/scope.js.
- Overlay handling is mandatory and reusable. Import the helper and call it after every navigation:
  import { preparePageForInteraction } from "../../agents/qa-automation/overlay.js";
  const overlay = await preparePageForInteraction(page);
- UI discovery helpers are reusable. Import only the helpers this Test Case actually needs.
  import { findUserFacingControl, readFirstDisplayedItemTitle, readFirstVisibleDeal, submitSearch } from "../../agents/qa-automation/discover.js";
  Use submitSearch(page, query) only when THIS Test Case requires an explicit search interaction.
  Use readFirstVisibleDeal(page) only when THIS Test Case requires verifying a visible deal/result.
  Do not add search, deal discovery, or link collection because the product supports those features.
- Search is a text-entry interaction. submitSearch locates a text-entry control, fills the query, presses Enter, and waits for the resulting UI. A Search button is optional.
- Do not assume a control named "Search" is the search input. Do not fail if no Search button exists when Enter submits the query.
- Only click a search-submit control when the live UI requires it because Enter does not submit.
- kind "search-input" must be a text-entry control, not a Search button.
- kind "deal" / "search-result" and readFirstVisibleDeal identify actual Groupon deal/result cards whose destination is /deals/<slug> (query parameters allowed). They must not return a generic heading, "Results for" heading, first page link, first href, or first generic clickable.
- findUserFacingControl inspects the live UI (role, label, placeholder, text, name, id, test id, surrounding structure). A missed first strategy is not a functional failure.
- Link collection must use:
  import { listNavigableLinks, activateNavigableLink, restorePage, closeOpenedPageIfDifferent, recordLinkDestination, observePage } from "../../agents/qa-automation/interaction.js";
  const links = await listNavigableLinks(page, { limit: 10 });
  const activation = await activateNavigableLink(page, links[i].locator);
  const observation = await observePage(activation.page);
  const destination = recordLinkDestination({ href: links[i].href, originalUrl, finalUrl: observation.url, title: observation.title, bodyText: observation.bodyText, openedIn, navigationKind: activation.kind, reached: observation.pageOpen });
- listNavigableLinks excludes href="#", javascript:, mailto:, and tel:. Those are not destinations.
- activateNavigableLink never closes the original page. For in-page hrefs it uses noWaitAfter and does not wait for navigation. If a page closes, continue on the remaining open page.
- observePage and recordLinkDestination record navigation evidence. When the Test Case requires usable/meaningful destination content, validate that observed content. FAIL the item when the destination is blank or has no meaningful visible content. Do not compare href, originalUrl, pathname, or domain against finalUrl unless the Test Case specifies a destination.
- finalUrl, title, and body length/snippet are evidence. Do not infer an expected destination URL from the href unless the Test Case specifies one.
- Do not write kind FUNCTIONAL or TECHNICAL. PASSED/FAILED must come from Test Case validations and whether the journey could execute.
- After a popup, inspect activation.page, then await closeOpenedPageIfDifferent(page, activation.page). After same-tab navigation, await restorePage(page, originalUrl) before the next item.
- Never call page.close(), context.close(), or browser.close() on the original page/context/browser.
- Never call page.evaluate after the page is closed. If a helper cannot evaluate, continue with FAILED technical evidence instead of hanging.
- test.setTimeout must be high enough for the full Test Case (at least 120000ms for collection journeys). Do not leave the default 30000ms if that would close the browser mid-flow.
- readFirstVisibleDeal is the canonical helper for a first-displayed deal/result. It selects the first in-viewport /deals/<slug> card without scrolling and without using generic headings. If the Test Case names the expected first-result title, compare that observed title to the expected value and FAIL when they differ. Do not search later results to satisfy a first-displayed expected title.
- If the Test Case requires a named result to appear in the displayed results and does not limit the check to the first item, inspect the currently displayed results with listVisibleDeals and validate that the expected title is present. Do not replace that check with first-result-exists.
- The spec MUST include at least one explicit validation derived from the Test Case. Do not invent unrelated assertions.
- Do not add assertions for UI elements the Test Case does not require (extra nav, extra search widgets, extra content areas, invented page-health checks).
- Dynamic Test Case text (title, objective, preconditions, steps, expectedResult, queries, assertion messages) MUST be embedded with JSON.stringify quoting: double-quoted JavaScript strings with quotes, backticks, apostrophes, newlines, and backslashes escaped. Never wrap Test Case prose in a single-quoted JavaScript string or an unescaped template literal. Prefer TEST_CASE_TITLE and TEST_CASE_EXPECTED_RESULT constants when they are present.
- The spec must be syntactically valid TypeScript: no unterminated strings/templates, no invalid Playwright APIs, no undefined helpers.
- The spec must be complete and executable. Do not return truncated files, broken imports, or invalid test definitions.
- If a previous generation attempt failed validation, correct that defect. Do not remove, weaken, or bypass Test Case validations to make the source parse.
- preparePageForInteraction installs a page-wide modal guard. Later click/fill/press, keyboard.press, and later page.goto/reload on that page check for blocking modals automatically. Do not duplicate overlay logic in the spec.
- Optional withModalHandling(page, action) retries the original user action at most once after dismissing an intercepting modal.
- Evidence overlay fields: overlayDetected, dismissalAttempted, dismissalMethod, dismissalSucceeded, functionalTestContinued, overlayDescription, reason, retryRequired, occurrences.
- Do not duplicate overlay-detection logic in the spec. Do not hard-code product-specific overlay selectors.
- Do not use force: true or other pointer-event bypasses to click through an overlay.
- Include the overlay result on every evidence write as the "overlay" field.
- Evidence JSON must also include overlay:
  overlayDetected, dismissalAttempted, dismissalMethod ("click_outside" | "visible_dismiss_control" | "none"),
  dismissalSucceeded, functionalTestContinued, overlayDescription, reason.
- If preparePageForInteraction throws or overlay.functionalTestContinued is false:
  set status to "FAILED",
  set coverageStatus to "PARTIAL",
  record the technical overlay evidence,
  fail the Playwright test (throw). Do not write INCONCLUSIVE.
- A dismissed overlay is not a functional failure. Continue the original Test Case.
- Do not invent credentials, log in, create accounts, change location, select geographic values, perform business actions, or blindly click arbitrary elements to dismiss overlays.
- Hardcode these identity constants in the spec:
  const REQUIREMENT_ID = ${JSON.stringify(requirementId)};
  const TEST_CASE_ID = ${JSON.stringify(testCaseId)};
- Write JSON evidence to this exact path, or to process.env.EVIDENCE_PATH if set:
  ${JSON.stringify(evidencePath)}
- The spec and the Automation runner must use that same evidence path. Do not invent a second filename.
- Write evidence incrementally after discovery and after each collection item so a Playwright timeout still leaves a usable partial artifact.
- Evidence JSON must include:
  requirementId, testCaseId, status ("PASSED" | "FAILED"),
  coverageStatus ("COMPLETE" | "PARTIAL"), coverageNote, perLinkResults (array), failures (array),
  linksDiscovered, linksChecked, overlay.
- Never write status "INCONCLUSIVE". If the user journey could not be executed, status is FAILED with a reason describing what stopped execution.
- Report collection coverage explicitly: discovered, checked.
- failures items may include originalUrl, finalUrl, httpStatus, navigationError, reason. Do not write kind FUNCTIONAL or TECHNICAL.
- Navigate with resolveApplicationUrl from ../../agents/qa-automation/app-url.js.
  import { resolveApplicationUrl } from "../../agents/qa-automation/app-url.js";
  const APPLICATION_URL = resolveApplicationUrl(${testCaseUrl ? `{ testCaseUrl: ${JSON.stringify(testCaseUrl)} }` : ""});
  await page.goto(APPLICATION_URL);
- process.env.HOMEPAGE and process.env.BASE_URL are optional overrides inside resolveApplicationUrl. Never read them in generated source. Never throw if they are unset.
- Do not invent SEARCH_URL, APP_URL, credentials, CSS selectors, or ARIA roles as execution prerequisites.
- If the Test Case includes a URL, pass it as testCaseUrl. That URL takes precedence. If it refers to the homepage without a URL, use resolveApplicationUrl() so optional HOMEPAGE/BASE_URL or the Groupon project default is used.

User interaction:

- Activate user-facing controls with Playwright locator.click() (or equivalent Playwright user actions).
- Do not activate links with DOM-level (element as HTMLAnchorElement).click() inside page.evaluate().
- page.evaluate may be used only for read-only discovery or destination inspection, not to perform the required user action.
- Locate required controls with findUserFacingControl. Prefer getByRole only when it matches the actual element. If it does not, inspect the live UI and use another stable user-facing attribute. Do not fail solely because one locator strategy missed.
- Search input discovery must fill a text-entry control. Do not fill a Search button.
- Prefer submitSearch(page, query): fill the search input and press Enter. Do not require a Search button. Do not page.goto() a search results URL.
- After search, identify deals/results as rendered cards associated with /deals/<slug>. Do not treat a generic heading or the first page link as the first deal.
- Continue using the live page after search submit, navigation, or UI transition. Do not evaluate a closed page.
- Do not scroll or load additional results unless the Test Case requires it.
- Do not inspect items outside the Test Case scope (for example, do not search later results when only the first initially displayed item is in scope).
- If the Test Case names a specific expected title, entity, URL, or visible condition, validate that exact requirement. Do not replace it with page-loaded, any-result-exists, or first-result-exists.
- Do not hard-code PASSED or FAILED for a requirement id. Compute PASSED/FAILED from the Test Case validations at runtime.
- Handle same-tab navigation and new-tab/popup navigation correctly. Observe whichever actually occurs after the click. If a page/tab closes, continue on the remaining open page.
- After click, wait for the destination page that actually opened to reach a usable load state. Use a realistic navigation/load timeout such as 20 seconds.
- Do not start independent long waits for navigation, popup, and download and then Promise.all them.
- Click/activate is the primary action. Observe the first user-facing result that occurs (same-tab navigation, popup, download, in-page anchor, modal, or none).
- Keep the overall test timeout sufficient for the full collection. Do not silently test only a convenient subset.
- Continue testing remaining collection items after an individual item is FAILED whenever the browser remains usable.
- Never convert one collection Test Case into multiple Test Cases or multiple specs.
- For page-load Test Cases, assert a stable user-facing load signal from the Test Case (branding/logo or required content) after modal handling. Do not invent extra page-health checks.

Evidence and classification:

- Browser navigation / popup / visible destination is the primary evidence.
- HTTP/API/network/DOM information is supporting diagnostic evidence only. Record HTTP status when it is naturally produced by the browser interaction.
- Do not classify a destination as failed solely because an HTTP response is 4xx/5xx.
- Do not GET hrefs, call APIs, or treat HTTP 200 as proof instead of performing the required click/navigation/observation.
- After navigation, record the actual browser destination as evidence (finalUrl, title, body length/snippet, login/error page text if present) and apply the Test Case destination validation when the Test Case requires usable/meaningful content.
- When the Test Case requires destination usability/meaningful content, FAIL that item if the destination is blank or has no meaningful visible content. Do not fail solely because of a redirect, URL rewrite, or domain/path change unless the Test Case specifies the destination URL.
- Do not write kind FUNCTIONAL or TECHNICAL.
- Do not use generic body-text keyword matching as the sole pass/fail proof unless that keyword is the Test Case expected value.
- PASSED = the required user journey executed and every Test Case validation succeeded.
- FAILED = a required Test Case validation did not hold, or the generated Playwright test could not execute the user journey.
- Do not treat Playwright completing without an exception as PASSED.
- Evidence may include validationsSatisfied: true only after every Test Case-derived validation succeeded.
- Never write INCONCLUSIVE. The Reviewer reviews the Automation PASS/FAIL result and evidence and makes the final QA decision.
- Do not log in, create accounts, purchase, pay, or otherwise perform transactional actions.
- Do not add domain-specific exclusions.
- Do not copy tests/US-001/TC-001.spec.ts.
- Follow the functional steps and expected result. Do not add extra functional checks.
- Do not silently expand the Test Case into unrelated checks.
- Do not pre-assign PASSED or FAILED based on requirementId, testCaseId, or an expected title.
- The spec must represent the Test Case's user journey, not an implementation shortcut.
- If a negative/edge step cannot be set up from the test case data, fail with FAILED technical evidence instead of inventing test data.
`;
}

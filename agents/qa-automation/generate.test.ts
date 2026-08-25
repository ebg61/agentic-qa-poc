import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  analyzeTestCaseIntent,
  assertGeneratedSourceExecutable,
  ensureApplicationUrl,
  ensureDiscoverHandling,
  ensureInteractionHandling,
  ensureOverlayHandling,
  ensurePassFailOnly,
  generatePlaywrightSpec,
  normalizeGeneratedSource,
  toTypeScriptLiteral,
  stripProductJudgments,
} from "./generate.js";

test("generated specs cannot emit INCONCLUSIVE status strings", () => {
  const source = ensurePassFailOnly(`
    result.status = "INCONCLUSIVE";
    failures.push({ classification: "INCONCLUSIVE", reason: "blocked" });
    status: 'INCONCLUSIVE',
  `);

  assert.equal(source.includes("INCONCLUSIVE"), false);
  assert.match(source, /status = "FAILED"/);
  assert.match(source, /classification: "ENVIRONMENT_ISSUE"/);
  assert.match(source, /status: 'FAILED'/);
});

test("overlay handling is inserted after the first page.goto", () => {
  const source = ensureOverlayHandling(`
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  await page.getByRole("button", { name: "Search" }).click();
});
`);

  assert.match(source, /from ["'][^"']*overlay\.js["']/);
  assert.match(source, /await preparePageForInteraction\(page\)/);
  assert.doesNotMatch(source, /INCONCLUSIVE/);
  assert.equal(source.split("preparePageForInteraction").length - 1, 2);
});

test("existing overlay handling is not duplicated", () => {
  const original = `
import { test } from "@playwright/test";
import { preparePageForInteraction } from "../../agents/qa-automation/overlay.js";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const overlay = await preparePageForInteraction(page);
  await page.getByRole("textbox").fill("query");
});
`;
  const source = ensureOverlayHandling(original);
  assert.equal(
    source.split("preparePageForInteraction").length,
    original.split("preparePageForInteraction").length
  );
});

test("UI discovery helper import is inserted for generated specs", () => {
  const source = ensureDiscoverHandling(`
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`);

  assert.match(source, /from ["'][^"']*discover\.js["']/);
  assert.match(source, /findUserFacingControl/);
  assert.match(source, /readFirstDisplayedItemTitle/);
  assert.match(source, /readFirstVisibleDeal/);
  assert.match(source, /submitSearch/);
});

test("link interaction helper import is inserted for generated specs", () => {
  const source = ensureInteractionHandling(`
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`);

  assert.match(source, /from ["'][^"']*interaction\.js["']/);
  assert.match(source, /listNavigableLinks/);
  assert.match(source, /activateNavigableLink/);
});

test("link-validation specs import recordLinkDestination", () => {
  const source = ensureInteractionHandling(
    `
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`,
    [
      "listNavigableLinks",
      "activateNavigableLink",
      "restorePage",
      "closeOpenedPageIfDifferent",
      "recordLinkDestination",
    ]
  );

  assert.match(source, /recordLinkDestination/);
});

test("unterminated templates are rejected before execution", () => {
  assert.throws(
    () =>
      assertGeneratedSourceExecutable(`
import { test } from "@playwright/test";
test("broken", async ({ page }) => {
  const note = \`unterminated
});
`),
    /unterminated template literal/
  );
});

test("unterminated strings are rejected before execution", () => {
  assert.throws(
    () =>
      assertGeneratedSourceExecutable(`
import { test } from "@playwright/test";
test("broken", async ({ page }) => {
  const note = "unterminated
});
`),
    /unterminated string/
  );
});

test("malformed TypeScript is rejected before execution", () => {
  assert.throws(
    () =>
      assertGeneratedSourceExecutable(`
import { test } from "@playwright/test";
test("broken", async ({ page }) => {
  const note = {"oops";
});
`),
    /not executable/
  );
});

test("valid generated source is accepted as executable", () => {
  assert.doesNotThrow(() =>
    assertGeneratedSourceExecutable(`
import { test } from "@playwright/test";
test("ok", async ({ page }) => {
  const note = \`value \${page.url()}\`;
  await page.goto("https://www.groupon.com/");
});
`)
  );
});

test("missing HOMEPAGE is rewritten to the project application URL helper", () => {
  const source = ensureApplicationUrl(
    `
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  const homepage = process.env.HOMEPAGE;
  if (!homepage) {
    throw new Error("HOMEPAGE not provided. Set process.env.HOMEPAGE to the application's homepage URL.");
  }
  await page.goto(homepage);
});
`,
    { testCaseUrl: "https://www.groupon.com/" }
  );

  assert.match(source, /from ["'][^"']*app-url\.js["']/);
  assert.match(source, /const APPLICATION_URL = resolveApplicationUrl\(\{ testCaseUrl: "https:\/\/www\.groupon\.com\/" \}\)/);
  assert.doesNotMatch(source, /process\.env\.HOMEPAGE/);
  assert.doesNotMatch(source, /if\s*\(\s*!homepage\s*\)/);
  assert.doesNotMatch(source, /Missing HOMEPAGE/);
  assert.match(source, /await page\.goto\(homepage\)/);
  assert.match(source, /const homepage = APPLICATION_URL/);
});

test("multiline and destructured HOMEPAGE access is rewritten", () => {
  const source = ensureApplicationUrl(`
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  const { HOMEPAGE } = process.env;
  const other = process.env
    .HOMEPAGE;
  if (!process.env.HOMEPAGE) {
    throw new Error("Missing HOMEPAGE environment variable");
  }
  await page.goto(HOMEPAGE || other);
});
`);

  assert.doesNotMatch(source, /process\.env\.HOMEPAGE/);
  assert.doesNotMatch(source, /process\.env\s*\n\s*\.HOMEPAGE/);
  assert.doesNotMatch(source, /\{\s*HOMEPAGE\s*\}\s*=\s*process\.env/);
  assert.doesNotMatch(source, /Missing HOMEPAGE environment variable/);
  assert.match(source, /resolveApplicationUrl\(/);
});

test("intermediate process.env aliases are not treated as a HOMEPAGE prerequisite", () => {
  const source = ensureApplicationUrl(`
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  const env = process.env;
  const homepage = env.HOMEPAGE;
  if (!homepage) {
    throw new Error("Missing HOMEPAGE environment variable");
  }
  if (!process.env.HOMEPAGE?.trim()) {
    throw new Error("HOMEPAGE not provided");
  }
  await page.goto(homepage);
});
`);

  assert.doesNotMatch(source, /process\.env\.HOMEPAGE/);
  assert.doesNotMatch(source, /\benv\.HOMEPAGE\b/);
  assert.doesNotMatch(source, /Missing HOMEPAGE environment variable/);
  assert.doesNotMatch(source, /HOMEPAGE not provided/);
  assert.doesNotMatch(source, /(?:const|let|var)\s+env\s*=\s*process\.env/);
  assert.match(source, /const homepage = APPLICATION_URL/);
  assert.match(source, /resolveApplicationUrl\(/);
});

test("leftover mandatory HOMEPAGE access is rejected as non-executable", () => {
  assert.throws(
    () =>
      assertGeneratedSourceExecutable(`
import { test } from "@playwright/test";
test("bad", async ({ page }) => {
  if (!process.env.HOMEPAGE) {
    throw new Error("missing");
  }
  await page.goto(process.env.HOMEPAGE);
});
`),
    /process\.env\.HOMEPAGE/
  );
});

test("application URL helper is inserted when the spec has no HOMEPAGE check", () => {
  const source = ensureApplicationUrl(`
import { test } from "@playwright/test";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`);

  assert.match(source, /from ["'][^"']*app-url\.js["']/);
  assert.match(source, /const APPLICATION_URL = resolveApplicationUrl\(\)/);
});

test("existing application URL helper is not duplicated", () => {
  const original = `
import { test } from "@playwright/test";
import { resolveApplicationUrl } from "../../agents/qa-automation/app-url.js";

const APPLICATION_URL = resolveApplicationUrl();

test("example", async ({ page }) => {
  await page.goto(APPLICATION_URL);
});
`;
  const source = ensureApplicationUrl(original);
  assert.equal(
    source.split("resolveApplicationUrl(").length,
    original.split("resolveApplicationUrl(").length
  );
});

test("partial discover imports are expanded to the canonical helpers", () => {
  const source = ensureDiscoverHandling(`
import { test } from "@playwright/test";
import { findUserFacingControl } from "../../agents/qa-automation/discover.js";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`);

  assert.match(source, /readFirstVisibleDeal/);
  assert.match(source, /submitSearch/);
  assert.equal(source.split("discover.js").length - 1, 1);
});

test("duplicate discover imports are merged instead of skipped", () => {
  const source = ensureDiscoverHandling(`
import { test } from "@playwright/test";
import { findUserFacingControl } from "../../agents/qa-automation/discover.js";
import { submitSearch } from "../../agents/qa-automation/discover.js";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`);

  assert.match(source, /readFirstVisibleDeal/);
  assert.match(source, /findUserFacingControl/);
  assert.match(source, /submitSearch/);
  assert.equal(source.split("discover.js").length - 1, 1);
});

const searchDealTestCase = {
  id: "TC-001",
  requirementId: "REQ-SAMPLE",
  title: "Search and check the first visible deal",
  objective: "Search from the homepage and check the first visible deal title.",
  priority: "High",
  preconditions: ["User is anonymous."],
  steps: [
    "Open the application homepage.",
    "Search for dinner.",
    "Read the first visible deal title.",
  ],
  expectedResult: "The first visible deal title matches the Test Case expected title.",
  riskCovered: [],
};

const pageLoadTestCase = {
  id: "TC-002",
  requirementId: "REQ-SAMPLE",
  title: "Homepage loads for an anonymous user",
  objective: "Open the application homepage and observe recognizable content.",
  priority: "High",
  preconditions: ["User is anonymous."],
  steps: [
    "Open the application homepage.",
    "Observe recognizable branding or content.",
  ],
  expectedResult: "The homepage loads with recognizable content.",
  riskCovered: [],
};

test("generatePlaywrightSpec writes a spec that uses canonical helpers instead of obsolete search logic", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-automation-gen-"));
  const specPath = path.join(dir, "TC-001.spec.ts");
  const llmSource = `
import { test } from "@playwright/test";
import { findUserFacingControl } from "../../agents/qa-automation/discover.js";

test("search", async ({ page }) => {
  const env = process.env;
  const homepage = env.HOMEPAGE;
  if (!homepage) {
    throw new Error("Missing HOMEPAGE environment variable");
  }
  await page.goto(homepage);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByPlaceholder("Search").fill("dinner");
  await page.keyboard.press("Enter");
});
`;

  try {
    await generatePlaywrightSpec({
      requirementId: "REQ-SAMPLE",
      testCase: searchDealTestCase,
      specPath,
      evidencePath: path.join(dir, "evidence.json"),
      llm: {
        async completeJson() {
          return JSON.stringify({ source: llmSource });
        },
      },
    });

    const spec = await readFile(specPath, "utf8");
    assert.doesNotMatch(spec, /process\.env\.HOMEPAGE/);
    assert.doesNotMatch(spec, /process\.env\.BASE_URL/);
    assert.doesNotMatch(spec, /\benv\.HOMEPAGE\b/);
    assert.doesNotMatch(spec, /Missing HOMEPAGE environment variable/);
    assert.doesNotMatch(spec, /if\s*\(\s*!homepage\s*\)/);
    assert.match(spec, /resolveApplicationUrl\(/);
    assert.match(spec, /preparePageForInteraction/);
    assert.match(spec, /await submitSearch\(page, "dinner"\)/);
    assert.match(spec, /await readFirstVisibleDeal\(page\)/);
    assert.match(spec, /findUserFacingControl/);
    assert.match(spec, /submitSearch/);
    assert.match(spec, /readFirstVisibleDeal/);
    assert.equal(spec.split("discover.js").length - 1, 1);
    assert.doesNotMatch(spec, /getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*["']Search["']/);
    assert.doesNotMatch(spec, /getByPlaceholder\(\s*["']Search["']\)/);
    assert.doesNotMatch(spec, /keyboard\.press\(\s*["']Enter["']\)/);
    assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
    assert.doesNotMatch(spec, /locator\(["']a["']\)\.first\(/);
    assert.doesNotMatch(spec, /INCONCLUSIVE/);
    assertGeneratedSourceExecutable(spec, {
      search: true,
      firstDeal: true,
      linkCollection: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generatePlaywrightSpec does not rewrite an already valid search/deal spec", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-automation-valid-"));
  const specPath = path.join(dir, "TC-001.spec.ts");
  const llmSource = `
import { test } from "@playwright/test";
import { preparePageForInteraction } from "../../agents/qa-automation/overlay.js";
import { submitSearch, readFirstVisibleDeal } from "../../agents/qa-automation/discover.js";
import { resolveApplicationUrl } from "../../agents/qa-automation/app-url.js";

const APPLICATION_URL = resolveApplicationUrl();

test("search", async ({ page }) => {
  await page.goto(APPLICATION_URL);
  const overlay = await preparePageForInteraction(page);
  if (!overlay.functionalTestContinued) {
    throw new Error(overlay.reason ?? "A blocking overlay could not be dismissed.");
  }
  await submitSearch(page, "dinner");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
});
`;

  try {
    await generatePlaywrightSpec({
      requirementId: "REQ-SAMPLE",
      testCase: searchDealTestCase,
      specPath,
      evidencePath: path.join(dir, "evidence.json"),
      llm: {
        async completeJson() {
          return JSON.stringify({ source: llmSource });
        },
      },
    });

    const spec = await readFile(specPath, "utf8");
    assert.equal(spec.split("await submitSearch(").length - 1, 1);
    assert.equal(spec.split("await readFirstVisibleDeal(").length - 1, 1);
    assert.equal(spec.split("resolveApplicationUrl(").length - 1, 1);
    assert.equal(spec.split("preparePageForInteraction").length - 1, 2);
    assert.equal(spec.split("discover.js").length - 1, 1);
    assert.doesNotMatch(spec, /findUserFacingControl/);
    assert.doesNotMatch(spec, /listNavigableLinks/);
    assert.doesNotMatch(spec, /recordLinkDestination/);
    assert.doesNotMatch(spec, /process\.env\.HOMEPAGE/);
    assert.doesNotMatch(spec, /getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*["']Search["']/);
    assert.match(spec, /await submitSearch\(page, "dinner"\)/);
    assertGeneratedSourceExecutable(spec, {
      search: true,
      firstDeal: true,
      linkCollection: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generatePlaywrightSpec does not turn a page-load Test Case into a search test", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-automation-load-"));
  const specPath = path.join(dir, "TC-002.spec.ts");
  const llmSource = `
import { test } from "@playwright/test";

test("homepage loads", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`;

  try {
    await generatePlaywrightSpec({
      requirementId: "REQ-SAMPLE",
      testCase: pageLoadTestCase,
      specPath,
      evidencePath: path.join(dir, "evidence.json"),
      llm: {
        async completeJson() {
          return JSON.stringify({ source: llmSource });
        },
      },
    });

    const spec = await readFile(specPath, "utf8");
    assert.match(spec, /resolveApplicationUrl\(/);
    assert.match(spec, /preparePageForInteraction/);
    assert.doesNotMatch(spec, /submitSearch\s*\(/);
    assert.doesNotMatch(spec, /readFirstVisibleDeal\s*\(/);
    assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
    assert.doesNotMatch(spec, /recordLinkDestination/);
    assert.doesNotMatch(spec, /process\.env\.HOMEPAGE/);
    assert.doesNotMatch(spec, /getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*["']Search["']/);
    assertGeneratedSourceExecutable(spec);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizeGeneratedSource applies canonical search and deal helpers for search Test Cases", () => {
  const source = normalizeGeneratedSource(
    `
import { test } from "@playwright/test";
import { findUserFacingControl } from "../../agents/qa-automation/discover.js";

test("example", async ({ page }) => {
  const homepage = process.env.HOMEPAGE;
  if (!homepage) {
    throw new Error("Missing HOMEPAGE environment variable");
  }
  await page.goto(homepage);
  await page.getByRole("button", { name: "Search" }).click();
});
`,
    { testCase: searchDealTestCase }
  );

  assert.match(source, /await submitSearch\(page, "dinner"\)/);
  assert.match(source, /await readFirstVisibleDeal\(page\)/);
  assert.match(source, /resolveApplicationUrl\(/);
  assert.equal(source.split("discover.js").length - 1, 1);
  assert.doesNotMatch(source, /process\.env\.HOMEPAGE/);
  assert.doesNotMatch(source, /getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*["']Search["']/);
  assert.doesNotMatch(source, /listNavigableLinks\s*\(/);
  assert.doesNotMatch(source, /recordLinkDestination/);
});

test("normalizeGeneratedSource does not add search helpers to a page-load spec", () => {
  const source = normalizeGeneratedSource(
    `
import { test } from "@playwright/test";
test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`,
    { testCase: pageLoadTestCase }
  );

  assert.match(source, /resolveApplicationUrl\(/);
  assert.match(source, /preparePageForInteraction/);
  assert.doesNotMatch(source, /submitSearch/);
  assert.doesNotMatch(source, /readFirstVisibleDeal/);
  assert.doesNotMatch(source, /listNavigableLinks/);
  assert.doesNotMatch(source, /recordLinkDestination/);
  assert.doesNotMatch(source, /process\.env\.HOMEPAGE/);
});

test("page-load generation strips leftover generic link destination classification", () => {
  const source = normalizeGeneratedSource(
    `
import { test } from "@playwright/test";
import { recordLinkDestination } from "../../agents/qa-automation/interaction.js";

test("example", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  recordLinkDestination({ href: page.url(), finalUrl: page.url() });
});
`,
    { testCase: pageLoadTestCase }
  );

  assert.doesNotMatch(source, /recordLinkDestination\s*\(/);
});

const searchOnlyTestCase = {
  id: "TC-SEARCH",
  requirementId: "REQ-NEW",
  title: "Site search accepts a query",
  objective: "Confirm the site accepts a search query from the search field.",
  priority: "High",
  preconditions: ["The user is anonymous."],
  steps: [
    "Open the application homepage.",
    "Enter \"kitchen\" into the search field and submit.",
  ],
  expectedResult: "Search results UI is shown for the submitted query.",
  riskCovered: [],
};

const dealOnlyTestCase = {
  id: "TC-DEAL",
  requirementId: "REQ-NEW",
  title: "First visible deal card is identifiable",
  objective: "Verify the first visible deal/result card on the current page.",
  priority: "High",
  preconditions: ["The user is anonymous."],
  steps: ["Open the application.", "Read the first visible deal."],
  expectedResult: "The first visible deal card is identified from the rendered UI.",
  riskCovered: [],
};

const linkOnlyTestCase = {
  id: "TC-LINKS",
  requirementId: "REQ-NEW",
  title: "Customer-facing homepage links reach valid destinations",
  objective: "Validate applicable customer-facing homepage links.",
  priority: "High",
  preconditions: ["The user is anonymous."],
  steps: [
    "Open the homepage.",
    "Discover customer-facing links.",
    "Activate each applicable link and observe the destination.",
  ],
  expectedResult: "Applicable customer-facing links lead to a valid destination.",
  riskCovered: [],
};

const keywordOnlyTestCase = {
  id: "TC-WORDS",
  requirementId: "REQ-NEW",
  title: "Users can find relevant search results and deals",
  objective: "Confirm a visitor can look for offers after the homepage is available.",
  priority: "High",
  preconditions: ["The user is anonymous."],
  steps: [
    "Open the application homepage.",
    "Look for recognizable branding.",
  ],
  expectedResult:
    "The homepage loads. Search and deal features remain available for later use.",
  riskCovered: [],
};

const signInTestCase = {
  id: "TC-SIGNIN",
  requirementId: "REQ-ACCOUNT",
  title: "Sign-in control is reachable",
  objective: "A visitor can open the sign-in experience from the homepage.",
  priority: "High",
  preconditions: ["The user is anonymous."],
  steps: ["Open the homepage.", "Activate the Sign In control."],
  expectedResult: "A sign-in experience is presented.",
  riskCovered: [],
};

async function generateSpec(
  testCase: typeof pageLoadTestCase,
  llmSource: string
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-automation-intent-"));
  const specPath = path.join(dir, `${testCase.id}.spec.ts`);
  try {
    await generatePlaywrightSpec({
      requirementId: testCase.requirementId,
      testCase,
      specPath,
      evidencePath: path.join(dir, "evidence.json"),
      llm: {
        async completeJson() {
          return JSON.stringify({ source: llmSource });
        },
      },
    });
    return await readFile(specPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const outOfScopeLlmSource = `
import { test } from "@playwright/test";
import { submitSearch, readFirstVisibleDeal } from "../../agents/qa-automation/discover.js";
import { listNavigableLinks } from "../../agents/qa-automation/interaction.js";

test("generated", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  await submitSearch(page, "invented-query");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
  const links = await listNavigableLinks(page);
});
`;

test("search-only Test Cases use submitSearch with the Test Case query and do not add deal or link journeys", async () => {
  const spec = await generateSpec(
    searchOnlyTestCase,
    `
import { test } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  await page.getByRole("button", { name: "Search" }).click();
});
`
  );

  assert.match(spec, /await submitSearch\(page, "kitchen"\)/);
  assert.doesNotMatch(spec, /readFirstVisibleDeal\s*\(/);
  assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
  assert.doesNotMatch(spec, /recordLinkDestination/);
  assert.doesNotMatch(spec, /getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*["']Search["']/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(searchOnlyTestCase));
});

test("deal-only Test Cases use the canonical deal helper and do not invent search", async () => {
  const spec = await generateSpec(
    dealOnlyTestCase,
    `
import { test } from "@playwright/test";

test("deal", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const first = page.locator("a").first();
  await first.click();
});
`
  );

  assert.match(spec, /await readFirstVisibleDeal\(page\)/);
  assert.doesNotMatch(spec, /submitSearch\s*\(/);
  assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
  assert.doesNotMatch(spec, /recordLinkDestination/);
  assert.doesNotMatch(spec, /locator\(["']a["']\)\.first\(/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(dealOnlyTestCase));
});

test("link-validation Test Cases use link discovery and do not invent search or deal journeys", async () => {
  const spec = await generateSpec(
    linkOnlyTestCase,
    `
import { test } from "@playwright/test";

test("links", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`
  );

  assert.match(spec, /listNavigableLinks\s*\(/);
  assert.match(spec, /recordLinkDestination/);
  assert.match(spec, /observePage/);
  assert.doesNotMatch(spec, /submitSearch\s*\(/);
  assert.doesNotMatch(spec, /readFirstVisibleDeal\s*\(/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(linkOnlyTestCase));
});

test("keyword-only Test Cases do not activate search, deal, or link journeys", async () => {
  const spec = await generateSpec(keywordOnlyTestCase, outOfScopeLlmSource);

  assert.doesNotMatch(spec, /submitSearch\s*\(/);
  assert.doesNotMatch(spec, /readFirstVisibleDeal\s*\(/);
  assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
  assert.doesNotMatch(spec, /recordLinkDestination/);
  assert.doesNotMatch(spec, /invented-query/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(keywordOnlyTestCase));
});

test("product context does not expand a page-load Test Case with unrelated journeys", async () => {
  const spec = await generateSpec(pageLoadTestCase, outOfScopeLlmSource);

  assert.doesNotMatch(spec, /submitSearch\s*\(/);
  assert.doesNotMatch(spec, /readFirstVisibleDeal\s*\(/);
  assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
  assert.doesNotMatch(spec, /recordLinkDestination/);
  assert.match(spec, /preparePageForInteraction/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(pageLoadTestCase));
});

test("a completely new Test Case is generated from that Test Case without previous-journey assumptions", async () => {
  const spec = await generateSpec(signInTestCase, outOfScopeLlmSource);

  assert.doesNotMatch(spec, /submitSearch\s*\(/);
  assert.doesNotMatch(spec, /readFirstVisibleDeal\s*\(/);
  assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
  assert.doesNotMatch(spec, /recordLinkDestination/);
  assert.match(spec, /preparePageForInteraction/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(signInTestCase));
});

test("out-of-scope helper calls are rejected when they survive normalization", () => {
  assert.throws(
    () =>
      assertGeneratedSourceExecutable(
        `
import { test } from "@playwright/test";
test("ok", async ({ page }) => {
  await submitSearch(page, "x");
});
`,
        { search: false, firstDeal: false, linkCollection: false }
      ),
    /does not require/
  );
});

test("JSON.stringify encodes quotes, apostrophes, backticks, and newlines for TypeScript literals", () => {
  assert.equal(toTypeScriptLiteral("tester's homepage"), `"tester's homepage"`);
  assert.equal(toTypeScriptLiteral('says "hello"'), `"says \\"hello\\""`);
  assert.equal(toTypeScriptLiteral("uses `search`"), `"uses \`search\`"`);
  assert.equal(toTypeScriptLiteral("line one\nline two"), `"line one\\nline two"`);
  assert.equal(
    toTypeScriptLiteral("https://www.groupon.com/"),
    `"https://www.groupon.com/"`
  );
});

test("Test Case wording with quotes and apostrophes becomes valid executable TypeScript", async () => {
  const quotedTestCase = {
    id: "TC-QUOTES",
    requirementId: "REQ-QUOTES",
    title:
      "Anonymous user searches 'massage' and verifies the \"first\" deal title",
    objective:
      "Confirm the tester's homepage and `search` input still work (click/tap).",
    priority: "High",
    preconditions: [
      "Homepage URL is reachable in the tester's environment.",
      "Network is stable: https://www.groupon.com/",
    ],
    steps: [
      "Open the homepage (anonymous).",
      "Activate the control: Search.",
      "Observe the destination's user-facing behavior.",
    ],
    expectedResult:
      "PASS — destination displays meaningful content; FAIL if it doesn't. AUTH_REQUIRED is recorded.",
    riskCovered: [],
  };

  const llmSource = `
import { test } from "@playwright/test";

test('Anonymous user searches 'massage' and verifies the "first" deal title', async ({ page }) => {
  const expected = 'PASS — destination displays meaningful content; FAIL if it doesn't. AUTH_REQUIRED is recorded.';
  const note = \`Confirm the tester's homepage and \`search\` input still work (click/tap).\`;
  await page.goto("https://www.groupon.com/");
});
`;

  const spec = await generateSpec(quotedTestCase, llmSource);
  assert.match(spec, /const TEST_CASE_TITLE = /);
  assert.match(spec, /TEST_CASE_TITLE/);
  assert.match(spec, /tester's homepage/);
  assert.match(spec, /https:\/\/www\.groupon\.com\//);
  assert.doesNotMatch(
    spec,
    /test\('Anonymous user searches 'massage'/
  );
  assertGeneratedSourceExecutable(
    spec,
    analyzeTestCaseIntent(quotedTestCase)
  );
});

test("intentionally malformed generated source is not persisted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-automation-invalid-"));
  const specPath = path.join(dir, "TC-BAD.spec.ts");
  try {
    await assert.rejects(
      () =>
        generatePlaywrightSpec({
          requirementId: "REQ-BAD",
          testCase: pageLoadTestCase,
          specPath,
          evidencePath: path.join(dir, "evidence.json"),
          llm: {
            async completeJson() {
              return JSON.stringify({
                source: `
import { test } from "@playwright/test";
test("broken
`,
              });
            },
          },
        }),
      /not executable|unterminated/
    );
    await assert.rejects(() => readFile(specPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stored Analyst Test Case text with apostrophes generates valid TypeScript", async () => {
  const stored = JSON.parse(
    await readFile(
      path.resolve("test-cases/US-001/TC-001.json"),
      "utf8"
    )
  ) as typeof pageLoadTestCase;
  const title = stored.title;
  const expected = stored.expectedResult;
  const precondition =
    stored.preconditions.find((value) => value.includes("'")) ??
    stored.preconditions[0];
  const step =
    stored.steps.find((value) => value.includes("'")) ?? stored.steps[0];
  const llmSource = `
import { test } from "@playwright/test";
test('${title}', async ({ page }) => {
  const expected = '${expected}';
  const pre = '${precondition}';
  const step = '${step}';
  await page.goto("https://www.groupon.com/");
});
`;
  const spec = await generateSpec(stored, llmSource);
  assert.match(spec, /const TEST_CASE_TITLE = /);
  assert.match(spec, /TEST_CASE_TITLE/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(stored));
});

test("product judgment fields are stripped from generated source", () => {
  const source = stripProductJudgments(`
    failures.push({ reason: "title mismatch", kind: "FUNCTIONAL" });
    failures.push({ kind: "TECHNICAL", reason: "timeout" });
    const outcome = "usable";
    observedOutcome: "authentication_required",
    status: "FAILED",
  `);

  assert.doesNotMatch(source, /kind:\s*["']FUNCTIONAL["']/);
  assert.doesNotMatch(source, /kind:\s*["']TECHNICAL["']/);
  assert.doesNotMatch(source, /authentication_required/);
  assert.match(source, /const outcome = "usable"/);
  assert.match(source, /failures\.push\(\{ reason: "title mismatch" \}\)/);
  assert.match(source, /failures\.push\(\{\s*reason: "timeout" \}\)/);
});

test("normalizeGeneratedSource records observations without product classification", () => {
  const source = normalizeGeneratedSource(
    `
import { test } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const firstVisibleDeal = { text: "Visible First Deal" };
  const expected = "A different expected title";
  failures.push({ reason: "title mismatch", kind: "FUNCTIONAL" });
  observedOutcome: "authentication_required";
  let outcome = "broken_unusable";
});
`,
    { testCase: searchDealTestCase }
  );

  assert.doesNotMatch(source, /kind:\s*["']FUNCTIONAL["']/);
  assert.doesNotMatch(source, /kind:\s*["']TECHNICAL["']/);
  assert.doesNotMatch(source, /authentication_required/);
  assert.doesNotMatch(source, /broken_unusable/);
  assert.match(source, /submitSearch/);
  assert.match(source, /readFirstVisibleDeal/);
});

const specificFirstDealTestCase = {
  id: "TC-SPECIFIC",
  requirementId: "REQ-NEW",
  title:
    "Anonymous user searches 'spa' and verifies the first displayed deal is 'Sunset Spa Package'",
  objective:
    "Search from the homepage and verify the first displayed deal title is 'Sunset Spa Package'.",
  priority: "High",
  preconditions: ["The user is anonymous."],
  steps: [
    "Open the application homepage.",
    "Enter 'spa' into the search field and submit.",
    "Identify the first deal displayed without scrolling.",
    "Compare its visible title exactly to 'Sunset Spa Package'.",
  ],
  expectedResult:
    "The first deal visible without scrolling has the exact title 'Sunset Spa Package'. FAIL if the first visible title differs.",
  riskCovered: [],
};

test("a Test Case with a specific expected result generates a validation for that result", async () => {
  const spec = await generateSpec(
    specificFirstDealTestCase,
    `
import { test } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  await submitSearch(page, "spa");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
  expect(firstVisibleDeal).toBeTruthy();
});
`
  );

  assert.match(spec, /TEST_CASE_EXPECTED_VISIBLE_RESULT/);
  assert.match(spec, /Sunset Spa Package/);
  assert.match(spec, /assertObservedMatchesExpected/);
  assert.doesNotMatch(spec, /expect\(\s*firstVisibleDeal\s*\)\.toBeTruthy/);
  assert.match(spec, /preparePageForInteraction/);
  assertGeneratedSourceExecutable(
    spec,
    analyzeTestCaseIntent(specificFirstDealTestCase),
    specificFirstDealTestCase
  );
});

test("a generic first-result-exists assertion is not used when the Test Case requires a specific result", async () => {
  const spec = await generateSpec(
    specificFirstDealTestCase,
    `
import { test } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
  expect(firstVisibleDeal).toBeDefined();
});
`
  );

  assert.match(spec, /assertObservedMatchesExpected/);
  assert.match(spec, /TEST_CASE_EXPECTED_VISIBLE_RESULT/);
  assert.doesNotMatch(spec, /toBeDefined\(\)/);
  assert.doesNotMatch(spec, /toBeTruthy\(\)/);
});

test("existing overlay handling remains in specs that validate a specific result", async () => {
  const spec = await generateSpec(
    specificFirstDealTestCase,
    `
import { test } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`
  );

  assert.match(spec, /preparePageForInteraction/);
  assert.match(spec, /assertObservedMatchesExpected/);
});

test("US-001 destination usability validation is preserved for generated link journeys", async () => {
  const stored = JSON.parse(
    await readFile(path.resolve("test-cases/US-001/TC-001.json"), "utf8")
  ) as typeof pageLoadTestCase & { testCaseId?: string };
  const us001 = {
    ...stored,
    id: stored.id ?? stored.testCaseId ?? "TC-001",
  };
  const spec = await generateSpec(
    us001,
    `
import { test } from "@playwright/test";
import { listNavigableLinks, activateNavigableLink, observePage, recordLinkDestination, restorePage, closeOpenedPageIfDifferent } from "../../agents/qa-automation/interaction.js";
import { preparePageForInteraction } from "../../agents/qa-automation/overlay.js";

test("links", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const overlay = await preparePageForInteraction(page);
  const links = await listNavigableLinks(page, { limit: 10 });
  const originalUrl = page.url();
  for (const item of links) {
    const activation = await activateNavigableLink(page, item.locator);
    const observed = await observePage(activation.page);
    const destination = recordLinkDestination({ href: item.href, originalUrl, finalUrl: observed.url, title: observed.title, bodyText: observed.bodyText, navigationKind: activation.kind, reached: observed.pageOpen });
    await closeOpenedPageIfDifferent(page, activation.page);
    if (activation.kind === "same-tab") {
      await restorePage(page, originalUrl);
    }
  }
});
`
  );

  assert.match(spec, /listNavigableLinks/);
  assert.match(spec, /limit:\s*10/);
  assert.match(spec, /activateNavigableLink/);
  assert.match(spec, /observePage|recordLinkDestination/);
  assert.match(spec, /destinationHasMeaningfulContent/);
  assert.match(spec, /preparePageForInteraction/);
  assert.doesNotMatch(spec, /kind:\s*["']FUNCTIONAL["']/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(us001), us001);
});

test("US-003 host and recognizable content validation is preserved for generated page-load journeys", async () => {
  const stored = JSON.parse(
    await readFile(path.resolve("test-cases/US-003/TC-001.json"), "utf8")
  ) as typeof pageLoadTestCase & { testCaseId?: string };
  const us003 = {
    ...stored,
    id: stored.id ?? stored.testCaseId ?? "TC-001",
  };
  const spec = await generateSpec(
    us003,
    `
import { test } from "@playwright/test";
import { preparePageForInteraction } from "../../agents/qa-automation/overlay.js";

test("homepage", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const overlay = await preparePageForInteraction(page);
});
`
  );

  assert.match(spec, /assertHostMatchesExpected/);
  assert.match(spec, /groupon\.com/);
  assert.match(spec, /assertRecognizableContent/);
  assert.match(spec, /preparePageForInteraction/);
  assert.doesNotMatch(spec, /submitSearch\s*\(/);
  assert.doesNotMatch(spec, /listNavigableLinks\s*\(/);
  assertGeneratedSourceExecutable(spec, analyzeTestCaseIntent(us003), us003);
});

test("a generated spec that only navigates is not a successful Test Case validation", () => {
  assert.throws(
    () =>
      assertGeneratedSourceExecutable(
        `
import { test } from "@playwright/test";
test("homepage", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`,
        analyzeTestCaseIntent(pageLoadTestCase),
        pageLoadTestCase
      ),
    /Test Case-derived validation/
  );
});

test("a page-load Test Case generates observable page validations rather than navigation alone", async () => {
  const spec = await generateSpec(
    pageLoadTestCase,
    `
import { test } from "@playwright/test";
test("homepage", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`
  );

  assert.match(spec, /assertPageNotBlank/);
  assert.match(spec, /preparePageForInteraction/);
  assert.doesNotMatch(spec, /submitSearch\s*\(/);
  assertGeneratedSourceExecutable(
    spec,
    analyzeTestCaseIntent(pageLoadTestCase),
    pageLoadTestCase
  );
});

test("overlay dismissal does not replace the Test Case validation", async () => {
  const spec = await generateSpec(
    specificFirstDealTestCase,
    `
import { test } from "@playwright/test";
import { preparePageForInteraction } from "../../agents/qa-automation/overlay.js";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const overlay = await preparePageForInteraction(page);
});
`
  );

  assert.match(spec, /preparePageForInteraction/);
  assert.match(spec, /assertObservedMatchesExpected/);
  assert.match(spec, /Sunset Spa Package/);
  assert.doesNotMatch(spec, /toBeTruthy\(\)/);
});

test("a first-displayed expected result is not accepted from a later match", async () => {
  const spec = await generateSpec(
    specificFirstDealTestCase,
    `
import { test } from "@playwright/test";
import { listVisibleDeals } from "../../agents/qa-automation/discover.js";
import { assertVisibleResultsIncludeTitle } from "../../agents/qa-automation/validation.js";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const visibleDeals = await listVisibleDeals(page);
  assertVisibleResultsIncludeTitle(visibleDeals, "Sunset Spa Package");
});
`
  );

  assert.match(spec, /readFirstVisibleDeal/);
  assert.match(spec, /assertObservedMatchesExpected/);
  assert.doesNotMatch(spec, /assertVisibleResultsIncludeTitle\s*\(/);
});

test("a Playwright expect comparison is not treated as a missing Test Case validation", async () => {
  const spec = await generateSpec(
    specificFirstDealTestCase,
    `
import { test, expect } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  await submitSearch(page, "spa");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
  expect(firstVisibleDeal.title).toBe("Sunset Spa Package");
});
`
  );

  assert.match(spec, /assertObservedMatchesExpected/);
  assert.match(spec, /TEST_CASE_EXPECTED_VISIBLE_RESULT/);
  assert.match(spec, /Sunset Spa Package/);
  assertGeneratedSourceExecutable(
    spec,
    analyzeTestCaseIntent(specificFirstDealTestCase),
    specificFirstDealTestCase
  );
});

test("generation succeeds for a concrete expected result even when that result may be absent at runtime", async () => {
  const spec = await generateSpec(
    specificFirstDealTestCase,
    `
import { test } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  await submitSearch(page, "spa");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
});
`
  );

  assert.match(spec, /assertObservedMatchesExpected/);
  assert.match(spec, /Sunset Spa Package/);
  assert.doesNotMatch(spec, /toBeTruthy\(\)/);
  assertGeneratedSourceExecutable(
    spec,
    analyzeTestCaseIntent(specificFirstDealTestCase),
    specificFirstDealTestCase
  );
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  evaluateGeneratedCandidate,
  generatePlaywrightSpec,
  MAX_GENERATION_ATTEMPTS,
} from "./generate.js";

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

const specificResultTestCase = {
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

const validPageLoadSource = `
import { test } from "@playwright/test";

test("homepage", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
});
`;

function llmJson(source: string): string {
  return JSON.stringify({ source });
}

async function withTempSpec(
  run: (specPath: string, evidencePath: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-automation-recovery-"));
  const specPath = path.join(dir, "TC-REC.spec.ts");
  try {
    await run(specPath, path.join(dir, "evidence.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an invalid generated spec triggers regeneration with the validation problem", async () => {
  const prompts: string[] = [];
  let calls = 0;

  await withTempSpec(async (specPath, evidencePath) => {
    await generatePlaywrightSpec({
      requirementId: "REQ-SAMPLE",
      testCase: pageLoadTestCase,
      specPath,
      evidencePath,
      llm: {
        async completeJson(_system: string, userPrompt: string) {
          calls += 1;
          prompts.push(userPrompt);
          if (calls === 1) {
            return llmJson(`
import { test } from "@playwright/test";
test("broken
`);
          }
          return llmJson(validPageLoadSource);
        },
      },
    });

    const spec = await readFile(specPath, "utf8");
    assert.match(spec, /from ["']@playwright\/test["']/);
    assert.match(spec, /preparePageForInteraction/);
  });

  assert.equal(calls, 2);
  assert.match(prompts[1] ?? "", /Validation problem from the previous attempt/);
  assert.match(prompts[1] ?? "", /Previous generated source/);
  assert.equal(
    (prompts[1] ?? "").includes("Do not remove, weaken, or bypass required Test Case validations"),
    true
  );
});

test("a successfully regenerated spec is validated again before it is persisted", async () => {
  const first = evaluateGeneratedCandidate(
    llmJson(`
import { test } from "@playwright/test";
test("broken
`),
    { requirementId: "REQ-SAMPLE", testCase: pageLoadTestCase }
  );
  assert.equal(first.ok, false);

  await withTempSpec(async (specPath, evidencePath) => {
    const prompts: string[] = [];
    await generatePlaywrightSpec({
      requirementId: "REQ-SAMPLE",
      testCase: pageLoadTestCase,
      specPath,
      evidencePath,
      llm: {
        async completeJson(_system: string, userPrompt: string) {
          prompts.push(userPrompt);
          if (prompts.length === 1) {
            return llmJson(`
import { test } from "@playwright/test";
test("broken
`);
          }
          return llmJson(validPageLoadSource);
        },
      },
    });

    const spec = await readFile(specPath, "utf8");
    const second = evaluateGeneratedCandidate(llmJson(spec), {
      requirementId: "REQ-SAMPLE",
      testCase: pageLoadTestCase,
    });
    assert.equal(second.ok, true);
    assert.equal((prompts[1] ?? "").includes(first.problem), true);
  });
});

test("an invalid final result is never persisted as a successful automation", async () => {
  let calls = 0;

  await withTempSpec(async (specPath, evidencePath) => {
    await assert.rejects(
      () =>
        generatePlaywrightSpec({
          requirementId: "REQ-SAMPLE",
          testCase: pageLoadTestCase,
          specPath,
          evidencePath,
          llm: {
            async completeJson() {
              calls += 1;
              return llmJson(`
import { test } from "@playwright/test";
test("broken
`);
            },
          },
        }),
      /invalid after \d+ generation attempts/
    );
    await assert.rejects(() => readFile(specPath, "utf8"));
  });

  assert.equal(calls, MAX_GENERATION_ATTEMPTS);
});

test("an invalid final result is never executed", async () => {
  await withTempSpec(async (specPath, evidencePath) => {
    await assert.rejects(
      () =>
        generatePlaywrightSpec({
          requirementId: "REQ-SAMPLE",
          testCase: pageLoadTestCase,
          specPath,
          evidencePath,
          llm: {
            async completeJson() {
              return llmJson(`
import { test } from "@playwright/test";
test("broken
`);
            },
          },
        }),
      /invalid after \d+ generation attempts/
    );
  });
});

test("recovery is bounded and cannot loop indefinitely", async () => {
  let calls = 0;

  await withTempSpec(async (specPath, evidencePath) => {
    await assert.rejects(
      () =>
        generatePlaywrightSpec({
          requirementId: "REQ-SAMPLE",
          testCase: pageLoadTestCase,
          specPath,
          evidencePath,
          llm: {
            async completeJson() {
              calls += 1;
              return "this is not json";
            },
          },
        }),
      /invalid after \d+ generation attempts/
    );
  });

  assert.equal(calls, MAX_GENERATION_ATTEMPTS);
  assert.ok(MAX_GENERATION_ATTEMPTS >= 2);
  assert.ok(MAX_GENERATION_ATTEMPTS < 20);
});

test("Test Case validations are preserved during regeneration", async () => {
  await withTempSpec(async (specPath, evidencePath) => {
    let calls = 0;
    await generatePlaywrightSpec({
      requirementId: "REQ-NEW",
      testCase: specificResultTestCase,
      specPath,
      evidencePath,
      llm: {
        async completeJson() {
          calls += 1;
          if (calls === 1) {
            return llmJson(`
import { test } from "@playwright/test";
test("broken
`);
          }
          return llmJson(`
import { test } from "@playwright/test";

test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
  expect(firstVisibleDeal).toBeTruthy();
});
`);
        },
      },
    });

    const spec = await readFile(specPath, "utf8");
    assert.equal(calls, 2);
    assert.match(spec, /assertObservedMatchesExpected/);
    assert.match(spec, /Sunset Spa Package/);
    assert.match(spec, /preparePageForInteraction/);
    assert.doesNotMatch(spec, /toBeTruthy\(\)/);
  });
});

test("valid generated specs are not unnecessarily regenerated", async () => {
  let calls = 0;

  await withTempSpec(async (specPath, evidencePath) => {
    await generatePlaywrightSpec({
      requirementId: "REQ-SAMPLE",
      testCase: pageLoadTestCase,
      specPath,
      evidencePath,
      llm: {
        async completeJson() {
          calls += 1;
          return llmJson(validPageLoadSource);
        },
      },
    });

    await readFile(specPath, "utf8");
  });

  assert.equal(calls, 1);
});

test("a semantic Playwright expect comparison is repaired and persisted without regeneration", async () => {
  let calls = 0;

  await withTempSpec(async (specPath, evidencePath) => {
    await generatePlaywrightSpec({
      requirementId: "REQ-NEW",
      testCase: specificResultTestCase,
      specPath,
      evidencePath,
      llm: {
        async completeJson() {
          calls += 1;
          return llmJson(`
import { test, expect } from "@playwright/test";
test("search", async ({ page }) => {
  await page.goto("https://www.groupon.com/");
  await submitSearch(page, "spa");
  const firstVisibleDeal = await readFirstVisibleDeal(page);
  expect(firstVisibleDeal.title).toBe("Sunset Spa Package");
});
`);
        },
      },
    });

    const spec = await readFile(specPath, "utf8");
    assert.match(spec, /assertObservedMatchesExpected/);
    assert.match(spec, /Sunset Spa Package/);
    assert.doesNotMatch(spec, /toBeTruthy\(\)/);
  });

  assert.equal(calls, 1);
});

test("evaluateGeneratedCandidate rejects malformed source without treating it as success", () => {
  const result = evaluateGeneratedCandidate(
    llmJson(`
import { test } from "@playwright/test";
test("broken
`),
    { requirementId: "REQ-SAMPLE", testCase: pageLoadTestCase }
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.problem, /./);
  }
});

test("evaluateGeneratedCandidate accepts a valid page-load spec after normalization", () => {
  const result = evaluateGeneratedCandidate(llmJson(validPageLoadSource), {
    requirementId: "REQ-SAMPLE",
    testCase: pageLoadTestCase,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.spec, /preparePageForInteraction/);
  }
});

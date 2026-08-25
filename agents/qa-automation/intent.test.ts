import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalystTestCase } from "./analysis.js";
import { analyzeTestCaseIntent, extractSearchQuery } from "./intent.js";

function testCase(
  partial: Partial<AnalystTestCase> & Pick<AnalystTestCase, "title" | "steps" | "expectedResult">
): AnalystTestCase {
  return {
    id: partial.id ?? "TC-NEW",
    requirementId: partial.requirementId ?? "REQ-NEW",
    title: partial.title,
    objective: partial.objective ?? partial.title,
    priority: partial.priority ?? "High",
    preconditions: partial.preconditions ?? ["The user is anonymous."],
    steps: partial.steps,
    expectedResult: partial.expectedResult,
    riskCovered: partial.riskCovered ?? [],
  };
}

test("page-load intent does not require search, deal discovery, or link collection", () => {
  const intent = analyzeTestCaseIntent(
    testCase({
      title: "Homepage loads for an anonymous user",
      objective: "Open the application homepage and observe recognizable content.",
      steps: [
        "Open the application homepage.",
        "Observe recognizable branding or content.",
      ],
      expectedResult: "The homepage loads with recognizable content.",
    })
  );

  assert.equal(intent.search, false);
  assert.equal(intent.firstDeal, false);
  assert.equal(intent.linkCollection, false);
});

test("explicit search interaction is required only when the journey performs a search", () => {
  const testCaseBody = testCase({
    title: "Site search accepts a query",
    objective: "Confirm the site accepts a search query from the search field.",
    steps: [
      "Open the application homepage.",
      "Enter \"kitchen\" into the search field and submit.",
    ],
    expectedResult: "Search results UI is shown for the submitted query.",
  });
  const intent = analyzeTestCaseIntent(testCaseBody);

  assert.equal(intent.search, true);
  assert.equal(intent.firstDeal, false);
  assert.equal(intent.linkCollection, false);
  assert.equal(extractSearchQuery(testCaseBody), "kitchen");
});

test("visible deal verification is required without inventing a search", () => {
  const intent = analyzeTestCaseIntent(
    testCase({
      title: "First visible deal card is identifiable",
      objective: "Verify the first visible deal/result card on the current page.",
      steps: ["Open the application.", "Read the first visible deal."],
      expectedResult: "The first visible deal card is identified from the rendered UI.",
    })
  );

  assert.equal(intent.search, false);
  assert.equal(intent.firstDeal, true);
  assert.equal(intent.linkCollection, false);
});

test("link validation is required without inventing search or deal discovery", () => {
  const intent = analyzeTestCaseIntent(
    testCase({
      title: "Customer-facing homepage links reach valid destinations",
      objective: "Validate applicable customer-facing homepage links.",
      steps: [
        "Open the homepage.",
        "Discover customer-facing links.",
        "Activate each applicable link and observe the destination.",
      ],
      expectedResult: "Applicable customer-facing links lead to a valid destination.",
    })
  );

  assert.equal(intent.search, false);
  assert.equal(intent.firstDeal, false);
  assert.equal(intent.linkCollection, true);
});

test("keywords such as search, find, result, or deal do not activate a journey by themselves", () => {
  const intent = analyzeTestCaseIntent(
    testCase({
      title: "Users can find relevant search results and deals",
      objective:
        "Confirm a visitor can look for offers after the homepage is available.",
      steps: [
        "Open the application homepage.",
        "Look for recognizable branding.",
      ],
      expectedResult:
        "The homepage loads. Search and deal features remain available for later use.",
    })
  );

  assert.equal(intent.search, false);
  assert.equal(intent.firstDeal, false);
  assert.equal(intent.linkCollection, false);
});

test("a new unrelated Test Case is classified from that Test Case alone", () => {
  const intent = analyzeTestCaseIntent(
    testCase({
      id: "TC-SIGNIN",
      requirementId: "REQ-ACCOUNT",
      title: "Sign-in control is reachable",
      objective: "A visitor can open the sign-in experience from the homepage.",
      steps: ["Open the homepage.", "Activate the Sign In control."],
      expectedResult: "A sign-in experience is presented.",
    })
  );

  assert.equal(intent.search, false);
  assert.equal(intent.firstDeal, false);
  assert.equal(intent.linkCollection, false);
});

test("clicking a Deals link is navigation, not deal-card discovery", () => {
  const intent = analyzeTestCaseIntent(
    testCase({
      title: "Deals navigation is available",
      objective: "Open the Deals destination from the homepage.",
      steps: ["Open the homepage.", "Click the Deals link."],
      expectedResult: "The Deals destination is presented.",
    })
  );

  assert.equal(intent.search, false);
  assert.equal(intent.firstDeal, false);
  assert.equal(intent.linkCollection, false);
});

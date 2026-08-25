import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalystTestCase } from "./analysis.js";
import {
  assertObservedMatchesExpected,
  destinationHasMeaningfulContent,
  firstDisplayedMatchesExpected,
  hostMatchesExpected,
  observedMatchesExpected,
  pageShowsExpectedText,
  pageShowsRecognizableContent,
  requiredValidations,
  visibleResultsIncludeTitle,
} from "./validation.js";

function testCase(
  partial: Partial<AnalystTestCase> &
    Pick<AnalystTestCase, "title" | "steps" | "expectedResult">
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

test("a specific first-displayed title is extracted from the Test Case", () => {
  const validations = requiredValidations(
    testCase({
      title:
        "Anonymous user searches 'spa' and verifies the first displayed deal is 'Sunset Spa Package'",
      steps: [
        "Enter 'spa' into search and submit.",
        "Identify the first deal displayed without scrolling.",
        "Compare its title exactly to 'Sunset Spa Package'.",
      ],
      expectedResult:
        "The first deal visible without scrolling has the exact title 'Sunset Spa Package'.",
    })
  );

  assert.deepEqual(validations, [
    { type: "firstVisibleDealTitle", expected: "Sunset Spa Package" },
  ]);
});

test("a missing expected visible result fails validation", () => {
  assert.equal(
    observedMatchesExpected("Other Deal", "Sunset Spa Package"),
    false
  );
  assert.throws(
    () =>
      assertObservedMatchesExpected(
        "Other Deal",
        "Sunset Spa Package",
        "First visible result title"
      ),
    /did not match expected/
  );
});

test("a matching expected visible result passes validation", () => {
  assert.equal(
    observedMatchesExpected("Sunset Spa Package", "Sunset Spa Package"),
    true
  );
  assert.doesNotThrow(() =>
    assertObservedMatchesExpected(
      "Sunset Spa Package",
      "Sunset Spa Package",
      "First visible result title"
    )
  );
});

test("a named result that must appear is not treated as first-result-exists", () => {
  const validations = requiredValidations(
    testCase({
      title: "Search results include 'Sunset Spa Package'",
      steps: [
        "Search for 'spa'.",
        "Confirm 'Sunset Spa Package' appears in the search results.",
      ],
      expectedResult:
        "The deal 'Sunset Spa Package' appears in the search results.",
    })
  );

  assert.deepEqual(validations, [
    { type: "visibleDealTitle", expected: "Sunset Spa Package" },
  ]);
  assert.equal(
    visibleResultsIncludeTitle(
      [{ title: "Other Deal" }, { title: "Sunset Spa Package" }],
      "Sunset Spa Package"
    ),
    true
  );
  assert.equal(
    visibleResultsIncludeTitle([{ title: "Other Deal" }], "Sunset Spa Package"),
    false
  );
});

test("link Test Cases require usable destination content", () => {
  const validations = requiredValidations(
    testCase({
      title: "Customer-facing homepage links reach usable destinations",
      steps: [
        "Discover the first 10 customer-facing links.",
        "Activate each link and observe the destination.",
      ],
      expectedResult:
        "Each destination displays meaningful, usable user-facing content.",
    })
  );

  assert.equal(
    validations.some((item) => item.type === "linkDestinationsUsable"),
    true
  );
  assert.equal(
    destinationHasMeaningfulContent({ pageOpen: true, bodyLength: 200 }),
    true
  );
  assert.equal(
    destinationHasMeaningfulContent({ pageOpen: true, bodyLength: 0 }),
    false
  );
});

test("page-load Test Cases validate host and recognizable content from the Test Case", () => {
  const validations = requiredValidations(
    testCase({
      title: "Homepage loads with recognizable Northwind content",
      steps: [
        "Navigate to https://www.northwind.example/.",
        "Confirm the address bar shows northwind.example.",
        "Look for recognizable Northwind-branded content or the Northwind logo.",
      ],
      expectedResult:
        "The browser reaches a URL on the northwind.example domain and recognizable Northwind-branded content is visible.",
    })
  );

  assert.equal(
    validations.some(
      (item) => item.type === "pageHost" && item.host === "northwind.example"
    ),
    true
  );
  assert.equal(
    validations.some(
      (item) =>
        item.type === "recognizableContent" && item.tokens.includes("Northwind")
    ),
    true
  );
  assert.equal(
    hostMatchesExpected("https://www.northwind.example/home", "northwind.example"),
    true
  );
  assert.equal(
    pageShowsRecognizableContent("Welcome to Northwind", ["Northwind"]),
    true
  );
});

test("a Test Case requiring a specific expected result fails when that result is not present", () => {
  assert.equal(
    observedMatchesExpected("City Walking Tour", "Sunset Spa Package"),
    false
  );
  assert.equal(
    visibleResultsIncludeTitle(
      [{ title: "City Walking Tour" }, { title: "Harbor Cruise" }],
      "Sunset Spa Package"
    ),
    false
  );
});

test("a Test Case requiring a specific expected result passes when that result is present", () => {
  assert.equal(
    observedMatchesExpected("Sunset Spa Package", "Sunset Spa Package"),
    true
  );
  assert.equal(
    visibleResultsIncludeTitle(
      [{ title: "Harbor Cruise" }, { title: "Sunset Spa Package" }],
      "Sunset Spa Package"
    ),
    true
  );
});

test("a first displayed result fails when the first result is different even if the expected result appears later", () => {
  const displayed = [
    { title: "City Walking Tour" },
    { title: "Sunset Spa Package" },
    { title: "Harbor Cruise" },
  ];
  assert.equal(
    firstDisplayedMatchesExpected(displayed, "Sunset Spa Package"),
    false
  );
  assert.equal(
    visibleResultsIncludeTitle(displayed, "Sunset Spa Package"),
    true
  );
  assert.throws(
    () =>
      assertObservedMatchesExpected(
        displayed[0]?.title,
        "Sunset Spa Package",
        "First visible result title"
      ),
    /did not match expected/
  );
});

test("a page-load Test Case passes when its required observable page conditions are satisfied", () => {
  assert.equal(
    hostMatchesExpected("https://www.northwind.example/home", "northwind.example"),
    true
  );
  assert.equal(
    pageShowsRecognizableContent(
      "Northwind marketplace header and logo",
      ["Northwind"]
    ),
    true
  );
});

test("a page-load Test Case fails when a required observable condition is not satisfied", () => {
  assert.equal(
    hostMatchesExpected("https://unrelated.example/", "northwind.example"),
    false
  );
  assert.equal(
    pageShowsRecognizableContent("Unrelated landing page", ["Northwind"]),
    false
  );
  assert.equal(pageShowsExpectedText("Unrelated landing page", "Northwind"), false);
});

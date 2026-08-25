import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReviewerDecisionGuard,
  hasProvenFunctionalMismatch,
  isInsufficientFunctionalEvidence,
  type QaReviewResult,
  type ReviewerDecisionEvidence,
} from "./index.js";

function review(
  overrides: Partial<QaReviewResult> = {}
): QaReviewResult {
  return {
    requirementId: "US-002",
    overallAssessment: "FAIL",
    functionalTestCases: [
      {
        id: "TC-001",
        status: "FAILED",
        coverageStatus: "COMPLETE",
      },
    ],
    findings: [
      {
        summary: "Product issue",
        classification: "PRODUCT_ISSUE",
        rationale: "The LLM classified this as a product defect.",
      },
    ],
    productIssues: [
      {
        summary: "Product issue",
        rationale: "The LLM classified this as a product defect.",
      },
    ],
    coverageGaps: [],
    artifactInconsistencies: [],
    recommendations: [],
    scopeRecommendations: [],
    qaAssessment: "Assessed from automation evidence.",
    ...overrides,
  };
}

function evidence(
  executionEvidence: unknown,
  overrides: Partial<ReviewerDecisionEvidence> = {}
): ReviewerDecisionEvidence {
  return {
    executionNeverRan: false,
    hasUserFacingEvidence: true,
    currentPassedWithUserFacingEvidence: false,
    executionEvidence,
    ...overrides,
  };
}

const titleMismatchEvidence = {
  requirementId: "US-002",
  testCaseId: "TC-001",
  status: "FAILED",
  coverageStatus: "COMPLETE",
  coverageNote:
    "First visible deal title did not match. Expected 'AI Deal Massage', observed 'Popular Gift'.",
  perLinkResults: [
    {
      index: 1,
      observedTitle: "Popular Gift",
      destination: "https://www.groupon.com/deals/foot-smile-spa-5",
      passed: false,
      reason:
        "First visible deal title did not match. Expected 'AI Deal Massage', observed 'Popular Gift'.",
    },
  ],
  failures: [
    {
      kind: "FUNCTIONAL",
      reason:
        "First visible deal title did not match. Expected 'AI Deal Massage', observed 'Popular Gift'.",
      observedTitle: "Popular Gift",
      finalUrl: "https://www.groupon.com/search?query=massage",
    },
  ],
  overlay: {
    overlayDetected: true,
    dismissalSucceeded: true,
    functionalTestContinued: true,
  },
};

test("clear expected-versus-observed functional mismatch is FAIL", () => {
  assert.equal(hasProvenFunctionalMismatch(titleMismatchEvidence), true);
  assert.equal(isInsufficientFunctionalEvidence(titleMismatchEvidence), false);

  const result = applyReviewerDecisionGuard(
    review(),
    evidence(titleMismatchEvidence)
  );
  assert.equal(result.overallAssessment, "FAIL");
  assert.equal(result.functionalTestCases[0]?.status, "FAILED");
});

test("successful functional validation remains PASS", () => {
  const passedEvidence = {
    status: "PASSED",
    coverageStatus: "COMPLETE",
    finalUrl: "https://www.groupon.com/",
    httpStatus: 200,
    overlay: { overlayDetected: false, functionalTestContinued: true },
  };

  const result = applyReviewerDecisionGuard(
    review({
      overallAssessment: "PASS",
      functionalTestCases: [
        { id: "TC-001", status: "PASSED", coverageStatus: "COMPLETE" },
      ],
      findings: [],
      productIssues: [],
    }),
    evidence(passedEvidence, {
      currentPassedWithUserFacingEvidence: true,
    })
  );

  assert.equal(result.overallAssessment, "PASS");
  assert.equal(result.functionalTestCases[0]?.status, "PASSED");
});

test("technical execution failure before functional validation is INCONCLUSIVE", () => {
  const technicalBeforeAssertion = {
    status: "FAILED",
    coverageStatus: "COMPLETE",
    failures: [
      {
        kind: "TECHNICAL",
        reason:
          "TimeoutError: locator.apply: Timeout 15000ms exceeded while waiting for the search field.",
      },
    ],
  };

  assert.equal(hasProvenFunctionalMismatch(technicalBeforeAssertion), false);
  assert.equal(isInsufficientFunctionalEvidence(technicalBeforeAssertion), true);

  const result = applyReviewerDecisionGuard(
    review(),
    evidence(technicalBeforeAssertion)
  );
  assert.equal(result.overallAssessment, "INCONCLUSIVE");
  assert.equal(result.functionalTestCases[0]?.status, "INCONCLUSIVE");
});

test("incomplete collection coverage without functional mismatch is INCONCLUSIVE", () => {
  const incompleteCoverage = {
    status: "FAILED",
    coverageStatus: "PARTIAL",
    linksDiscovered: 50,
    linksChecked: 10,
    perLinkResults: [
      {
        index: 1,
        href: "https://www.groupon.com/legal/termsofservice",
        observedOutcome: "failure",
        notes: "Technical activation error: TimeoutError: locator.apply",
        finalUrl: null,
      },
    ],
    failures: [
      {
        kind: "TECHNICAL",
        reason: "Activation failed for link index 1: TimeoutError: locator.apply",
      },
    ],
  };

  assert.equal(hasProvenFunctionalMismatch(incompleteCoverage), false);
  assert.equal(isInsufficientFunctionalEvidence(incompleteCoverage), true);

  const result = applyReviewerDecisionGuard(
    review({
      findings: [
        {
          summary: "Only 10 of 50 links were checked",
          classification: "PRODUCT_ISSUE",
          rationale: "The product appears to have only 10 links.",
        },
      ],
    }),
    evidence(incompleteCoverage)
  );
  assert.equal(result.overallAssessment, "INCONCLUSIVE");
});

test("technical error after a proven functional mismatch remains FAIL", () => {
  const mismatchThenTechnical = {
    ...titleMismatchEvidence,
    failures: [
      ...titleMismatchEvidence.failures,
      {
        kind: "TECHNICAL",
        reason: "Error: Cannot handle modals because the page is already closed",
      },
    ],
  };

  assert.equal(hasProvenFunctionalMismatch(mismatchThenTechnical), true);
  assert.equal(isInsufficientFunctionalEvidence(mismatchThenTechnical), false);

  const result = applyReviewerDecisionGuard(
    review(),
    evidence(mismatchThenTechnical)
  );
  assert.equal(result.overallAssessment, "FAIL");
});

test("functional mismatch in a validated item remains FAIL despite incomplete later execution", () => {
  const itemMismatchThenIncomplete = {
    status: "FAILED",
    coverageStatus: "PARTIAL",
    linksDiscovered: 50,
    linksChecked: 10,
    perLinkResults: [
      {
        index: 2,
        label: "Privacy",
        href: "https://www.groupon.com/legal/privacypolicy",
        observedOutcome: "failure",
        notes: "Destination appears broken or empty. title='', bodyLength=0.",
        finalUrl: "https://privacy.groupon.com/",
      },
      {
        index: 4,
        observedOutcome: "failure",
        notes: "Technical activation error: TimeoutError: locator.apply",
        finalUrl: null,
      },
    ],
    failures: [
      {
        kind: "FUNCTIONAL",
        reason: "Unusable or error destination for link index 2",
        finalUrl: "https://privacy.groupon.com/",
      },
      {
        kind: "TECHNICAL",
        reason: "Activation failed for link index 4: TimeoutError: locator.apply",
      },
    ],
  };

  assert.equal(hasProvenFunctionalMismatch(itemMismatchThenIncomplete), true);
  assert.equal(
    isInsufficientFunctionalEvidence(itemMismatchThenIncomplete),
    false
  );

  const result = applyReviewerDecisionGuard(
    review({ requirementId: "US-001" }),
    evidence(itemMismatchThenIncomplete)
  );
  assert.equal(result.overallAssessment, "FAIL");
});

test("no evidence sufficient to prove PASS or FAIL is INCONCLUSIVE", () => {
  const result = applyReviewerDecisionGuard(
    review({
      findings: [],
      productIssues: [],
    }),
    evidence(undefined, {
      executionNeverRan: true,
      hasUserFacingEvidence: false,
    })
  );
  assert.equal(result.overallAssessment, "INCONCLUSIVE");
});

test("expected-versus-observed mismatch plus overlay or technical issue remains FAIL", () => {
  const mismatchWithOverlayAndTimeout = {
    ...titleMismatchEvidence,
    failures: [
      ...titleMismatchEvidence.failures,
      {
        kind: "TECHNICAL",
        reason: "TimeoutError: locator.apply: overlay intercepts pointer events",
      },
    ],
  };

  const result = applyReviewerDecisionGuard(
    review({
      overallAssessment: "INCONCLUSIVE",
      functionalTestCases: [
        { id: "TC-001", status: "INCONCLUSIVE", coverageStatus: "COMPLETE" },
      ],
    }),
    evidence(mismatchWithOverlayAndTimeout)
  );

  assert.equal(result.overallAssessment, "FAIL");
  assert.equal(result.functionalTestCases[0]?.status, "FAILED");
});

test("FUNCTIONAL product assertion without structured mismatch remains FAIL", () => {
  const homepageContentFailure = {
    status: "FAILED",
    coverageStatus: "COMPLETE",
    failures: [
      {
        kind: "FUNCTIONAL",
        reason: "Homepage did not display recognizable Groupon content.",
        finalUrl: "https://www.groupon.com/",
      },
    ],
  };

  assert.equal(hasProvenFunctionalMismatch(homepageContentFailure), false);
  assert.equal(isInsufficientFunctionalEvidence(homepageContentFailure), false);

  const result = applyReviewerDecisionGuard(
    review({ requirementId: "US-003" }),
    evidence(homepageContentFailure)
  );
  assert.equal(result.overallAssessment, "FAIL");
});

test("discovery failure without an observed functional result is INCONCLUSIVE", () => {
  const noDealFound = {
    status: "FAILED",
    coverageStatus: "COMPLETE",
    perLinkResults: [
      {
        observedTitle: null,
        destination: null,
        passed: false,
        reason: "No visible deal card was found in the initial search results area.",
      },
    ],
    failures: [
      {
        kind: "FUNCTIONAL",
        reason: "No visible deal card was found in the initial search results area.",
        observedTitle: null,
      },
    ],
  };

  assert.equal(hasProvenFunctionalMismatch(noDealFound), false);
  assert.equal(isInsufficientFunctionalEvidence(noDealFound), true);

  const result = applyReviewerDecisionGuard(review(), evidence(noDealFound));
  assert.equal(result.overallAssessment, "INCONCLUSIVE");
});

test("FAIL without product evidence becomes INCONCLUSIVE", () => {
  const result = applyReviewerDecisionGuard(
    review({
      findings: [
        {
          summary: "Spec never ran",
          classification: "TEST_ISSUE",
          rationale: "Playwright found no tests.",
        },
      ],
      productIssues: [],
    }),
    evidence(
      {
        status: "FAILED",
        coverageStatus: "UNKNOWN",
        failures: [
          {
            kind: "TECHNICAL",
            reason: "SyntaxError: Unexpected token in generated spec",
          },
        ],
      },
      { executionNeverRan: true, hasUserFacingEvidence: false }
    )
  );
  assert.equal(result.overallAssessment, "INCONCLUSIVE");
});

test("generic collection-field misread of a PASS remains PASS", () => {
  const result = applyReviewerDecisionGuard(
    review({
      overallAssessment: "INCONCLUSIVE",
      functionalTestCases: [
        { id: "TC-001", status: "INCONCLUSIVE", coverageStatus: "COMPLETE" },
      ],
      findings: [
        {
          summary: "Missing linksDiscovered",
          classification: "INCONCLUSIVE",
          rationale: "linksChecked was not present for this homepage case.",
        },
      ],
      productIssues: [],
      coverageGaps: [
        {
          summary: "Missing collection fields",
          rationale: "browserNavigationSucceeded was absent.",
        },
      ],
      qaAssessment: "INCONCLUSIVE because linksDiscovered was missing.",
    }),
    evidence(
      {
        status: "PASSED",
        coverageStatus: "COMPLETE",
        finalUrl: "https://www.groupon.com/",
      },
      { currentPassedWithUserFacingEvidence: true }
    )
  );
  assert.equal(result.overallAssessment, "PASS");
});

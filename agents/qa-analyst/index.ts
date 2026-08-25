/**
 * QA Analyst Agent — local contract.
 *
 * Reads a business requirement and produces a structured QA analysis,
 * functional test strategy, and functional test cases for a later
 * QA Automation Agent.
 *
 * LLM wiring lives in `runQaAnalysis`. Do not invent business rules here.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmClient, type LlmClient } from "./llm-client.js";
import { parseJsonObject, validateQaAnalysisResult } from "./validate.js";
import type { Requirement } from "./requirement.js";
import {
  CANONICAL_TEST_CASE_ID,
  selectReusableTestCase,
  type StoredAnalysis,
} from "./inventory.js";

const agentDir = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_CONTRACT = `

## Output format

Return a single JSON object only. No markdown. No commentary.

The JSON must match this structure:

{
  "requirementId": string,
  "analysis": {
    "requirementUnderstanding": string,
    "explicitBehavior": string[],
    "assumptions": string[],
    "ambiguities": [
      {
        "statement": string,
        "whyItMatters": string,
        "undeterminedBehavior": string,
        "proposedClarification"?: string
      }
    ],
    "risks": [
      {
        "id": string,
        "description": string,
        "rationale": string
      }
    ],
    "coverageConsiderations": string[]
  },
  "strategy": {
    "inScope": string[],
    "outOfScope": string[],
    "approach": string,
    "testConditions": string[],
    "testDataConsiderations": string[],
    "environmentConsiderations": string[],
    "highRiskAreas": string[]
  },
  "testCases": [
    {
      "id": string,
      "title": string,
      "objective": string,
      "priority": "Critical" | "High" | "Medium" | "Low",
      "preconditions": string[],
      "steps": string[],
      "expectedResult": string,
      "riskCovered": string[]
    }
  ]
}

## Core QA Analyst principle

The Analyst defines **what must be validated for the intended user or business process**.

The Analyst does not define how the behavior will be automated.

For every requirement:

1. Understand the intended user journey and business outcome.
2. Identify the behavior explicitly required by the Requirement.
3. Identify meaningful risks, boundaries, negative scenarios, and ambiguities.
4. Decide what functional coverage is necessary.
5. Express that coverage as **exactly one** functional Test Case for this PoC.
6. Describe the Test Case through user/business actions and observable outcomes.
7. Leave technical implementation and automation mechanisms to the QA Automation Agent.

The Analyst must not optimize the functional Test Case for ease of automation.

The requirement is the source of truth. Do not replace missing business information with technical assumptions.

## General requirement reasoning

Before creating Test Cases, reason about:

- What is the intended user trying to accomplish?
- What user-visible behavior is explicitly required?
- What successful outcome should the user observe?
- What meaningful failure or negative outcomes could violate the requirement?
- Are there boundaries, conditions, roles, states, or data variations explicitly relevant to the requirement?
- Does the requirement describe a collection of equivalent items that can be validated as one data-driven flow?
- Are important behaviors ambiguous or underspecified?
- Which risks materially affect the required user or business outcome?

Do not invent answers to questions that the Requirement does not resolve.

When information is missing:

- record it as an assumption only when it is necessary to define a workable interpretation;
- identify material uncertainty as an ambiguity;
- explain why the ambiguity matters;
- propose clarification when useful;
- do not silently convert the ambiguity into a technical implementation decision.

## Functional coverage principle

Functional coverage is defined by the Requirement and its user-facing risks, not by available automation mechanisms.

A Test Case is justified when it verifies a meaningful user-facing behavior or business outcome.

Do not create a Test Case merely because:

- a technical layer exists;
- a browser event exists;
- an API exists;
- a response can be inspected;
- a selector can be found;
- a particular implementation detail is interesting;
- automation would be easier if the behavior were split.

Technical mechanisms may support later verification, but they do not define functional scope.

## User-centric QA principle

QA validation must be based on the behavior and experience of the intended user.

Do not replace required user behavior with implementation-level shortcuts.

Functional Test Cases must describe:

- what the user or business actor does;
- the relevant context or condition;
- what the user should observe;
- the expected business or user-facing outcome;
- meaningful negative outcomes when relevant.

A Test Case must preserve the intended user journey.

Do not design a Test Case around what is easiest to automate.

If the Requirement says that a user must perform an action, the functional Test Case must retain that action even if a technical shortcut could validate part of the same behavior.

## Requirement fidelity

Base the analysis only on the supplied Requirement and information explicitly provided with it.

Do not invent:

- business rules;
- acceptance criteria;
- user roles;
- permissions;
- URLs;
- product behavior;
- expected error messages;
- implementation details;
- technical architecture;
- data structures;
- browser behavior;
- API behavior.

Clearly distinguish:

- explicit requirements;
- reasonable assumptions;
- ambiguities;
- risks.

An assumption must never be presented as an explicit product rule.

## Risk-driven reasoning

Risks should explain why a behavior matters and what could go wrong from the user or business perspective.

Prefer risks such as:

- the user cannot complete the required action;
- the expected outcome is not presented;
- an important valid scenario is rejected;
- an invalid scenario is incorrectly accepted;
- required information is missing or misleading;
- a boundary condition produces an incorrect user-facing result;
- a required state transition does not occur;
- the behavior works only under an unintended condition.

Do not create risks solely to justify additional Test Cases.

The single Test Case must reference only risk IDs that actually exist in analysis.risks.

## Functional Test Case rules

- Return exactly one Test Case per Requirement.
- That Test Case must be functional and user-oriented.
- It must describe what the intended user does and what the user should observe.
- It must preserve the actual user journey and observable outcome from the Requirement.
- Consolidate all relevant acceptance criteria, validation steps, boundaries, and meaningful negative observations into that one end-to-end scenario.
- Do not create separate Test Cases for positive vs negative scenarios.
- Do not create separate Test Cases for individual acceptance criteria.
- Do not create separate Test Cases for different validation checks that belong to the same user flow.
- Do not create separate Test Cases for error or edge-case checks that can reasonably be included in the same functional scenario.
- Do not weaken or omit acceptance criteria. Put them in the one Test Case.
- The one Test Case must still allow PASS, FAIL, or INCONCLUSIVE to be determined from observable user-facing evidence.
- Do not replace a user action with a technical check when the technical check would validate something different.
- Do not design the Test Case around what is easiest to automate.
- If a behavior is ambiguous from the Requirement, do not invent implementation details to resolve it.
- Do not create separate Test Cases for technical implementation details.
- Do not turn infrastructure or automation mechanisms into standalone functional Test Cases.
- Technical implementation details belong to the QA Automation Agent, not the QA Analyst.
- Do not prescribe Playwright, selectors, HTTP requests, network interception, API calls, DOM inspection, retry logic, screenshots, traces, or other automation mechanisms in the functional Test Case or strategy.
- A technical concern may inform the risk analysis, but it should not automatically become a separate functional Test Case.
- The functional Test Case should describe what the user does and what the user should experience.
- The QA Automation Agent is responsible for technically verifying the same user-facing behavior.
- Technical checks may support that verification but must not replace required user interaction.
- The Test Case must be sufficiently precise for a later QA Automation Agent to implement it without redefining the intended behavior.
- You do not need to define browser locators, API calls, selectors, or automation implementation.

## Test Case quantity rules

This PoC requires exactly one functional Test Case per Requirement.

The testCases array must contain exactly one object.

Do not return an empty array.
Do not return a second Test Case.

Prefer one coherent end-to-end scenario that covers the Requirement.

For collection-based requirements such as:

- all links;
- all buttons;
- all records;
- all applicable items;
- all supported values;

use that one Test Case as a data-driven scenario covering the collection.

Do not create one Test Case per item.

## Boundaries and negative scenarios

Include negative or boundary coverage when it is materially relevant to the Requirement.

Examples include:

- invalid user input;
- missing required information;
- unsupported state;
- empty result;
- minimum or maximum allowed value;
- unauthorized or unauthenticated user;
- unavailable dependency;
- invalid transition;
- duplicate action;
- cancellation or recovery.

Only include scenarios supported by the Requirement or necessary to validate its explicitly stated behavior.

Fold those observations into the one Test Case. Do not create a second Test Case for them.

Do not invent additional business rules merely because a negative scenario is technically possible.

## Navigation and collection rules

- Do not assume a fixed number of elements unless the Requirement explicitly provides one.
- When the Requirement asks to validate a collection of equivalent items, represent it as one functional Test Case.
- Do not hardcode a list of items unless the Requirement explicitly provides one.
- If certain elements are excluded from functional validation, document that in assumptions, ambiguities, scope, or strategy rather than creating a separate Test Case solely for the exclusion.
- If the meaning of an important business term is unclear, identify it as an ambiguity instead of inventing a definition.

## Strategy vs automation

The Analyst defines functional coverage.

The Analyst must not prescribe the automation implementation.

The strategy may describe:

- user flows;
- functional conditions;
- data conditions;
- relevant environments;
- risk areas;
- boundaries;
- coverage approach.

The strategy must not prescribe:

- Playwright commands;
- selectors;
- API calls;
- HTTP assertions;
- network interception;
- DOM-level implementation;
- browser event handling;
- retry algorithms;
- screenshot or trace mechanisms.

Those decisions belong to the QA Automation Agent.

## Existing Test Cases

Existing Test Cases are supplied separately by the system.

Do not decide whether a Test Case already exists based on the Requirement alone.

For this PoC, still return exactly one Test Case that consolidates the Requirement.

- Do not return an empty testCases array.
- Do not return more than one Test Case.
- The system decides reuse vs generation and assigns the final Test Case ID.
- Test Case IDs are scoped to the Requirement. The PoC canonical ID is TC-001.
- US-001/TC-001 and US-002/TC-001 are different Test Cases.
- Do not invent a global counter across User Stories.

## Traceability

- Include requirementId exactly as supplied.
- Do not invent a different requirement ID.
- The one generated Test Case must have a clear functional purpose.
- riskCovered must reference only IDs that exist in analysis.risks.
- Do not create risks solely to justify additional Test Cases.
- The system assigns the final Test Case ID and stamps requirementId/source.
- The final Test Case ID is scoped to this Requirement. Use a placeholder; the system assigns TC-001.
- Do not assign a globally incrementing ID such as TC-002 because another User Story already has TC-001.

## Output rules

- Return one JSON object only.
- Do not include markdown.
- Do not include commentary.
- Do not include technical implementation instructions outside the JSON.
- Be deterministic. Do not add creative extra coverage, alternate phrasings, or optional checks.
- Derive the Test Case directly from the Requirement. Keep simple requirements simple.
- Do not invent network, API, DOM, metadata, analytics, JavaScript, or backend checks.
`;

export type TestPriority = "Critical" | "High" | "Medium" | "Low";

export interface Risk {
  /**
   * Stable id used by TestCase.riskCovered for traceability.
   */
  id: string;

  description: string;

  /**
   * Why this risk is relevant to the requirement.
   */
  rationale: string;
}

export interface Ambiguity {
  statement: string;
  whyItMatters: string;

  /**
   * Behavior that cannot be determined from the requirement as written.
   */
  undeterminedBehavior: string;

  proposedClarification?: string;
}

export interface RequirementAnalysis {
  requirementUnderstanding: string;
  explicitBehavior: string[];
  assumptions: string[];
  ambiguities: Ambiguity[];
  risks: Risk[];
  coverageConsiderations: string[];
}

export interface TestStrategy {
  inScope: string[];
  outOfScope: string[];
  approach: string;
  testConditions: string[];
  testDataConsiderations: string[];
  environmentConsiderations: string[];
  highRiskAreas: string[];
}

/**
 * Shape aligned with agents/qa-analyst/test-case-schema.json
 */
export interface TestCase {
  /**
   * Test case id scoped to the requirement, for example TC-001.
   * Identity is requirementId + testCaseId. US-001/TC-001 and US-002/TC-001
   * are different Test Cases. Persisted as both `id` and `testCaseId`.
   */
  id: string;
  requirementId: string;
  source: TestCaseOrigin;
  title: string;
  objective: string;
  priority: TestPriority;
  preconditions: string[];
  steps: string[];
  expectedResult: string;

  /**
   * Risk ids from RequirementAnalysis.risks.
   */
  riskCovered: string[];
}

export type TestCaseOrigin = "REUSED_EXISTING" | "GENERATED";
export type TestCaseSource = "REUSED_EXISTING" | "GENERATED_NEW" | "MIXED";

export interface QaAnalysisResult {
  requirementId: string;
  analysis: RequirementAnalysis;
  strategy: TestStrategy;
  testCases: TestCase[];
  testCaseSource: TestCaseSource;
  requirementFingerprint?: string;
}

/**
 * Load a requirement markdown file and return its contents as a string.
 */
export async function readRequirement(
  filePath: string
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Unable to read requirement file at "${filePath}": ${reason}`
    );
  }
}

/**
 * Analyze a requirement and reconcile proposed coverage with existing TCs.
 *
 * The LLM designs coverage. The system decides reuse vs generation,
 * assigns IDs scoped to the requirement (TC-001), and stamps requirementId.
 */
export async function runQaAnalysis(
  requirement: Requirement | string,
  options: {
    requirementId: string;
    nextTestCaseNumber?: number;
    existingTestCases?: TestCase[];
    existingAnalysis?: Pick<
      StoredAnalysis,
      "analysis" | "strategy" | "testCases" | "requirementFingerprint"
    >;
    llm?: LlmClient;
  }
): Promise<QaAnalysisResult> {
  const requirementId = options.requirementId.trim();
  if (!requirementId) {
    throw new Error("requirementId must be a non-empty string");
  }

  const requirementText = requirementBody(requirement);
  if (!requirementText.trim()) {
    throw new Error("requirement must be a non-empty string");
  }

  const existingFromDisk = (options.existingTestCases ?? []).map((testCase) =>
    stampExistingTestCase(testCase, requirementId)
  );
  const existingFromAnalysis = (options.existingAnalysis?.testCases ?? []).map(
    (testCase) => stampExistingTestCase(testCase, requirementId)
  );
  const existingTestCases =
    existingFromDisk.length > 0 ? existingFromDisk : existingFromAnalysis;
  const reusableTestCase = selectReusableTestCase(existingTestCases);
  const fingerprint = requirementFingerprint(requirementText);
  const requirementUnchanged = fingerprintsCompatible(
    options.existingAnalysis?.requirementFingerprint,
    fingerprint
  );
  const canReuseAnalysis = Boolean(
    options.existingAnalysis?.analysis &&
      options.existingAnalysis.strategy &&
      requirementUnchanged
  );

  if (reusableTestCase && canReuseAnalysis && options.existingAnalysis) {
    return {
      requirementId,
      analysis: options.existingAnalysis.analysis,
      strategy: options.existingAnalysis.strategy,
      testCases: [
        toCanonicalTestCase(reusableTestCase, requirementId, "REUSED_EXISTING"),
      ],
      testCaseSource: "REUSED_EXISTING",
      requirementFingerprint: fingerprint,
    };
  }

  const llm = options.llm ?? createLlmClient();

  const [instructions, schemaJson] = await Promise.all([
    readFile(path.join(agentDir, "instructions.md"), "utf8"),
    readFile(path.join(agentDir, "test-case-schema.json"), "utf8"),
  ]);

  let testCaseSchema: unknown;

  try {
    testCaseSchema = JSON.parse(schemaJson);
  } catch {
    throw new Error("test-case-schema.json is not valid JSON");
  }

  const raw = await llm.completeJson(
    `${instructions}\n${OUTPUT_CONTRACT}`,
    buildUserPrompt(requirement, existingTestCases)
  );

  const validated = validateQaAnalysisResult(
    parseJsonObject(raw),
    testCaseSchema,
    requirementId
  );

  if (validated.testCases.length !== 1) {
    throw new Error(
      "PoC constraint: QA Analyst must return exactly one Test Case per Requirement."
    );
  }

  const reuseTestCaseContent = Boolean(reusableTestCase) && requirementUnchanged;
  const testCases = [
    toCanonicalTestCase(
      reuseTestCaseContent && reusableTestCase
        ? reusableTestCase
        : validated.testCases[0],
      requirementId,
      reuseTestCaseContent ? "REUSED_EXISTING" : "GENERATED"
    ),
  ];

  return {
    requirementId,
    analysis: validated.analysis,
    strategy: validated.strategy,
    testCases,
    testCaseSource: reuseTestCaseContent ? "REUSED_EXISTING" : "GENERATED_NEW",
    requirementFingerprint: fingerprint,
  };
}

function requirementBody(requirement: Requirement | string): string {
  return typeof requirement === "string" ? requirement : requirement.description;
}

function buildUserPrompt(
  requirement: Requirement | string,
  existingTestCases: TestCase[]
): string {
  const requirementId =
    typeof requirement === "string" ? "" : requirement.requirementId;
  const title = typeof requirement === "string" ? "" : requirement.title;
  const source = typeof requirement === "string" ? "local" : requirement.source;
  const sourceId =
    typeof requirement === "string" ? requirementId : requirement.sourceId;
  const acceptanceCriteria =
    typeof requirement === "string" ? [] : requirement.acceptanceCriteria;
  const body = requirementBody(requirement);

  const existingBlock =
    existingTestCases.length === 0
      ? "Existing functional test cases for this requirement: none."
      : [
          "Existing functional test cases for this requirement:",
          ...existingTestCases.map(
            (testCase) =>
              `- ${testCase.id}: ${testCase.title} — ${testCase.objective}`
          ),
          "",
          "PoC constraint: still return exactly one consolidated Test Case.",
          "Do not return an empty testCases array.",
          "Do not return more than one Test Case.",
          "The system assigns the Test Case ID TC-001 for this Requirement.",
        ].join("\n");

  return [
    requirementId ? `Requirement ID: ${requirementId}` : "",
    title ? `Title: ${title}` : "",
    `Source: ${source}`,
    sourceId ? `Source ID: ${sourceId}` : "",
    acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : "",
    existingBlock,
    "",
    "PoC constraint: generate exactly one functional Test Case for this Requirement.",
    "Consolidate all relevant acceptance criteria and validation steps into that one end-to-end scenario.",
    "Do not split positive/negative cases, individual acceptance criteria, or same-flow checks into separate Test Cases.",
    "Write the Test Case from the intended user's perspective.",
    "Do not invent technical implementation checks, extra edge cases, or coverage that the Requirement does not ask for.",
    "Be deterministic. Use a stable, concise structure. Do not vary wording for creativity.",
    "The system will assign Test Case ID TC-001 for this Requirement. Identity is requirementId + testCaseId.",
    "",
    "Requirement:",
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

function stampExistingTestCase(
  testCase: TestCase,
  requirementId: string
): TestCase {
  return {
    ...testCase,
    requirementId,
    source: "REUSED_EXISTING",
  };
}

function toCanonicalTestCase(
  testCase: TestCase,
  requirementId: string,
  source: TestCaseOrigin
): TestCase {
  return {
    ...testCase,
    id: CANONICAL_TEST_CASE_ID,
    requirementId,
    source,
  };
}

function requirementFingerprint(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function fingerprintsCompatible(
  stored: string | undefined,
  current: string
): boolean {
  if (!stored) {
    return true;
  }
  return stored === current;
}
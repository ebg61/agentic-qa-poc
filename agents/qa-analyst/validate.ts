import type {
  Ambiguity,
  QaAnalysisResult,
  RequirementAnalysis,
  Risk,
  TestCase,
  TestPriority,
  TestStrategy,
} from "./index.js";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
};

export function parseJsonObject(text: string): unknown {
  const unfenced = stripMarkdownFence(text.trim());

  let parsed: unknown;

  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error("LLM response is not valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("LLM response must be a JSON object");
  }

  return parsed;
}

export function validateQaAnalysisResult(
  value: unknown,
  testCaseSchema: unknown,
  requirementId: string
): QaAnalysisResult {
  const record = asRecord(value, "QaAnalysisResult");
  const schema = asJsonSchema(testCaseSchema, "test-case-schema.json");

  const analysis = validateRequirementAnalysis(record.analysis);
  const strategy = validateTestStrategy(record.strategy);

  if (!("testCases" in record)) {
    throw new Error(
      'QaAnalysisResult is missing required property "testCases"'
    );
  }

  validateJsonSchema(
    { testCases: record.testCases },
    schema,
    "QaAnalysisResult"
  );

  const testCases = asArray(record.testCases, "testCases").map(
    (item, index) => asProposedTestCase(item, requirementId, index)
  );

  if (testCases.length !== 1) {
    throw new Error(
      "PoC constraint: QA Analyst must return exactly one Test Case per Requirement."
    );
  }

  return {
    requirementId,
    analysis,
    strategy,
    testCases,
    testCaseSource: "GENERATED_NEW",
  };
}

function asProposedTestCase(
  value: unknown,
  requirementId: string,
  index: number
): TestCase {
  const record = asRecord(value, `testCases[${index}]`);

  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : `PROPOSED-${index + 1}`,
    requirementId,
    source: "GENERATED",
    title: asString(record.title, `testCases[${index}].title`),
    objective: asString(record.objective, `testCases[${index}].objective`),
    priority: record.priority as TestPriority,
    preconditions: asStringArray(
      record.preconditions,
      `testCases[${index}].preconditions`
    ),
    steps: asStringArray(record.steps, `testCases[${index}].steps`),
    expectedResult: asString(
      record.expectedResult,
      `testCases[${index}].expectedResult`
    ),
    riskCovered: asStringArray(
      record.riskCovered,
      `testCases[${index}].riskCovered`
    ),
  };
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

function validateRequirementAnalysis(
  value: unknown
): RequirementAnalysis {
  const record = asRecord(value, "analysis");

  return {
    requirementUnderstanding: asString(
      record.requirementUnderstanding,
      "analysis.requirementUnderstanding"
    ),

    explicitBehavior: asStringArray(
      record.explicitBehavior,
      "analysis.explicitBehavior"
    ),

    assumptions: asStringArray(
      record.assumptions,
      "analysis.assumptions"
    ),

    ambiguities: asArray(
      record.ambiguities,
      "analysis.ambiguities"
    ).map((item, index) =>
      validateAmbiguity(
        item,
        `analysis.ambiguities[${index}]`
      )
    ),

    risks: asArray(
      record.risks,
      "analysis.risks"
    ).map((item, index) =>
      validateRisk(
        item,
        `analysis.risks[${index}]`
      )
    ),

    coverageConsiderations: asStringArray(
      record.coverageConsiderations,
      "analysis.coverageConsiderations"
    ),
  };
}

function validateAmbiguity(
  value: unknown,
  path: string
): Ambiguity {
  const record = asRecord(value, path);

  const ambiguity: Ambiguity = {
    statement: asString(
      record.statement,
      `${path}.statement`
    ),

    whyItMatters: asString(
      record.whyItMatters,
      `${path}.whyItMatters`
    ),

    undeterminedBehavior: asString(
      record.undeterminedBehavior,
      `${path}.undeterminedBehavior`
    ),
  };

  if (record.proposedClarification !== undefined) {
    ambiguity.proposedClarification = asString(
      record.proposedClarification,
      `${path}.proposedClarification`
    );
  }

  return ambiguity;
}

function validateRisk(
  value: unknown,
  path: string
): Risk {
  const record = asRecord(value, path);

  return {
    id: asString(
      record.id,
      `${path}.id`
    ),

    description: asString(
      record.description,
      `${path}.description`
    ),

    rationale: asString(
      record.rationale,
      `${path}.rationale`
    ),
  };
}

function validateTestStrategy(
  value: unknown
): TestStrategy {
  const record = asRecord(value, "strategy");

  return {
    inScope: asStringArray(
      record.inScope,
      "strategy.inScope"
    ),

    outOfScope: asStringArray(
      record.outOfScope,
      "strategy.outOfScope"
    ),

    approach: asString(
      record.approach,
      "strategy.approach"
    ),

    testConditions: asStringArray(
      record.testConditions,
      "strategy.testConditions"
    ),

    testDataConsiderations: asStringArray(
      record.testDataConsiderations,
      "strategy.testDataConsiderations"
    ),

    environmentConsiderations: asStringArray(
      record.environmentConsiderations,
      "strategy.environmentConsiderations"
    ),

    highRiskAreas: asStringArray(
      record.highRiskAreas,
      "strategy.highRiskAreas"
    ),
  };
}

function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path: string
): void {
  if (schema.enum) {
    if (
      typeof value !== "string" ||
      !schema.enum.includes(value)
    ) {
      throw new Error(
        `${path} must be one of: ${schema.enum.join(", ")}`
      );
    }
  }

  if (schema.type === "string") {
    asString(value, path);
    return;
  }

  if (schema.type === "array") {
    const items = asArray(value, path);

    if (schema.minItems !== undefined && items.length < schema.minItems) {
      throw new Error(
        `${path} must contain at least ${schema.minItems} item(s)`
      );
    }

    if (schema.maxItems !== undefined && items.length > schema.maxItems) {
      throw new Error(
        `${path} must contain at most ${schema.maxItems} item(s)`
      );
    }

    if (schema.items) {
      for (const [index, item] of items.entries()) {
        validateJsonSchema(
          item,
          schema.items,
          `${path}[${index}]`
        );
      }
    }

    return;
  }

  if (schema.type === "object") {
    const record = asRecord(value, path);
    const properties = schema.properties ?? {};

    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        throw new Error(
          `${path} is missing required property "${key}"`
        );
      }
    }

    for (const [key, propertySchema] of Object.entries(
      properties
    )) {
      if (key in record) {
        validateJsonSchema(
          record[key],
          propertySchema,
          `${path}.${key}`
        );
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(
        Object.keys(properties)
      );

      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          throw new Error(
            `${path} has unexpected property "${key}"`
          );
        }
      }
    }
  }
}

function asJsonSchema(
  value: unknown,
  path: string
): JsonSchema {
  const record = asRecord(value, path);

  if (
    record.type !== "object" ||
    typeof record.properties !== "object" ||
    record.properties === null
  ) {
    throw new Error(
      `${path} is not a supported JSON schema`
    );
  }

  return value as JsonSchema;
}

function asRecord(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function asArray(
  value: unknown,
  path: string
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }

  return value;
}

function asString(
  value: unknown,
  path: string
): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }

  return value;
}

function asStringArray(
  value: unknown,
  path: string
): string[] {
  return asArray(value, path).map(
    (item, index) =>
      asString(item, `${path}[${index}]`)
  );
}
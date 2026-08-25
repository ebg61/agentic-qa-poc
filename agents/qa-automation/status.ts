/**
 * Automation Agent execution status.
 *
 * The Automation Agent reports only PASSED or FAILED.
 * INCONCLUSIVE is a Reviewer decision and must not be produced here.
 *
 * PASSED requires both a completed user journey and satisfied Test Case
 * validations. A Playwright process that finishes without throwing is not
 * enough by itself.
 */

export type ExecutionStatus = "PASSED" | "FAILED";

export function classifyAutomationExecution(input: {
  journeyExecuted: boolean;
  validationsSatisfied: boolean;
  generationFailed?: boolean;
  executionFailed?: boolean;
}): ExecutionStatus {
  if (
    input.generationFailed ||
    input.executionFailed ||
    !input.journeyExecuted ||
    !input.validationsSatisfied
  ) {
    return "FAILED";
  }
  return "PASSED";
}

export function toAutomationStatus(options: {
  evidenceStatus?: string;
  processFailed: boolean;
  validationsSatisfied?: boolean;
}): ExecutionStatus {
  if (options.processFailed) {
    return classifyAutomationExecution({
      journeyExecuted: false,
      validationsSatisfied: false,
      executionFailed: true,
    });
  }

  if (options.evidenceStatus === "INCONCLUSIVE") {
    return "FAILED";
  }

  const validationsSatisfied =
    options.validationsSatisfied ?? options.evidenceStatus === "PASSED";

  return classifyAutomationExecution({
    journeyExecuted: true,
    validationsSatisfied,
    executionFailed: false,
  });
}

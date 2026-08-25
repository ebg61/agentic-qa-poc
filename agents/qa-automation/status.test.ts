import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyAutomationExecution,
  toAutomationStatus,
} from "./status.js";

test("executed journey evidence is PASSED", () => {
  assert.equal(
    toAutomationStatus({ evidenceStatus: "PASSED", processFailed: false }),
    "PASSED"
  );
});

test("execution evidence status FAILED is FAILED", () => {
  assert.equal(
    toAutomationStatus({ evidenceStatus: "FAILED", processFailed: false }),
    "FAILED"
  );
});

test("Playwright execution error is FAILED", () => {
  assert.equal(
    toAutomationStatus({ evidenceStatus: "PASSED", processFailed: true }),
    "FAILED"
  );
  assert.equal(
    toAutomationStatus({ evidenceStatus: undefined, processFailed: true }),
    "FAILED"
  );
});

test("legacy INCONCLUSIVE evidence is reported as FAILED", () => {
  assert.equal(
    toAutomationStatus({
      evidenceStatus: "INCONCLUSIVE",
      processFailed: false,
    }),
    "FAILED"
  );
});

test("missing evidence is FAILED, not PASSED", () => {
  assert.equal(
    toAutomationStatus({ evidenceStatus: undefined, processFailed: false }),
    "FAILED"
  );
});

test("successful Playwright execution without satisfying the Test Case validation produces Automation FAILED", () => {
  assert.equal(
    toAutomationStatus({
      evidenceStatus: "PASSED",
      processFailed: false,
      validationsSatisfied: false,
    }),
    "FAILED"
  );
  assert.equal(
    classifyAutomationExecution({
      journeyExecuted: true,
      validationsSatisfied: false,
    }),
    "FAILED"
  );
});

test("Automation never returns INCONCLUSIVE", () => {
  const statuses = [
    toAutomationStatus({ evidenceStatus: "PASSED", processFailed: false }),
    toAutomationStatus({ evidenceStatus: "FAILED", processFailed: false }),
    toAutomationStatus({ evidenceStatus: "INCONCLUSIVE", processFailed: false }),
    toAutomationStatus({ evidenceStatus: undefined, processFailed: true }),
    classifyAutomationExecution({
      journeyExecuted: true,
      validationsSatisfied: true,
    }),
    classifyAutomationExecution({
      journeyExecuted: false,
      validationsSatisfied: true,
      executionFailed: true,
    }),
    classifyAutomationExecution({
      journeyExecuted: false,
      validationsSatisfied: false,
      generationFailed: true,
    }),
  ];
  for (const status of statuses) {
    assert.equal(status === "PASSED" || status === "FAILED", true);
    assert.notEqual(status, "INCONCLUSIVE");
  }
});

test("Automation PASSED/FAILED is determined from execution plus Test Case validations", () => {
  assert.equal(
    classifyAutomationExecution({
      journeyExecuted: true,
      validationsSatisfied: true,
    }),
    "PASSED"
  );
  assert.equal(
    classifyAutomationExecution({
      journeyExecuted: true,
      validationsSatisfied: false,
    }),
    "FAILED"
  );
  assert.equal(
    classifyAutomationExecution({
      journeyExecuted: false,
      validationsSatisfied: true,
      executionFailed: true,
    }),
    "FAILED"
  );
  assert.equal(
    classifyAutomationExecution({
      journeyExecuted: false,
      validationsSatisfied: false,
      generationFailed: true,
    }),
    "FAILED"
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_DEFAULT_APPLICATION_URL,
  extractHttpUrl,
  resolveApplicationUrl,
} from "./app-url.js";

test("optional HOMEPAGE overrides the project default", () => {
  assert.equal(
    resolveApplicationUrl({
      env: { HOMEPAGE: "https://staging.example.com/" },
    }),
    "https://staging.example.com/"
  );
});

test("optional BASE_URL overrides the project default when HOMEPAGE is absent", () => {
  assert.equal(
    resolveApplicationUrl({
      env: { BASE_URL: "https://preview.example.com/" },
    }),
    "https://preview.example.com/"
  );
});

test("a Test Case URL takes precedence over HOMEPAGE", () => {
  assert.equal(
    resolveApplicationUrl({
      env: { HOMEPAGE: "https://staging.example.com/" },
      testCaseUrl: "https://www.example.com/deals",
    }),
    "https://www.example.com/deals"
  );
});

test("a URL embedded in Test Case text is used when no explicit testCaseUrl is set", () => {
  assert.equal(
    resolveApplicationUrl({
      env: {},
      testCaseText:
        "Open a browser and enter the URL: https://www.groupon.com/.",
    }),
    "https://www.groupon.com/"
  );
});

test("project default homepage is the Groupon homepage", () => {
  assert.equal(
    PROJECT_DEFAULT_APPLICATION_URL,
    "https://www.groupon.com/"
  );
  assert.equal(resolveApplicationUrl({ env: {} }), "https://www.groupon.com/");
});

test("blank HOMEPAGE is treated as unset", () => {
  assert.equal(
    resolveApplicationUrl({
      env: { HOMEPAGE: "   " },
      testCaseText: "Open the application homepage.",
    }),
    PROJECT_DEFAULT_APPLICATION_URL
  );
});

test("extractHttpUrl ignores trailing punctuation from Test Case prose", () => {
  assert.equal(
    extractHttpUrl("Navigate to https://www.groupon.com/."),
    "https://www.groupon.com/"
  );
  assert.equal(extractHttpUrl("No URL is present here."), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { PRODUCT_CONTEXT } from "./product-context.js";

test("product context describes Groupon deals without User Story specifics", () => {
  assert.match(PRODUCT_CONTEXT, /https:\/\/www\.groupon\.com\//);
  assert.match(PRODUCT_CONTEXT, /\/deals\/<slug>/);
  assert.doesNotMatch(PRODUCT_CONTEXT, /US-00[123]/);
  assert.doesNotMatch(PRODUCT_CONTEXT, /AI Deal Massage/);
  assert.doesNotMatch(PRODUCT_CONTEXT, /TC-001 always/);
  assert.match(PRODUCT_CONTEXT, /must never expand functional scope/);
  assert.match(PRODUCT_CONTEXT, /clues, not commands/);
  assert.match(PRODUCT_CONTEXT, /location, city, ZIP/);
  assert.match(PRODUCT_CONTEXT, /first result actually presented/);
  assert.match(PRODUCT_CONTEXT, /Record what the browser actually showed/);
  assert.match(PRODUCT_CONTEXT, /validate that exact value/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocationOrGeoFieldLabel } from "./discover.js";

test("search discovery does not select location, city, ZIP, or address fields as the search field", () => {
  assert.equal(isLocationOrGeoFieldLabel("Search city or zip code"), true);
  assert.equal(isLocationOrGeoFieldLabel("location-modal-search"), true);
  assert.equal(isLocationOrGeoFieldLabel("Enter your postal code"), true);
  assert.equal(isLocationOrGeoFieldLabel("Street address"), true);
  assert.equal(isLocationOrGeoFieldLabel("Search for deals"), false);
  assert.equal(isLocationOrGeoFieldLabel("Find local experiences"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { grouponDealSlug, isGrouponDealHref } from "./deal-url.js";

test("recognizes a Groupon /deals/<slug> URL", () => {
  assert.equal(
    isGrouponDealHref("https://www.groupon.com/deals/local-spa-package"),
    true
  );
  assert.equal(grouponDealSlug("https://www.groupon.com/deals/local-spa-package"), "local-spa-package");
});

test("query parameters after a deal slug still identify a Groupon deal", () => {
  assert.equal(
    isGrouponDealHref(
      "https://www.groupon.com/deals/local-spa-package?utm_source=search&page=1"
    ),
    true
  );
  assert.equal(
    grouponDealSlug(
      "https://www.groupon.com/deals/local-spa-package?utm_source=search"
    ),
    "local-spa-package"
  );
});

test("relative /deals/<slug> hrefs are Groupon deals", () => {
  assert.equal(isGrouponDealHref("/deals/weekend-escape"), true);
  assert.equal(grouponDealSlug("/deals/weekend-escape"), "weekend-escape");
});

test("non-deal hrefs are not treated as Groupon deals", () => {
  assert.equal(isGrouponDealHref("https://www.groupon.com/"), false);
  assert.equal(isGrouponDealHref("/gift-cards"), false);
  assert.equal(isGrouponDealHref("/deals"), false);
  assert.equal(isGrouponDealHref("/deals/"), false);
  assert.equal(isGrouponDealHref("#"), false);
  assert.equal(isGrouponDealHref("mailto:help@example.com"), false);
  assert.equal(isGrouponDealHref("tel:555"), false);
  assert.equal(isGrouponDealHref("javascript:void(0)"), false);
  assert.equal(isGrouponDealHref(undefined), false);
});

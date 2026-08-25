import assert from "node:assert/strict";
import { test } from "node:test";
import { assessLinkDestination, recordLinkDestination } from "./interaction.js";

const body =
  "Groupon Privacy Statement. This policy explains how we collect and use information when you visit our site. ".repeat(
    2
  );

function assertNoFunctionalJudgment(result: object): void {
  const record = result as Record<string, unknown>;
  assert.equal(record.kind, undefined);
  assert.equal(record.observedOutcome, undefined);
  assert.equal(record.notes, undefined);
  assert.equal(record.usable, undefined);
}

test("a successfully opened link whose final URL differs from href is not an Automation functional failure", () => {
  const result = recordLinkDestination({
    href: "https://www.groupon.com/legal/privacypolicy",
    originalUrl: "https://www.groupon.com/",
    finalUrl: "https://www.groupon.com/legal/privacy",
    title: "Privacy Statement",
    bodyText: body,
    navigationKind: "same-tab",
    reached: true,
  });

  assert.equal(result.reached, true);
  assert.equal(result.finalUrl, "https://www.groupon.com/legal/privacy");
  assert.equal(result.href, "https://www.groupon.com/legal/privacypolicy");
  assertNoFunctionalJudgment(result);
});

test("a successfully opened link that redirects to another domain is not an Automation functional failure", () => {
  const result = recordLinkDestination({
    href: "https://www.groupon.com/legal/privacypolicy",
    originalUrl: "https://www.groupon.com/",
    finalUrl: "https://privacy.groupon.com/",
    title: "Privacy Statement",
    bodyText: body,
    navigationKind: "popup",
    reached: true,
  });

  assert.equal(result.reached, true);
  assert.equal(result.finalUrl, "https://privacy.groupon.com/");
  assertNoFunctionalJudgment(result);
});

test("a successfully opened authentication page is not classified as a functional failure", () => {
  const result = recordLinkDestination({
    href: "https://www.groupon.com/login",
    finalUrl: "https://www.groupon.com/login",
    title: "Sign In",
    bodyText: "Log in to continue to your account. Enter your password.",
    passwordFieldPresent: true,
    reached: true,
  });

  assert.equal(result.reached, true);
  assert.equal(result.title, "Sign In");
  assert.equal(result.passwordFieldPresent, true);
  assert.notEqual(
    (result as { observedOutcome?: string }).observedOutcome,
    "authentication_required"
  );
  assertNoFunctionalJudgment(result);
});

test("a Playwright navigation execution failure remains an Automation failure", () => {
  const result = recordLinkDestination({
    href: "https://www.groupon.com/legal",
    playwrightError:
      "TimeoutError: locator.click: Timeout 15000ms exceeded while activating the link",
    reached: false,
  });

  assert.equal(result.reached, false);
  assert.match(result.playwrightError ?? "", /TimeoutError/);
  assertNoFunctionalJudgment(result);
});

test("existing assessLinkDestination import does not classify product correctness", () => {
  const result = assessLinkDestination({
    href: "https://www.groupon.com/legal/privacypolicy",
    finalUrl: "https://privacy.groupon.com/",
    title: "Sign In",
    bodyText: "",
    reached: true,
  });

  assert.equal(result.reached, true);
  assert.equal(result.usable, true);
  assert.equal((result as { kind?: string }).kind, undefined);
  assert.equal((result as { observedOutcome?: string }).observedOutcome, undefined);
});

test("search and page-load URL observations are not treated as link expected values", () => {
  const searchResult = recordLinkDestination({
    href: "https://www.groupon.com/",
    finalUrl: "https://www.groupon.com/search?query=massage",
    title: "Search results",
    bodyText: body,
    reached: true,
  });
  assert.equal(searchResult.reached, true);
  assertNoFunctionalJudgment(searchResult);

  const pageLoad = recordLinkDestination({
    href: "https://www.groupon.com/",
    finalUrl: "https://www.groupon.com/",
    title: "Groupon",
    bodyText: body,
    reached: true,
  });
  assert.equal(pageLoad.reached, true);
  assertNoFunctionalJudgment(pageLoad);
});

/**
 * Reusable product and automation context for generated Playwright specs.
 *
 * This describes how the application under test is used, not what any
 * particular Test Case must assert. Test Case steps, search terms, deal
 * titles, and expected results come only from the Analyst Test Case.
 */

export const PRODUCT_CONTEXT = `
## Product and automation context

The application under test is Groupon.
The default application homepage is https://www.groupon.com/.
The homepage does not need to be restated in every Test Case.

URL resolution (reusable):
1. Explicit URL from the Test Case, when present.
2. Optional HOMEPAGE or BASE_URL override, when configured.
3. Otherwise the project default Groupon homepage.

HOMEPAGE is never a mandatory prerequisite.

Search is a reusable user interaction:
- Locate the actual visible site/application search control.
- Do not use location, city, ZIP, address, or other geo/contextual fields as search.
- Enter the query from the Test Case.
- Submit with Enter. A Search button is optional and is not the search input.
- Wait for the resulting UI, then continue the Test Case.
- Do not construct or navigate to a search URL.
- Do not hard-code any search term; use the Test Case query.

Deals / search results:
- Groupon search results are user-facing deal/result cards.
- A Groupon deal is a rendered result/card associated with a /deals/<slug> destination.
- Query parameters after the slug do not change that it is a deal.
- A deal is not a generic heading, page title, "Results for <query>" heading, first link, first clickable, banner, or navigation item.
- When the Test Case refers to the first displayed result, identify the first result actually presented to the user.
- Identify actual /deals/ cards in the current viewport, then extract the visible title from that selected card.
- Do not use h1, h2, h3, h4, or role=heading as a deal-discovery strategy.
- Do not scroll looking for an expected title. Do not search later results for an expected value.
- Do not change the Test Case expected value. If the Test Case names a specific expected title or entity, validate that exact value against the observed result.
- Do not hard-code any deal title or slug; the expected value comes from the Test Case.

Modals / overlays:
- Consent, promotional, location, and similar dialogs are normal.
- They may appear after load, during discovery, before/after search, while results load, before/after navigation, and while opening links.
- Dismiss with a visible user-facing control (Close, X, Cancel, Continue, Accept, No Thanks, equivalent).
- Re-check for additional overlays after dismissal. Handle multiple overlays sequentially.
- Do not use force:true. A dismissed modal is not a Test Case failure and is not a reason to stop if the journey can continue.
- Keep modal handling active for the whole journey.
- If a blocking modal cannot be dismissed, the Automation result is FAILED with a reason describing what stopped execution.

Live UI discovery:
- Do not assume a locator, ARIA role, or CSS selector exists.
- Prefer accessible role/name, then label, placeholder, visible text, input type, name/id, test id, surrounding structure.
- A missed first locator strategy is not a functional failure.

Test Case interpretation:
- Follow the complete Test Case. Title, objective, steps, expected result, and other explicit instructions together determine the journey.
- Words such as search, find, locate, result, deal, link, or homepage are clues, not commands.
- Perform only the actions and validations required to prove THIS Test Case.
- Product context must never expand functional scope. Available features are not required checks.
- Analyze every Test Case independently. Do not carry journeys from previous Test Cases.
- A page-load Test Case must not invent search, link, or deal checks.
- A search Test Case must not be replaced with generic homepage link collection.
- A deal mention is not a search journey unless the Test Case requires searching.
- Customer-facing links: discover, open, follow new tabs/pages, observe the resulting page, then record raw navigation evidence. finalUrl, title, and visible text are observational. Apply destination validations only when the Test Case requires usable/meaningful content or a specific destination. Do not treat a redirect or URL rewrite as a failure unless the Test Case specifies the destination. Do not invent failure categories such as FUNCTIONAL vs TECHNICAL.
- If a page or tab closes, continue on the remaining open page whenever the journey can still continue.
- Record what the browser actually showed and whether each Test Case validation succeeded. Do not invent failure categories such as FUNCTIONAL vs TECHNICAL.
- Automation status is only PASSED or FAILED. PASSED means the user journey was executed and every Test Case validation succeeded. A Playwright run that completes without an exception is not PASSED by itself. FAILED means a required validation did not hold, the journey could not be executed, or generation failed. Never write INCONCLUSIVE.
`.trim();

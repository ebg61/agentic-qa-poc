import { expect, test } from "@playwright/test";
import {
  activateNavigableLink,
  closeOpenedPageIfDifferent,
  isNonNavigatingHref,
  listNavigableLinks,
  observePage,
  recordLinkDestination,
  restorePage,
} from "./interaction.js";
import { preparePageForInteraction } from "./overlay.js";
import { safeEvaluateNoArg } from "./page-guard.js";

test.describe("QA Automation page lifecycle helpers", () => {
  test("href=# is not treated as a navigable destination", () => {
    expect(isNonNavigatingHref("#")).toBe(true);
    expect(isNonNavigatingHref("javascript:void(0)")).toBe(true);
    expect(isNonNavigatingHref("mailto:test@example.com")).toBe(true);
    expect(isNonNavigatingHref("/deals")).toBe(false);
  });

  test("link discovery skips href=# and does not close the page", async ({
    page,
  }) => {
    await page.setContent(`
      <a href="#">Skip</a>
      <a href="javascript:void(0)">Noop</a>
      <a href="/real">Real</a>
    `);

    const links = await listNavigableLinks(page);

    expect(links.map((link) => link.href)).toEqual(["/real"]);
    expect(page.isClosed()).toBe(false);
    const tag = await page.evaluate(() => document.body.tagName);
    expect(tag).toBe("BODY");
  });

  test("href=# click is handled without waiting for navigation or closing the page", async ({
    page,
  }) => {
    await page.setContent(`
      <a href="#" id="hash">Skip</a>
      <p id="status">ready</p>
    `);
    await preparePageForInteraction(page);

    const activation = await activateNavigableLink(
      page,
      page.locator("#hash")
    );

    expect(activation.kind).toBe("in-page");
    expect(page.isClosed()).toBe(false);
    const status = await page.evaluate(
      () => document.getElementById("status")?.textContent
    );
    expect(status).toBe("ready");
  });

  test("locator click on href=# does not close the page after modal handling", async ({
    page,
  }) => {
    await page.setContent(`
      <a href="#" id="hash">Skip</a>
      <main id="home">Home</main>
    `);
    await preparePageForInteraction(page);
    await page.locator("#hash").click();

    expect(page.isClosed()).toBe(false);
    await expect(page.locator("#home")).toHaveText("Home");
    const tag = await page.evaluate(() => document.body.tagName);
    expect(tag).toBe("BODY");
  });

  test("search interaction continues on the live page", async ({ page }) => {
    await page.setContent(`
      <input id="q" placeholder="Search" />
      <button type="button" aria-label="Search">Search</button>
      <p id="status">idle</p>
      <script>
        document.getElementById("q").addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            document.getElementById("status").textContent = "submitted";
          }
        });
      </script>
    `);
    await preparePageForInteraction(page);
    await page.locator("#q").fill("massage");
    await page.locator("#q").press("Enter");

    await expect(page.locator("#status")).toHaveText("submitted");
    expect(page.isClosed()).toBe(false);
    const value = await page.evaluate(() => {
      const input = document.getElementById("q");
      return input instanceof HTMLInputElement ? input.value : "";
    });
    expect(value).toBe("massage");
  });

  test("modal dismissal leaves the page usable for evaluate", async ({
    page,
  }) => {
    await page.setContent(`
      <main id="home">Home</main>
      <div role="dialog" aria-modal="true" data-state="open" style="position:fixed;inset:0;background:white;z-index:50">
        <p>Location</p>
        <button type="button">Close</button>
      </div>
      <script>
        document.querySelector("button").addEventListener("click", (event) => {
          event.currentTarget.closest("[role=dialog]").remove();
        });
      </script>
    `);

    const overlay = await preparePageForInteraction(page);
    expect(overlay.functionalTestContinued).toBe(true);
    expect(page.isClosed()).toBe(false);
    const text = await page.evaluate(
      () => document.getElementById("home")?.textContent
    );
    expect(text).toBe("Home");
  });

  test("popup handling keeps the original page open", async ({ page }) => {
    await page.setContent(`<a id="open" href="about:blank" target="_blank">Open</a>`);
    await preparePageForInteraction(page);
    const originalUrl = page.url();

    const activation = await activateNavigableLink(page, page.locator("#open"));
    expect(page.isClosed()).toBe(false);
    expect(activation.kind).toBe("popup");
    expect(activation.page.isClosed()).toBe(false);

    await closeOpenedPageIfDifferent(page, activation.page);
    expect(page.isClosed()).toBe(false);
    await restorePage(page, originalUrl);
    expect(page.isClosed()).toBe(false);
    const tag = await page.evaluate(() => document.body.tagName);
    expect(tag).toBe("BODY");
  });

  test("safeEvaluate does not run against a closed page", async ({ page }) => {
    const extra = await page.context().newPage();
    await extra.setContent("<p>extra</p>");
    await extra.close();

    const closedResult = await safeEvaluateNoArg(extra, () => 1);
    expect(closedResult).toBeUndefined();
    expect(page.isClosed()).toBe(false);

    const liveResult = await safeEvaluateNoArg(page, () => 2);
    expect(liveResult).toBe(2);
  });

  test("observePage continues on a remaining open page after the original closes", async ({
    page,
    context,
  }) => {
    await page.setContent(`<main><h1>Keep me</h1></main>`);
    const doomed = await context.newPage();
    await doomed.setContent(`<p>closing</p>`);
    await doomed.close();

    const observed = await observePage(doomed);

    expect(observed.pageOpen).toBe(true);
    expect(observed.bodyText).toMatch(/Keep me/);
    expect((observed as { kind?: string }).kind).toBeUndefined();
  });

  test("observePage records destination evidence without classifying the product outcome", async ({
    page,
  }) => {
    await page.setContent(`<main><h1>Opened destination</h1><p>Visible copy</p></main>`);
    await page.evaluate(() => {
      document.title = "Observed title";
    });

    const observed = await observePage(page);
    const evidence = recordLinkDestination({
      href: "/opened",
      originalUrl: "about:blank",
      finalUrl: observed.url,
      title: observed.title,
      bodyText: observed.bodyText,
      reached: observed.pageOpen,
    });

    expect(observed.pageOpen).toBe(true);
    expect(observed.title).toBe("Observed title");
    expect(observed.bodyText).toMatch(/Opened destination/);
    expect(evidence.reached).toBe(true);
    expect((evidence as { kind?: string }).kind).toBeUndefined();
    expect((evidence as { observedOutcome?: string }).observedOutcome).toBeUndefined();
  });

  test("opening a link dismisses an overlay on the destination before observation", async ({
    page,
  }) => {
    await page.setContent(`<a id="open" href="about:blank" target="_blank">Open</a>`);
    await preparePageForInteraction(page);

    const activation = await activateNavigableLink(page, page.locator("#open"));
    expect(activation.kind).toBe("popup");

    await activation.page.setContent(`
      <main><h1>Destination</h1></main>
      <div role="dialog" aria-modal="true" data-state="open" style="position:fixed;inset:0;background:white;z-index:50">
        <p>Promo</p>
        <button type="button">Close</button>
      </div>
      <script>
        document.querySelector("button").addEventListener("click", (event) => {
          event.currentTarget.closest("[role=dialog]").remove();
        });
      </script>
    `);

    const observed = await observePage(activation.page);

    expect(observed.pageOpen).toBe(true);
    await expect(activation.page.getByRole("dialog")).toHaveCount(0);
    expect(observed.bodyText).toMatch(/Destination/);
    await closeOpenedPageIfDifferent(page, activation.page);
  });
});

import { expect, test } from "@playwright/test";
import {
  overlayHandlingState,
  preparePageForInteraction,
  withModalHandling,
} from "./overlay.js";

test.describe("QA Automation overlay helper", () => {
  test("zero candidates continues without treating an overlay as present", async ({
    page,
  }) => {
    await page.setContent(pageMarkup(`<main><h1>Home</h1><p>Ready</p></main>`));

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(false);
    expect(result.functionalTestContinued).toBe(true);
    expect(result.dismissalMethod).toBe("none");
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  });

  test("one visible blocking dialog with Close is dismissed and the journey continues", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main><h1>Home</h1></main>
        ${blockingDialog("Close")}
      `)
    );

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(true);
    expect(result.dismissalSucceeded).toBe(true);
    expect(result.dismissalMethod).toBe("visible_dismiss_control");
    expect(result.functionalTestContinued).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  });

  test("a dialog with Cancel is dismissed using the visible dismissal control", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main><h1>Home</h1></main>
        ${blockingDialog("Cancel")}
      `)
    );

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(true);
    expect(result.dismissalSucceeded).toBe(true);
    expect(result.dismissalMethod).toBe("visible_dismiss_control");
    expect(result.functionalTestContinued).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("multiple candidates: only the blocking overlay is dismissed", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <div data-state="open" id="menu" style="position:absolute;top:0;left:0;width:80px;height:40px;z-index:20">
          Menu
        </div>
        <main><h1>Home</h1></main>
        ${blockingDialog("Close")}
      `)
    );

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(true);
    expect(result.dismissalSucceeded).toBe(true);
    expect(result.functionalTestContinued).toBe(true);
    await expect(page.locator("#menu")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("multiple visible overlay candidates are resolved without a strict-mode failure", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <div data-state="open" id="scrim" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:40"></div>
        <div role="dialog" data-state="open" aria-modal="true" id="dialog" style="position:fixed;inset:10% 15%;z-index:50;background:white;padding:24px">
          <p>Choose an option</p>
          <button type="button" id="dialog-close">Close</button>
        </div>
        <script>
          document.getElementById("dialog-close").addEventListener("click", () => {
            document.getElementById("scrim")?.remove();
            document.getElementById("dialog")?.remove();
          });
        </script>
      `)
    );

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(true);
    expect(result.dismissalSucceeded).toBe(true);
    expect(result.functionalTestContinued).toBe(true);
    await expect(page.locator("#scrim")).toHaveCount(0);
    await expect(page.locator("#dialog")).toHaveCount(0);
  });

  test("late-appearing overlay is detected and dismissed", async ({ page }) => {
    await page.setContent(
      pageMarkup(`
        <main><h1>Home</h1></main>
        <script>
          setTimeout(() => {
            document.body.insertAdjacentHTML("beforeend", \`${blockingDialog("Close")}\`);
            bindCloseButtons();
          }, 600);
        </script>
      `)
    );

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(true);
    expect(result.dismissalSucceeded).toBe(true);
    expect(result.functionalTestContinued).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("blocking overlay without a safe dismissal control fails the Playwright action", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main><h1>Home</h1></main>
        <div role="dialog" aria-modal="true" data-state="open" style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:50">
          <p>Locked overlay</p>
        </div>
      `)
    );

    await expect(preparePageForInteraction(page)).rejects.toThrow(
      /could not be safely dismissed/i
    );
    expect(overlayHandlingState(page).overlayDetected).toBe(true);
    expect(overlayHandlingState(page).dismissalSucceeded).toBe(false);
    expect(overlayHandlingState(page).functionalTestContinued).toBe(false);
  });

  test("no overlay leaves normal page interaction working", async ({ page }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <h1>Home</h1>
          <button type="button" id="go">Continue</button>
          <p id="status">idle</p>
        </main>
        <script>
          document.getElementById("go").addEventListener("click", () => {
            document.getElementById("status").textContent = "clicked";
          });
        </script>
      `)
    );

    const result = await preparePageForInteraction(page);
    expect(result.overlayDetected).toBe(false);
    expect(result.functionalTestContinued).toBe(true);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("#status")).toHaveText("clicked");
  });

  test("location modal visible immediately is dismissed before the action proceeds", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <h1>Home</h1>
          <button type="button" id="search">Search</button>
          <p id="status">idle</p>
        </main>
        ${blockingDialog("Close", "Select your location")}
        <script>
          document.getElementById("search").addEventListener("click", () => {
            document.getElementById("status").textContent = "searched";
          });
        </script>
      `)
    );

    await preparePageForInteraction(page);
    await page.getByRole("button", { name: "Search" }).click();

    expect(overlayHandlingState(page).overlayDetected).toBe(true);
    expect(overlayHandlingState(page).dismissalSucceeded).toBe(true);
    expect(overlayHandlingState(page).functionalTestContinued).toBe(true);
    await expect(page.locator("#status")).toHaveText("searched");
  });

  test("offer modal that appears after an interaction is dismissed before the next action", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <button type="button" id="open">Browse</button>
          <button type="button" id="next">Continue</button>
          <p id="status">idle</p>
        </main>
        <script>
          document.getElementById("open").addEventListener("click", () => {
            document.body.insertAdjacentHTML("beforeend", \`${blockingDialog("Close", "Special offer")}\`);
            bindCloseButtons();
          });
          document.getElementById("next").addEventListener("click", () => {
            document.getElementById("status").textContent = "continued";
          });
        </script>
      `)
    );

    await preparePageForInteraction(page);
    expect(overlayHandlingState(page).overlayDetected).toBe(false);

    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    expect(overlayHandlingState(page).overlayDetected).toBe(true);
    expect(overlayHandlingState(page).dismissalSucceeded).toBe(true);
    expect(overlayHandlingState(page).occurrences?.length ?? 0).toBeGreaterThan(0);
    await expect(page.locator("#status")).toHaveText("continued");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("modals that appear multiple times in one flow can each be dismissed", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <button type="button" id="first">First</button>
          <button type="button" id="second">Second</button>
          <p id="status">idle</p>
        </main>
        ${blockingDialog("Close", "Location")}
        <script>
          document.getElementById("first").addEventListener("click", () => {
            document.getElementById("status").textContent = "first";
            document.body.insertAdjacentHTML("beforeend", \`${blockingDialog("Close", "Offer")}\`);
            bindCloseButtons();
          });
          document.getElementById("second").addEventListener("click", () => {
            document.getElementById("status").textContent = "second";
          });
        </script>
      `)
    );

    await preparePageForInteraction(page);
    await page.getByRole("button", { name: "First" }).click();
    await page.getByRole("button", { name: "Second" }).click();

    expect(overlayHandlingState(page).occurrences?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(overlayHandlingState(page).functionalTestContinued).toBe(true);
    await expect(page.locator("#status")).toHaveText("second");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a modal that intercepts an action is dismissed and the action is retried once", async ({
    page,
  }) => {
    await page.setContent(pageMarkup(`<main><h1>Home</h1></main>`));
    await preparePageForInteraction(page);

    let attempts = 0;
    await withModalHandling(page, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "locator.click: <div data-state=\"open\"> intercepts pointer events"
        );
      }
    });

    expect(attempts).toBe(2);
    expect(overlayHandlingState(page).retryRequired).toBe(true);
  });

  test("intercepted actions are not retried in an infinite loop", async ({
    page,
  }) => {
    await page.setContent(pageMarkup(`<main><h1>Home</h1></main>`));
    await preparePageForInteraction(page);

    let attempts = 0;
    await expect(
      withModalHandling(page, async () => {
        attempts += 1;
        throw new Error("locator.click: overlay intercepts pointer events");
      })
    ).rejects.toThrow(/intercepts pointer events/);

    expect(attempts).toBe(2);
  });

  test("after overlay dismissal the first displayed title is observed without hunting a later expected title", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <button type="button" id="search">Search</button>
          <article data-deal hidden>
            <h2 id="deal-title">Other Deal</h2>
          </article>
          <article hidden>
            <h2>Expected Title Elsewhere</h2>
          </article>
        </main>
        ${blockingDialog("Close", "Location")}
        <script>
          document.getElementById("search").addEventListener("click", () => {
            document.querySelector("[data-deal]").hidden = false;
          });
        </script>
      `)
    );

    const overlay = await preparePageForInteraction(page);
    expect(overlay.functionalTestContinued).toBe(true);

    await page.getByRole("button", { name: "Search" }).click();
    const title = await page.locator("#deal-title").textContent();

    expect(overlayHandlingState(page).overlayDetected).toBe(true);
    expect(overlayHandlingState(page).functionalTestContinued).toBe(true);
    expect(title).toBe("Other Deal");
    expect(title).not.toBe("Expected Title Elsewhere");
  });

  test("a modal that appears after later navigation is dismissed before the next action", async ({
    page,
  }) => {
    await page.setContent(pageMarkup(`<main><h1>Home</h1></main>`));
    await preparePageForInteraction(page);

    await page.goto(
      "data:text/html," +
        encodeURIComponent(
          pageMarkup(`
            <main>
              <h1>Next page</h1>
              <button type="button" id="go">Continue</button>
              <p id="status">idle</p>
            </main>
            ${blockingDialog("Close", "After navigation")}
            <script>
              document.getElementById("go").addEventListener("click", () => {
                document.getElementById("status").textContent = "continued";
              });
            </script>
          `)
        )
    );

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("#status")).toHaveText("continued");
    expect(overlayHandlingState(page).overlayDetected).toBe(true);
    expect(overlayHandlingState(page).functionalTestContinued).toBe(true);
  });

  test("search submit with Enter is guarded so a modal can be dismissed first", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <input id="q" />
          <p id="status">idle</p>
        </main>
        <script>
          document.getElementById("q").addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              document.getElementById("status").textContent = "submitted";
            }
          });
        </script>
      `)
    );

    await preparePageForInteraction(page);
    await page.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      (
        globalThis as unknown as { bindCloseButtons: () => void }
      ).bindCloseButtons();
    }, blockingDialog("Close", "Offer"));

    await page.locator("#q").press("Enter");

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("#status")).toHaveText("submitted");
    expect(overlayHandlingState(page).overlayDetected).toBe(true);
    expect(overlayHandlingState(page).functionalTestContinued).toBe(true);
  });

  test("an overlay that appears while search results are loading is dismissed so the journey can continue", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <input id="q" placeholder="Search" />
          <section id="results">idle</section>
        </main>
        <script>
          document.getElementById("q").addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            document.getElementById("results").textContent = "loading";
            setTimeout(() => {
              document.body.insertAdjacentHTML("beforeend", \`${blockingDialog("Close", "Results promo")}\`);
              bindCloseButtons();
              document.getElementById("results").textContent = "shown";
            }, 250);
          });
        </script>
      `)
    );

    await preparePageForInteraction(page);
    await page.locator("#q").fill("query");
    await page.locator("#q").press("Enter");
    const overlay = await preparePageForInteraction(page, {
      waitForAppearanceMs: 1200,
    });

    expect(overlay.overlayDetected).toBe(true);
    expect(overlay.dismissalSucceeded).toBe(true);
    expect(overlay.functionalTestContinued).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("#results")).toHaveText("shown");
  });

  test("sequential blocking overlays are dismissed so the page becomes usable", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main><h1>Home</h1></main>
        ${blockingDialog("Close", "First overlay")}
        ${blockingDialog("Close", "Second overlay")}
      `)
    );

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(true);
    expect(result.dismissalSucceeded).toBe(true);
    expect(result.functionalTestContinued).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  });

  test("a covering location picker without a dialog role is dismissed", async ({
    page,
  }) => {
    await page.setContent(
      pageMarkup(`
        <main>
          <h1>Home</h1>
          <input id="q" placeholder="Search" />
        </main>
        <div id="geo-layer" style="position:fixed;inset:0;background:white;z-index:80">
          <p>Choose your city</p>
          <input placeholder="Search city or zip code" name="location-modal-search" />
          <button type="button" id="geo-close">Close</button>
        </div>
        <script>
          document.getElementById("geo-close").addEventListener("click", () => {
            document.getElementById("geo-layer")?.remove();
          });
        </script>
      `)
    );

    const result = await preparePageForInteraction(page);

    expect(result.overlayDetected).toBe(true);
    expect(result.dismissalSucceeded).toBe(true);
    expect(result.functionalTestContinued).toBe(true);
    await expect(page.locator("#geo-layer")).toHaveCount(0);
    await expect(page.locator("#q")).toBeVisible();
  });
});

function pageMarkup(body: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Overlay helper fixture</title>
    <script>
      function bindCloseButtons() {
        for (const button of document.querySelectorAll("button")) {
          const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
          if (!/^(close|cancel|dismiss)$/i.test(label) || button.dataset.bound === "1") continue;
          button.dataset.bound = "1";
          button.addEventListener("click", () => {
            const dialog = button.closest('[role="dialog"]');
            let host = dialog || button.closest('[data-state="open"]');
            if (!host) return;
            while (
              host.parentElement &&
              host.parentElement !== document.body &&
              (host.parentElement.getAttribute("data-state") === "open" ||
                host.parentElement.getAttribute("role") === "dialog")
            ) {
              host = host.parentElement;
            }
            host.remove();
          });
        }
      }
      document.addEventListener("DOMContentLoaded", bindCloseButtons);
    </script>
  </head>
  <body>
    ${body}
    <script>bindCloseButtons();</script>
  </body>
</html>`;
}

function blockingDialog(closeLabel: string, title = "Blocking dialog"): string {
  return `
    <div data-state="open" style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:40;display:flex;align-items:center;justify-content:center">
      <div role="dialog" data-state="open" aria-modal="true" style="background:white;padding:24px;z-index:50">
        <p>${title}</p>
        <button type="button">${closeLabel}</button>
      </div>
    </div>
  `;
}

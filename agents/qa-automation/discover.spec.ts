import { expect, test } from "@playwright/test";
import {
  ControlNotFoundError,
  findUserFacingControl,
  readFirstDisplayedItemTitle,
  readFirstVisibleDeal,
  submitSearch,
} from "./discover.js";
import {
  assertObservedMatchesExpected,
  firstDisplayedMatchesExpected,
} from "./validation.js";

test.describe("QA Automation UI discovery helper", () => {
  test("finds a searchbox role when the application exposes it", async ({
    page,
  }) => {
    await page.setContent(
      markup(`<input role="searchbox" aria-label="Search" />`)
    );

    const found = await findUserFacingControl(page, {
      kind: "search-input",
      names: ["search"],
    });

    expect(found.strategy).toMatch(/role:searchbox/);
    await found.locator.fill("massage");
    await expect(found.locator).toHaveValue("massage");
  });

  test("falls back to a combobox when searchbox is absent", async ({ page }) => {
    await page.setContent(
      markup(`<input role="combobox" aria-label="Search deals" />`)
    );

    const found = await findUserFacingControl(page, {
      kind: "search-input",
      names: ["search"],
    });

    expect(found.strategy).toMatch(/role:combobox/);
    await found.locator.fill("massage");
    await expect(found.locator).toHaveValue("massage");
  });

  test("finds a plain input by placeholder after role locators miss", async ({
    page,
  }) => {
    await page.setContent(markup(`<input type="text" placeholder="Search" />`));

    const found = await findUserFacingControl(page, {
      kind: "search-input",
      names: ["search"],
    });

    expect(found.strategy).toMatch(/getByPlaceholder|attributes|role:textbox/);
    await found.locator.fill("massage");
    await expect(found.locator).toHaveValue("massage");
  });

  test("finds a control by id after accessible-name strategies miss", async ({
    page,
  }) => {
    await page.setContent(markup(`<input id="site-search-field" />`));

    const found = await findUserFacingControl(page, {
      kind: "search-input",
      names: ["search"],
    });

    expect(found.strategy).toMatch(/attributes|first visible text input/);
    await found.locator.fill("massage");
    await expect(found.locator).toHaveValue("massage");
  });

  test("a missed first locator is not treated as a functional failure", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <button type="button">Unrelated</button>
        <input data-testid="global-search" />
      `)
    );

    const found = await findUserFacingControl(page, {
      kind: "search-input",
      names: ["search"],
    });

    expect(found.candidatesTried.length).toBeGreaterThan(1);
    await found.locator.fill("ok");
    await expect(found.locator).toHaveValue("ok");
  });

  test("search-input discovery does not return a Search button", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <button type="button" id="desktop-search-button" aria-label="Search" data-testid="desktop-search-button">Search</button>
        <input id="search-input" placeholder="Search for deals" />
      `)
    );

    const found = await findUserFacingControl(page, {
      kind: "search-input",
      names: ["search"],
    });

    await found.locator.fill("massage");
    await expect(found.locator).toHaveValue("massage");
    await expect(page.locator("#desktop-search-button")).toBeVisible();
    expect(page.isClosed()).toBe(false);
  });

  test("search-input discovery does not use a location or city/zip field", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <input name="location-modal-search" placeholder="Search city or zip code" />
        <input type="search" placeholder="Search" aria-label="Search" id="site-search" />
      `)
    );

    const found = await findUserFacingControl(page, {
      kind: "search-input",
      names: ["search", "find"],
    });

    await found.locator.fill("massage");
    await expect(found.locator).toHaveValue("massage");
    expect(await found.locator.getAttribute("name")).not.toBe(
      "location-modal-search"
    );
    await expect(page.locator("#site-search")).toHaveValue("massage");
  });

  test("submitSearch types into the text input and presses Enter without a Search button", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <input id="q" placeholder="Search" />
        <p id="status">idle</p>
        <script>
          document.getElementById("q").addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              document.getElementById("status").textContent = document.getElementById("q").value;
            }
          });
        </script>
      `)
    );

    const submitted = await submitSearch(page, "massage");

    expect(submitted.submittedBy).toBe("enter");
    await expect(submitted.input.locator).toHaveValue("massage");
    await expect(page.locator("#status")).toHaveText("massage");
    expect(page.isClosed()).toBe(false);
  });

  test("submitSearch does not treat a Search button as the search input", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <button type="button" id="desktop-search-button" aria-label="Search">Search</button>
        <input id="q" placeholder="Search for deals" />
        <p id="status">idle</p>
        <script>
          document.getElementById("desktop-search-button").addEventListener("click", () => {
            document.getElementById("status").textContent = "button";
          });
          document.getElementById("q").addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              document.getElementById("status").textContent = "enter";
            }
          });
        </script>
      `)
    );

    const submitted = await submitSearch(page, "massage");

    expect(submitted.submittedBy).toBe("enter");
    await expect(page.locator("#q")).toHaveValue("massage");
    await expect(page.locator("#status")).toHaveText("enter");
    await expect(page.locator("#desktop-search-button")).toBeVisible();
  });

  test("submitSearch does not type a deal query into a location or city/zip field", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <input name="location-modal-search" placeholder="Search city or zip code" />
        <input id="q" placeholder="Search for deals" />
        <p id="status">idle</p>
        <script>
          document.getElementById("q").addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              document.getElementById("status").textContent = document.getElementById("q").value;
            }
          });
        </script>
      `)
    );

    const submitted = await submitSearch(page, "massage");

    expect(submitted.submittedBy).toBe("enter");
    await expect(page.locator("#q")).toHaveValue("massage");
    await expect(page.locator("[name='location-modal-search']")).toHaveValue("");
    await expect(page.locator("#status")).toHaveText("massage");
  });

  test("discovery does not close the page", async ({ page }) => {
    await page.setContent(markup(`<input placeholder="Search" />`));
    await findUserFacingControl(page, { kind: "search-input", names: ["search"] });
    const marker = await page.evaluate(() => document.body.tagName);
    expect(marker).toBe("BODY");
    expect(page.isClosed()).toBe(false);
  });

  test("reads the first displayed deal and does not search later items", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <article><a href="/deals/first-visible-offer"><h2>First Visible Offer</h2></a></article>
          <article><a href="/deals/later-visible-offer"><h2>Later Visible Offer</h2></a></article>
        </main>
      `)
    );

    const first = await readFirstDisplayedItemTitle(page);

    expect(first.text).toBe("First Visible Offer");
    expect(first.title).toBe("First Visible Offer");
    expect(first.text).not.toBe("Later Visible Offer");
    expect(first.href).toMatch(/\/deals\/first-visible-offer/);
    expect(first.url).toMatch(/\/deals\/first-visible-offer/);
    expect(first.destination).toMatch(/\/deals\/first-visible-offer/);
  });

  test("does not treat the first page link, header nav, or generic heading as a deal", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <h1>Results for spa</h1>
        <h2>Popular near you</h2>
        <a href="/help">Help</a>
        <header>
          <nav>
            <ul>
              <li><a href="/">Home</a></li>
              <li><a href="/deals/header-promo">Header Promo</a></li>
            </ul>
          </nav>
        </header>
        <main>
          <section aria-label="Search results">
            <article data-testid="deal-card">
              <a href="https://www.groupon.com/deals/local-spa-package">
                <h2>First Deal Card</h2>
              </a>
            </article>
            <article data-testid="deal-card">
              <a href="https://www.groupon.com/deals/second-spa-package">
                <h2>Second Deal Card</h2>
              </a>
            </article>
          </section>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.text).toBe("First Deal Card");
    expect(first.text).not.toBe("Help");
    expect(first.text).not.toBe("Home");
    expect(first.text).not.toBe("Header Promo");
    expect(first.text).not.toBe("Results for spa");
    expect(first.text).not.toBe("Popular near you");
    expect(first.href).toMatch(/\/deals\/local-spa-package/);
  });

  test("does not hunt later deals for an expected title elsewhere on the page", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <nav><a href="/featured">Expected Title Elsewhere</a></nav>
        <h1>Results for dinner</h1>
        <main>
          <ul>
            <li>
              <article>
                <a href="/deals/visible-first-offer"><h2>Visible First Deal</h2></a>
              </article>
            </li>
            <li>
              <article>
                <a href="/deals/matching-later-offer"><h2>Expected Title Elsewhere</h2></a>
              </article>
            </li>
          </ul>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.text).toBe("Visible First Deal");
    expect(first.href).toMatch(/\/deals\/visible-first-offer/);
  });

  test("a matching first displayed result satisfies the Test Case validation", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <article>
            <a href="/deals/sunset-spa-package"><h2>Sunset Spa Package</h2></a>
          </article>
          <article>
            <a href="/deals/harbor-cruise"><h2>Harbor Cruise</h2></a>
          </article>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);
    expect(
      firstDisplayedMatchesExpected([first], "Sunset Spa Package")
    ).toBe(true);
    expect(() =>
      assertObservedMatchesExpected(
        first.title,
        "Sunset Spa Package",
        "First visible result title"
      )
    ).not.toThrow();
  });

  test("a missing expected first displayed result fails the Test Case validation during execution", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <article>
            <a href="/deals/city-walking-tour"><h2>City Walking Tour</h2></a>
          </article>
          <article>
            <a href="/deals/sunset-spa-package"><h2>Sunset Spa Package</h2></a>
          </article>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);
    expect(
      firstDisplayedMatchesExpected([first], "Sunset Spa Package")
    ).toBe(false);
    expect(() =>
      assertObservedMatchesExpected(
        first.title,
        "Sunset Spa Package",
        "First visible result title"
      )
    ).toThrow(/did not match expected/);
  });

  test("recognizes a Groupon deal URL with query parameters", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <a href="https://www.groupon.com/deals/weekend-escape?utm_source=search&page=1">Weekend Escape</a>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.text).toBe("Weekend Escape");
    expect(first.href).toContain("/deals/weekend-escape");
    expect(first.href).toContain("utm_source=search");
  });

  test("associates a deal link with its result/card container", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <article data-testid="result-card">
            <p>Sponsored</p>
            <a href="/deals/card-associated-offer">Card Associated Offer</a>
          </article>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.text).toBe("Card Associated Offer");
    expect(first.strategy).toMatch(/\/deals\//);
  });

  test("selects the first visible deal by visual order", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(
      markup(`
        <main style="position: relative; height: 600px;">
          <a href="/deals/below-card" style="position: absolute; top: 240px; left: 20px;">Below Card</a>
          <a href="/deals/right-card" style="position: absolute; top: 20px; left: 320px;">Right Card</a>
          <a href="/deals/top-left-card" style="position: absolute; top: 20px; left: 20px;">Top Left Card</a>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.text).toBe("Top Left Card");
    expect(first.href).toMatch(/\/deals\/top-left-card/);
  });

  test("does not scroll to select a later deal below the viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 360 });
    await page.setContent(
      markup(`
        <main style="position: relative; height: 3000px;">
          <a href="/deals/in-viewport-offer" style="position: absolute; top: 20px;">In Viewport Offer</a>
          <a href="/deals/below-fold-offer" style="position: absolute; top: 2200px;">Expected Title Later</a>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.text).toBe("In Viewport Offer");
    expect(first.text).not.toBe("Expected Title Later");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("generic headings without a /deals/ destination are not deals", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <h1>Results for spa</h1>
        <h2>Nearby experiences</h2>
        <h3 role="heading">Featured</h3>
        <a href="/local/chicago">Chicago</a>
        <button type="button">Filter</button>
      `)
    );

    await expect(readFirstVisibleDeal(page)).rejects.toBeInstanceOf(
      ControlNotFoundError
    );
  });

  test("fails technically when the first visible deal has no extractable title", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <a href="/deals/untitled-offer" style="display:block;width:120px;height:40px;"></a>
          <a href="/deals/titled-later-offer">Titled Later Offer</a>
        </main>
      `)
    );

    await expect(readFirstVisibleDeal(page)).rejects.toBeInstanceOf(
      ControlNotFoundError
    );
  });

  test("recognizes a Groupon deal URL with a fragment", async ({ page }) => {
    await page.setContent(
      markup(`
        <main>
          <a href="/deals/fragment-offer#details">Fragment Offer</a>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.title).toBe("Fragment Offer");
    expect(first.href).toContain("/deals/fragment-offer");
    expect(first.url).toContain("/deals/fragment-offer");
  });

  test("does not treat a URL that merely contains the deals substring as a deal", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <a href="/search?next=/deals/not-a-deal">Search next</a>
          <a href="/gift-cards">Gift cards</a>
          <a href="/deals-hub/featured">Deals hub</a>
          <button type="button">Open deal</button>
        </main>
      `)
    );

    await expect(readFirstVisibleDeal(page)).rejects.toBeInstanceOf(
      ControlNotFoundError
    );
  });

  test("extracts the title from the selected deal card heading, not a badge line", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <article>
            <a href="/deals/card-title-slug">
              <span>Badge</span>
              <h3>Card Title From Heading</h3>
            </a>
          </article>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.title).toBe("Card Title From Heading");
    expect(first.text).not.toBe("Badge");
    expect(first.href).toMatch(/\/deals\/card-title-slug/);
  });

  test("does not use an expected title to skip an earlier visible deal", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <article><a href="/deals/earlier-visible-slug"><h2>Deal A</h2></a></article>
          <article><a href="/deals/later-matching-slug"><h2>Expected Title Elsewhere</h2></a></article>
        </main>
      `)
    );

    const first = await readFirstVisibleDeal(page);

    expect(first.title).toBe("Deal A");
    expect(first.title).not.toBe("Expected Title Elsewhere");
    expect(first.href).toMatch(/\/deals\/earlier-visible-slug/);
  });

  test("generic buttons and clickable non-deal elements are not deals", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <button type="button">View deal</button>
          <div role="button">See deal</div>
          <a href="/local/chicago">Chicago</a>
        </main>
      `)
    );

    await expect(readFirstVisibleDeal(page)).rejects.toBeInstanceOf(
      ControlNotFoundError
    );
  });

  test("submitSearch waits for deal results after Enter", async ({ page }) => {
    await page.setContent(
      markup(`
        <input id="q" placeholder="Search" />
        <div id="results"></div>
        <script>
          document.getElementById("q").addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            window.setTimeout(() => {
              document.getElementById("results").innerHTML =
                '<main><a href="/deals/delayed-offer"><h3>Delayed Offer</h3></a></main>';
            }, 400);
          });
        </script>
      `)
    );

    const submitted = await submitSearch(page, "spa");
    expect(submitted.submittedBy).toBe("enter");
    await expect(submitted.input.locator).toHaveValue("spa");

    const first = await readFirstVisibleDeal(page);
    expect(first.text).toBe("Delayed Offer");
  });

  test("dismisses a covering overlay before reading the first visible deal", async ({
    page,
  }) => {
    await page.setContent(
      markup(`
        <main>
          <article><a href="/deals/first-after-overlay"><h2>First After Overlay</h2></a></article>
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

    const first = await readFirstVisibleDeal(page);

    expect(first.title).toBe("First After Overlay");
    expect(first.href).toMatch(/\/deals\/first-after-overlay/);
    await expect(page.locator("#geo-layer")).toHaveCount(0);
  });

  test("throws a discovery error when the required control is actually absent", async ({
    page,
  }) => {
    await page.setContent(markup(`<main><p>No search here</p></main>`));

    await expect(
      findUserFacingControl(page, {
        kind: "search-input",
        names: ["search"],
      })
    ).rejects.toBeInstanceOf(ControlNotFoundError);
  });
});

function markup(body: string): string {
  return `<!DOCTYPE html>
<html>
  <body>
    ${body}
  </body>
</html>`;
}

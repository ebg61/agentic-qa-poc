/**
 * Runtime UI discovery for generated Playwright specs.
 *
 * Generated tests describe the control they need using Test Case language.
 * This helper inspects the live page and tries several user-facing locator
 * strategies. A missed getByRole is not treated as a functional failure.
 */

import type { Locator, Page } from "@playwright/test";
import { isGrouponDealHref } from "./deal-url.js";
import { preparePageForInteraction } from "./overlay.js";
import {
  isPageOpen,
  isTargetClosedError,
  safeEvaluateNoArg,
  waitIfPageOpen,
} from "./page-guard.js";

export type ControlKind =
  | "search-input"
  | "search-submit"
  | "text-input"
  | "button"
  | "link"
  | "heading"
  | "deal"
  | "search-result"
  | "any";

export interface DiscoverIntent {
  kind?: ControlKind;
  names?: string[];
  description?: string;
}

export interface DiscoveredControl {
  locator: Locator;
  strategy: string;
  description: string;
  candidatesTried: string[];
}

export interface FirstDisplayedItem {
  locator: Locator;
  /** Visible title extracted from the selected deal card. */
  text: string;
  /** Alias of `text`. Generated specs read `title`. */
  title: string;
  strategy: string;
  href?: string;
  /** Alias of `href`. Generated specs read `url`. */
  url?: string;
  /** Alias of `href` for evidence fields named destination. */
  destination?: string;
  top?: number;
  left?: number;
}

export type VisibleDeal = FirstDisplayedItem;

export class ControlNotFoundError extends Error {
  readonly candidatesTried: string[];

  constructor(intent: DiscoverIntent, candidatesTried: string[]) {
    super(
      `Required control was not found after inspecting the live UI (${describeIntent(intent)}). Strategies tried: ${candidatesTried.join("; ")}. This is a locator/discovery failure, not a Test Case assertion against an assumed role or selector.`
    );
    this.name = "ControlNotFoundError";
    this.candidatesTried = candidatesTried;
  }
}

const INPUT_SELECTOR =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]):not([type="password"]), textarea, [contenteditable="true"]';

export async function findUserFacingControl(
  page: Page,
  intent: DiscoverIntent
): Promise<DiscoveredControl> {
  if (!isPageOpen(page)) {
    throw new ControlNotFoundError(intent, ["page already closed"]);
  }

  const kind = intent.kind ?? "any";
  const names = namesFor(kind, intent.names);
  const tried: string[] = [];

  if (kind === "deal" || kind === "search-result") {
    const deal = await readFirstVisibleDeal(page);
    return {
      locator: deal.locator,
      strategy: deal.strategy,
      description: deal.text,
      candidatesTried: tried,
    };
  }

  const found = await firstMatch(tried, [
    () => discoverByRole(page, kind, names, tried),
    () => discoverByAccessibleText(page, kind, names, tried),
    () => discoverByAttributes(page, kind, names, tried),
  ]);

  if (found) {
    console.log(
      `[QA Automation] Discover: ${found.strategy} -> ${found.description}`
    );
    return { ...found, candidatesTried: tried };
  }

  throw new ControlNotFoundError(intent, tried);
}

export interface SearchSubmission {
  input: DiscoveredControl;
  submittedBy: "enter";
  query: string;
}

export async function submitSearch(
  page: Page,
  query: string,
  options?: { names?: string[] }
): Promise<SearchSubmission> {
  await dismissBlockingOverlays(page, 400);
  const input = await findUserFacingControl(page, {
    kind: "search-input",
    names: options?.names ?? ["search", "find"],
    description: "search text input",
  });
  await input.locator.fill(query);
  await input.locator.press("Enter");
  await dismissBlockingOverlays(page, 500);
  await waitForSearchResultsUi(page);
  return {
    input,
    submittedBy: "enter",
    query,
  };
}

/**
 * First visible Groupon deal/result in the current viewport.
 *
 * A deal is a rendered result/card associated with a /deals/<slug>
 * destination. Query parameters after the slug are allowed.
 *
 * Does not scroll, does not hunt later results for an expected title,
 * and does not treat headings, navigation, or the first page link as a deal.
 */
export async function readFirstVisibleDeal(
  page: Page
): Promise<VisibleDeal> {
  if (!isPageOpen(page)) {
    throw new ControlNotFoundError(
      { description: "first visible Groupon deal" },
      ["page already closed"]
    );
  }

  await dismissBlockingOverlays(page, 0);
  let candidates = await listVisibleDealCards(page);
  if (!candidates[0]) {
    await waitIfPageOpen(page, 300);
    await dismissBlockingOverlays(page, 0);
    candidates = await listVisibleDealCards(page);
  }
  const first = candidates[0];
  if (!first) {
    throw new ControlNotFoundError(
      { description: "first visible Groupon deal" },
      [
        "a[href] whose path is /deals/<slug>",
        "skipped header/nav/footer chrome",
        "skipped generic headings and first-page links",
        "no scrolling",
      ]
    );
  }

  if (!first.title) {
    throw new ControlNotFoundError(
      { description: "title of the first visible Groupon deal" },
      [
        `identified deal href ${first.href}`,
        "title could not be extracted from the selected deal/card",
      ]
    );
  }

  const locator = locatorForDealAnchor(page, first);
  console.log(
    `[QA Automation] Discover: ${first.strategy} -> ${first.title} (${first.href})`
  );
  return {
    locator,
    text: first.title,
    title: first.title,
    strategy: first.strategy,
    href: first.href,
    url: first.href,
    destination: first.href,
    top: first.top,
    left: first.left,
  };
}

export async function listVisibleDeals(page: Page): Promise<VisibleDeal[]> {
  if (!isPageOpen(page)) {
    return [];
  }

  await dismissBlockingOverlays(page, 0);
  const cards = await listVisibleDealCards(page);
  return cards.map((card) => ({
    locator: locatorForDealAnchor(page, card),
    text: card.title,
    title: card.title,
    strategy: card.strategy,
    href: card.href,
    url: card.href,
    destination: card.href,
    top: card.top,
    left: card.left,
  }));
}

function locatorForDealAnchor(page: Page, deal: VisibleDealCard): Locator {
  const rawHref = deal.hrefAttribute || deal.href;
  if (rawHref) {
    const escaped = rawHref.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return page.locator(`a[href="${escaped}"]`).first();
  }
  return page.locator("a[href]").nth(deal.linkIndex);
}

export async function readFirstDisplayedItemTitle(
  page: Page
): Promise<VisibleDeal> {
  return readFirstVisibleDeal(page);
}

interface VisibleDealCard {
  href: string;
  hrefAttribute: string;
  title: string;
  top: number;
  left: number;
  linkIndex: number;
  strategy: string;
}

async function listVisibleDealCards(page: Page): Promise<VisibleDealCard[]> {
  const records =
    (await safeEvaluateNoArg(page, () => {
      const documentBase =
        location.protocol === "http:" || location.protocol === "https:"
          ? location.href
          : "https://www.groupon.com/";
      const chromeSelector =
        'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';
      const cardSelector =
        'article, [role="article"], [role="listitem"], li, [data-testid*="deal"], [data-testid*="card"], [data-testid*="result"], [data-test*="deal"], [data-test*="card"], [data-test*="result"]';

      const isNonNavigating = (href: string): boolean => {
        const lowered = href.trim().toLowerCase();
        return (
          lowered.startsWith("#") ||
          lowered.startsWith("javascript:") ||
          lowered.startsWith("mailto:") ||
          lowered.startsWith("tel:")
        );
      };

      const isDealPath = (href: string, baseUrl: string): boolean => {
        const trimmed = href.trim();
        if (!trimmed || isNonNavigating(trimmed)) {
          return false;
        }
        try {
          const url = new URL(trimmed, baseUrl);
          const parts = url.pathname.split("/").filter(Boolean);
          return parts[0]?.toLowerCase() === "deals" && Boolean(parts[1]?.trim());
        } catch {
          return false;
        }
      };

      const toAbsoluteHref = (href: string, baseUrl: string): string => {
        try {
          return new URL(href, baseUrl).toString();
        } catch {
          return href;
        }
      };

      const candidateHrefs = (link: HTMLAnchorElement): string[] => {
        const values = [
          link.getAttribute("href"),
          link.href,
          link.getAttribute("data-href"),
          link.getAttribute("data-url"),
        ].filter((value): value is string => Boolean(value && value.trim()));
        return [...new Set(values)];
      };

      const collectAnchors = (root: ParentNode): HTMLAnchorElement[] => {
        const found: HTMLAnchorElement[] = [];
        const visit = (node: ParentNode) => {
          const anchors = node.querySelectorAll("a");
          for (const anchor of anchors) {
            found.push(anchor as HTMLAnchorElement);
          }
          const elements =
            node instanceof Element
              ? [node, ...Array.from(node.querySelectorAll("*"))]
              : Array.from((node as Document | DocumentFragment).querySelectorAll("*"));
          for (const element of elements) {
            if (element.shadowRoot) {
              visit(element.shadowRoot);
            }
          }
        };
        visit(root);
        return found;
      };

      const isResultsHeading = (text: string): boolean =>
        /^results\s+for\b/i.test(text.trim());

      const isGenericCta = (text: string): boolean =>
        /^(view deal|see deal|learn more|shop now|get deal|buy now)$/i.test(
          text.trim()
        );

      const firstVisibleLine = (element: Element): string =>
        ((element as HTMLElement).innerText || "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "";

      const titleFromDealCard = (
        card: Element,
        link: HTMLAnchorElement
      ): string => {
        const titleNodes = card.querySelectorAll(
          "h1, h2, h3, h4, h5, h6, [role='heading'], [itemprop='name']"
        );
        for (const node of titleNodes) {
          const text = firstVisibleLine(node);
          if (text && !isResultsHeading(text) && !isGenericCta(text)) {
            return text;
          }
        }

        const labelled = (link.getAttribute("aria-label") || "")
          .trim()
          .split("\n")[0]
          ?.trim();
        if (
          labelled &&
          !isResultsHeading(labelled) &&
          !isGenericCta(labelled)
        ) {
          return labelled;
        }

        const linkLine = firstVisibleLine(link);
        if (linkLine && !isResultsHeading(linkLine) && !isGenericCta(linkLine)) {
          return linkLine;
        }

        const cardLine = firstVisibleLine(card);
        if (cardLine && !isResultsHeading(cardLine) && !isGenericCta(cardLine)) {
          return cardLine;
        }
        return "";
      };

      const intersectsViewport = (rect: DOMRect): boolean =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;

      const byCard = new Map<
        Element,
        {
          href: string;
          hrefAttribute: string;
          title: string;
          top: number;
          left: number;
          linkIndex: number;
        }
      >();

      const links = collectAnchors(document);
      links.forEach((link, linkIndex) => {
        const hrefs = candidateHrefs(link);
        const dealHref = hrefs.find((href) => isDealPath(href, documentBase));
        if (!dealHref) {
          return;
        }

        const chrome = link.closest(chromeSelector);
        if (chrome && !link.closest('main, [role="main"]')) {
          return;
        }

        const card = (link.closest(cardSelector) as HTMLElement | null) ?? link;
        const rect = card.getBoundingClientRect();
        if (!intersectsViewport(rect)) {
          return;
        }

        if (byCard.has(card)) {
          return;
        }

        byCard.set(card, {
          href: toAbsoluteHref(dealHref, documentBase),
          hrefAttribute: link.getAttribute("href") || dealHref,
          title: titleFromDealCard(card, link),
          top: rect.top,
          left: rect.left,
          linkIndex,
        });
      });

      return [...byCard.values()].map((record) => ({
        ...record,
        strategy: "first visible Groupon /deals/ card in viewport",
      }));
    })) ?? [];

  return records
    .filter((record) =>
      isGrouponDealHref(
        record.href,
        page.url().startsWith("http") ? page.url() : undefined
      )
    )
    .sort((left, right) => left.top - right.top || left.left - right.left);
}

async function waitForSearchResultsUi(page: Page): Promise<void> {
  if (!isPageOpen(page)) {
    return;
  }

  const initialUrl = page.url();
  const initialLength =
    (await safeEvaluateNoArg(page, () => document.body?.innerHTML.length ?? 0)) ??
    0;
  const deadline = Date.now() + 12000;

  while (Date.now() < deadline) {
    if (!isPageOpen(page)) {
      return;
    }
    await dismissBlockingOverlays(page, 0);
    if (await hasVisibleDealOrResult(page)) {
      return;
    }

    const elapsed = 12000 - (deadline - Date.now());
    const urlChanged = page.url() !== initialUrl;
    const htmlLength =
      (await safeEvaluateNoArg(
        page,
        () => document.body?.innerHTML.length ?? 0
      )) ?? 0;
    const htmlGrew = htmlLength > initialLength + 400;

    if (!urlChanged && !htmlGrew && elapsed >= 1500) {
      return;
    }

    await waitIfPageOpen(page, 200);
  }
}

async function hasVisibleDealOrResult(page: Page): Promise<boolean> {
  const deals = await listVisibleDealCards(page);
  return deals.length > 0;
}

async function firstMatch(
  _tried: string[],
  discoverers: Array<() => Promise<DiscoveredControl | undefined>>
): Promise<DiscoveredControl | undefined> {
  for (const discover of discoverers) {
    const found = await discover();
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function discoverByRole(
  page: Page,
  kind: ControlKind,
  names: string[],
  tried: string[]
): Promise<DiscoveredControl | undefined> {
  const name = namesPattern(names);
  const roles = rolesFor(kind);

  for (const role of roles) {
    const locator = name
      ? page.getByRole(role, { name })
      : page.getByRole(role);
    tried.push(`getByRole(${role}${name ? ", name=/" + names.join("|") + "/" : ""})`);
    const match = await firstDisplayed(locator, kind);
    if (match) {
      return {
        locator: match,
        strategy: `role:${role}`,
        description: await describeLocator(match),
        candidatesTried: tried,
      };
    }
  }

  return undefined;
}

async function discoverByAccessibleText(
  page: Page,
  kind: ControlKind,
  names: string[],
  tried: string[]
): Promise<DiscoveredControl | undefined> {
  const name = namesPattern(names);
  if (!name) {
    return undefined;
  }

  const locators: Array<[string, Locator]> = [
    ["getByLabel", page.getByLabel(name)],
    ["getByPlaceholder", page.getByPlaceholder(name)],
    ["getByAltText", page.getByAltText(name)],
    ["getByTitle", page.getByTitle(name)],
  ];

  if (kind === "button" || kind === "search-submit" || kind === "any") {
    locators.push(["getByText", page.getByText(name)]);
  }

  for (const [strategy, locator] of locators) {
    tried.push(`${strategy}(/${names.join("|")}/)`);
    const match = await firstDisplayed(locator, kind);
    if (match) {
      return {
        locator: match,
        strategy,
        description: await describeLocator(match),
        candidatesTried: tried,
      };
    }
  }

  return undefined;
}

async function discoverByAttributes(
  page: Page,
  kind: ControlKind,
  names: string[],
  tried: string[]
): Promise<DiscoveredControl | undefined> {
  const selector = selectorFor(kind);
  tried.push(`attribute scan of ${selector} against [${names.join(", ")}]`);
  const locators = page.locator(selector);
  const count = await locators.count().catch(() => 0);
  const tokens = names.map((name) => name.toLowerCase());
  let fallback: Locator | undefined;

  for (let index = 0; index < Math.min(count, 40); index += 1) {
    const candidate = locators.nth(index);
    if (!(await isDisplayedInViewport(candidate))) {
      continue;
    }

    const meta = await readControlMeta(candidate);
    if (isExcludedByType(kind, meta)) {
      continue;
    }
    if (!(await matchesKind(kind, candidate))) {
      continue;
    }

    if (tokens.length === 0 || matchesTokens(meta, tokens)) {
      return {
        locator: candidate,
        strategy: `attributes[${index}]`,
        description: meta.summary,
        candidatesTried: tried,
      };
    }

    if (!fallback && kind === "search-input" && isPlainTextInput(meta)) {
      fallback = candidate;
    }
  }

  if (fallback) {
    return {
      locator: fallback,
      strategy: "first visible text input",
      description: await describeLocator(fallback),
      candidatesTried: tried,
    };
  }

  return undefined;
}

function rolesFor(kind: ControlKind): Array<
  | "searchbox"
  | "combobox"
  | "textbox"
  | "button"
  | "link"
  | "heading"
  | "article"
  | "listitem"
  | "img"
> {
  switch (kind) {
    case "search-input":
      return ["searchbox", "combobox", "textbox"];
    case "search-submit":
    case "button":
      return ["button", "link"];
    case "text-input":
      return ["textbox", "searchbox", "combobox"];
    case "link":
      return ["link"];
    case "heading":
      return ["heading"];
    case "deal":
    case "search-result":
      return ["article", "listitem"];
    default:
      return ["button", "link", "searchbox", "combobox", "textbox", "heading", "img"];
  }
}

function selectorFor(kind: ControlKind): string {
  switch (kind) {
    case "search-input":
    case "text-input":
      return INPUT_SELECTOR;
    case "search-submit":
    case "button":
      return 'button, [role="button"], a, input[type="submit"], input[type="button"]';
    case "link":
      return "a[href]";
    case "heading":
      return "h1, h2, h3, h4, [role='heading']";
    case "deal":
    case "search-result":
      return "a[href]";
    default:
      return `${INPUT_SELECTOR}, button, a, img, [role="button"]`;
  }
}

async function matchesKind(kind: ControlKind, locator: Locator): Promise<boolean> {
  if (kind === "deal" || kind === "search-result") {
    const href = await locator.getAttribute("href").catch(() => null);
    if (isGrouponDealHref(href)) {
      return true;
    }
    const resolved = await locator
      .evaluate((element) => (element as HTMLAnchorElement).href)
      .catch(() => null);
    if (isGrouponDealHref(resolved)) {
      return true;
    }
    const nestedHref = await locator
      .locator("a[href]")
      .first()
      .getAttribute("href")
      .catch(() => null);
    return isGrouponDealHref(nestedHref);
  }
  if (kind !== "search-input" && kind !== "text-input") {
    if (kind === "search-submit" || kind === "button") {
      return isButtonLike(locator);
    }
    return true;
  }

  if (!(await isTextEntryControl(locator))) {
    return false;
  }
  if (kind === "search-input" && (await isLocationOrGeoSearchField(locator))) {
    return false;
  }
  return true;
}

async function isTextEntryControl(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute("role") || "").toLowerCase();
      const type = (element.getAttribute("type") || "").toLowerCase();
      if (
        tag === "button" ||
        type === "button" ||
        type === "submit" ||
        role === "button"
      ) {
        return false;
      }
      if (
        tag === "input" ||
        tag === "textarea" ||
        element.getAttribute("contenteditable") === "true"
      ) {
        return true;
      }
      return (
        role === "searchbox" || role === "textbox" || role === "combobox"
      );
    });
  } catch (error) {
    if (isTargetClosedError(error)) {
      return false;
    }
    return false;
  }
}

async function isButtonLike(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((element) => {
      const tag = element.tagName.toLowerCase();
      const role = (element.getAttribute("role") || "").toLowerCase();
      const type = (element.getAttribute("type") || "").toLowerCase();
      return (
        tag === "button" ||
        tag === "a" ||
        type === "button" ||
        type === "submit" ||
        role === "button"
      );
    });
  } catch {
    return false;
  }
}

function namesFor(kind: ControlKind, names: string[] | undefined): string[] {
  const supplied = (names ?? []).map((name) => name.trim()).filter(Boolean);
  if (supplied.length > 0) {
    return supplied;
  }
  if (kind === "search-input" || kind === "search-submit") {
    return ["search", "find"];
  }
  return [];
}

function namesPattern(names: string[]): RegExp | undefined {
  if (names.length === 0) {
    return undefined;
  }
  return new RegExp(names.map(escapeRegex).join("|"), "i");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function firstDisplayed(
  locator: Locator,
  kind?: ControlKind
): Promise<Locator | undefined> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, 20); index += 1) {
    const candidate = locator.nth(index);
    if (!(await isDisplayedInViewport(candidate))) {
      continue;
    }
    if (kind && !(await matchesKind(kind, candidate))) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

async function isDisplayedInViewport(locator: Locator): Promise<boolean> {
  try {
    if (!(await locator.isVisible())) {
      return false;
    }
    return await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    });
  } catch {
    return false;
  }
}

async function readControlMeta(locator: Locator): Promise<{
  placeholder: string;
  ariaLabel: string;
  name: string;
  id: string;
  testId: string;
  type: string;
  title: string;
  role: string;
  text: string;
  summary: string;
}> {
  return locator.evaluate((element) => {
    const attr = (key: string) => element.getAttribute(key) ?? "";
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const meta = {
      placeholder: attr("placeholder"),
      ariaLabel: attr("aria-label"),
      name: attr("name"),
      id: element.id,
      testId: attr("data-testid") || attr("data-test-id") || attr("data-test"),
      type: attr("type"),
      title: attr("title"),
      role: attr("role"),
      text,
      summary: "",
    };
    meta.summary = [
      meta.role && `role=${meta.role}`,
      meta.type && `type=${meta.type}`,
      meta.id && `#${meta.id}`,
      meta.name && `name=${meta.name}`,
      meta.placeholder && `placeholder=${meta.placeholder}`,
      meta.ariaLabel && `aria-label=${meta.ariaLabel}`,
      meta.testId && `testid=${meta.testId}`,
    ]
      .filter(Boolean)
      .join(" ");
    return meta;
  });
}

function matchesTokens(
  meta: { placeholder: string; ariaLabel: string; name: string; id: string; testId: string; title: string; text: string },
  tokens: string[]
): boolean {
  const haystack = [
    meta.placeholder,
    meta.ariaLabel,
    meta.name,
    meta.id,
    meta.testId,
    meta.title,
    meta.text,
  ]
    .join(" ")
    .toLowerCase();
  return tokens.some((token) => haystack.includes(token.toLowerCase()));
}

function isExcludedByType(
  kind: ControlKind,
  meta: { type: string; name: string; id: string }
): boolean {
  if (kind !== "search-input" && kind !== "text-input") {
    return false;
  }
  const type = meta.type.toLowerCase();
  return type === "email" || type === "tel" || type === "url";
}

function isPlainTextInput(meta: { type: string }): boolean {
  const type = meta.type.toLowerCase();
  return type === "" || type === "text" || type === "search";
}

async function describeLocator(locator: Locator): Promise<string> {
  try {
    const meta = await readControlMeta(locator);
    return meta.summary || "visible control";
  } catch {
    return "visible control";
  }
}

function describeIntent(intent: DiscoverIntent): string {
  const parts = [
    intent.kind,
    intent.names?.join(", "),
    intent.description,
  ].filter(Boolean);
  return parts.join(" / ") || "unspecified control";
}

const LOCATION_OR_GEO_FIELD =
  /\b(location|city|zip(?:\s*code)?|postal(?:\s*code)?|geo(?:location)?|region|country|address)\b/i;

export function isLocationOrGeoFieldLabel(text: string): boolean {
  return LOCATION_OR_GEO_FIELD.test(text);
}

async function isLocationOrGeoSearchField(locator: Locator): Promise<boolean> {
  try {
    const meta = await readControlMeta(locator);
    const haystack = [
      meta.placeholder,
      meta.ariaLabel,
      meta.name,
      meta.id,
      meta.testId,
      meta.title,
    ]
      .join(" ")
      .toLowerCase();
    return isLocationOrGeoFieldLabel(haystack);
  } catch {
    return false;
  }
}

async function dismissBlockingOverlays(
  page: Page,
  waitForAppearanceMs: number
): Promise<void> {
  if (!isPageOpen(page)) {
    return;
  }
  await preparePageForInteraction(page, { waitForAppearanceMs });
}

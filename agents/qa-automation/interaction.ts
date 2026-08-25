/**
 * Link discovery and activation for generated Playwright specs.
 *
 * Non-navigating hrefs such as "#", javascript:, mailto:, and tel: are not
 * treated as destinations. Activation never closes the original page.
 */

import type { Locator, Page } from "@playwright/test";
import { isPageOpen, isTargetClosedError, safeEvaluateNoArg } from "./page-guard.js";

export interface NavigableLink {
  href: string;
  text: string;
  locator: Locator;
}

export interface LinkActivation {
  kind: "same-tab" | "popup" | "in-page" | "none";
  href: string;
  page: Page;
}

export interface LinkDestinationObservation {
  href?: string | null;
  originalUrl?: string | null;
  finalUrl?: string | null;
  title?: string | null;
  bodyText?: string | null;
  openedIn?: string | null;
  navigationKind?: LinkActivation["kind"] | null;
  reached?: boolean;
  playwrightError?: string | null;
  passwordFieldPresent?: boolean;
}

export interface LinkDestinationEvidence {
  href?: string;
  originalUrl?: string;
  finalUrl?: string;
  title?: string;
  bodyLength: number;
  bodySnippet?: string;
  openedIn?: string;
  navigationKind?: string;
  reached: boolean;
  playwrightError?: string;
  passwordFieldPresent?: boolean;
}

export function isNonNavigatingHref(href: string | null | undefined): boolean {
  if (href == null) {
    return true;
  }
  const trimmed = href.trim();
  if (trimmed === "" || trimmed === "#") {
    return true;
  }
  if (/^javascript:/i.test(trimmed)) {
    return true;
  }
  if (/^(mailto|tel|sms):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("#") && !trimmed.includes("/")) {
    return true;
  }
  return false;
}

export async function listNavigableLinks(
  page: Page,
  options?: { limit?: number }
): Promise<NavigableLink[]> {
  if (!isPageOpen(page)) {
    return [];
  }

  const anchors = page.locator("a[href]");
  const count = await anchors.count().catch(() => 0);
  const found: NavigableLink[] = [];

  for (let index = 0; index < count; index += 1) {
    const locator = anchors.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const href = await locator.getAttribute("href").catch(() => null);
    if (isNonNavigatingHref(href)) {
      continue;
    }

    const text = ((await locator.innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();
    found.push({ href: href ?? "", text, locator });
    if (options?.limit && found.length >= options.limit) {
      break;
    }
  }

  return found;
}

export async function activateNavigableLink(
  page: Page,
  locator: Locator
): Promise<LinkActivation> {
  const live = resolveOpenPage(locator.page()) ?? resolveOpenPage(page);
  if (!live) {
    throw new Error(
      "Cannot activate a link because no open page remains"
    );
  }
  await prepareOpenedPage(live);

  const href = (await locator.getAttribute("href").catch(() => "")) ?? "";
  if (isNonNavigatingHref(href)) {
    await locator.click({ noWaitAfter: true, timeout: 8_000 });
    return { kind: "in-page", href, page: live };
  }

  const urlBefore = live.url();
  const popupPromise = live
    .context()
    .waitForEvent("page", { timeout: 5_000 })
    .catch(() => undefined);

  await locator.click({ timeout: 15_000 });
  const popup = await popupPromise;

  if (popup && !popup.isClosed()) {
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    await prepareOpenedPage(popup);
    return { kind: "popup", href, page: popup };
  }

  const afterClick = resolveOpenPage(live) ?? resolveOpenPage(page);
  if (!afterClick) {
    throw new Error(
      "The original page closed after activating the link and no other page remained"
    );
  }

  await prepareOpenedPage(afterClick);
  if (afterClick.url() !== urlBefore) {
    return { kind: "same-tab", href, page: afterClick };
  }

  return { kind: "none", href, page: afterClick };
}

export function resolveOpenPage(page: Page): Page | undefined {
  if (isPageOpen(page)) {
    return page;
  }
  try {
    return page.context().pages().find((candidate) => isPageOpen(candidate));
  } catch {
    return undefined;
  }
}

export async function observePage(page: Page): Promise<{
  url?: string;
  title?: string;
  bodyText?: string;
  bodyLength: number;
  pageOpen: boolean;
}> {
  const open = resolveOpenPage(page);
  if (!open) {
    return { bodyLength: 0, pageOpen: false };
  }

  await prepareOpenedPage(open);
  const url = open.url();
  const title = (await open.title().catch(() => "")) || undefined;
  const bodyText =
    (await safeEvaluateNoArg(open, () => document.body?.innerText ?? "")) ?? "";
  return {
    url,
    title,
    bodyText,
    bodyLength: bodyText.trim().length,
    pageOpen: true,
  };
}

async function prepareOpenedPage(page: Page): Promise<void> {
  const open = resolveOpenPage(page);
  if (!open) {
    return;
  }
  const { preparePageForInteraction } = await import("./overlay.js");
  await preparePageForInteraction(open, { waitForAppearanceMs: 400 });
}

export async function restorePage(page: Page, url: string): Promise<void> {
  const live = resolveOpenPage(page);
  if (!live) {
    throw new Error("Cannot restore a closed page");
  }
  if (live.url() === url) {
    return;
  }
  await live.goto(url, { waitUntil: "domcontentloaded" });
  await prepareOpenedPage(live);
}

export async function closeOpenedPageIfDifferent(
  original: Page,
  opened: Page
): Promise<void> {
  if (opened === original || opened.isClosed()) {
    return;
  }
  await opened.close().catch((error) => {
    if (!isTargetClosedError(error)) {
      throw error;
    }
  });
}

/**
 * Record raw link-navigation evidence. Do not classify product correctness.
 *
 * href and finalUrl are observational. A redirect, rewrite, path change,
 * domain change, login UI, or unexpected title/content is not an Automation
 * functional failure.
 */
export function recordLinkDestination(
  observation: LinkDestinationObservation
): LinkDestinationEvidence {
  const href = nonEmpty(observation.href);
  const originalUrl = nonEmpty(observation.originalUrl);
  const finalUrl = nonEmpty(observation.finalUrl);
  const title = observation.title?.trim() || undefined;
  const bodyText = observation.bodyText ?? "";
  const bodyLength = bodyText.trim().length;
  const bodySnippet = bodyText.trim().slice(0, 200) || undefined;
  const playwrightError = nonEmpty(observation.playwrightError);
  const reached =
    observation.reached ??
    (!playwrightError && (finalUrl !== undefined || title !== undefined));

  return {
    href,
    originalUrl,
    finalUrl,
    title,
    bodyLength,
    bodySnippet,
    openedIn: nonEmpty(observation.openedIn),
    navigationKind: observation.navigationKind || undefined,
    reached,
    playwrightError,
    passwordFieldPresent:
      observation.passwordFieldPresent === undefined
        ? undefined
        : observation.passwordFieldPresent,
  };
}

/**
 * Compatibility export for generated specs that still import this name.
 * Records the same raw evidence as recordLinkDestination. `usable` means the
 * destination was reached, not that the product is functionally correct.
 */
export function assessLinkDestination(
  observation: LinkDestinationObservation
): LinkDestinationEvidence & { usable: boolean } {
  const evidence = recordLinkDestination(observation);
  return { ...evidence, usable: evidence.reached };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

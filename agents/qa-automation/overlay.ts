/**
 * Generic blocking-overlay handling for generated Playwright specs.
 *
 * Overlay candidates are evaluated one at a time. Multiple matches are
 * normal and must not trigger Playwright strict-mode failures.
 * data-state=open alone is not treated as a blocking overlay.
 *
 * preparePageForInteraction() dismisses blocking modals after navigation
 * and installs a page-wide guard so later click/fill/press actions also
 * check for overlays. Sequential overlays are dismissed one after another.
 * withModalHandling() wraps a single action with at most one retry after a
 * modal intercept.
 */

import type { Locator, Page } from "@playwright/test";
import { isNonNavigatingHref } from "./interaction.js";
import {
  isPageOpen,
  isTargetClosedError,
  safeEvaluate,
  waitIfPageOpen,
} from "./page-guard.js";

export type OverlayDismissalMethod =
  | "click_outside"
  | "visible_dismiss_control"
  | "none";

export interface OverlayOccurrence {
  overlayDetected: boolean;
  dismissalAttempted: boolean;
  dismissalMethod: OverlayDismissalMethod;
  dismissalSucceeded: boolean;
  functionalTestContinued: boolean;
  overlayDescription?: string;
  reason?: string;
  retryRequired?: boolean;
}

export interface OverlayDismissalResult extends OverlayOccurrence {
  retryRequired?: boolean;
  occurrences?: OverlayOccurrence[];
}

export class OverlayBlockedError extends Error {
  readonly overlay: OverlayDismissalResult;

  constructor(overlay: OverlayDismissalResult) {
    super(
      overlay.reason ??
        "A blocking overlay could not be safely dismissed, so the functional action cannot continue."
    );
    this.name = "OverlayBlockedError";
    this.overlay = overlay;
  }
}

interface OverlayCandidate {
  index: number;
  stamp: string;
  description: string;
  interceptCount: number;
  coverage: number;
  content: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
}

interface OverlaySession {
  result: OverlayDismissalResult;
}

const CANDIDATE_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-state="open"], dialog';

const DISMISS_NAMES = [
  /^close$/i,
  /^dismiss$/i,
  /^cancel$/i,
  /^continue$/i,
  /^accept$/i,
  /^no thanks$/i,
  /^got it$/i,
  /^ok$/i,
  /^okay$/i,
  /^agree$/i,
  /^allow$/i,
  /^not now$/i,
  /^maybe later$/i,
  /close dialog/i,
  /close modal/i,
];

const FORBIDDEN_CONTROL =
  /sign\s*in|log\s*in|logon|register|create account|subscribe|password|e-?mail|location|country|region|zip|postal|language|cart|checkout|buy now|sign up|submit/i;

const ACTION_METHODS = [
  "click",
  "dblclick",
  "fill",
  "press",
  "type",
  "pressSequentially",
  "check",
  "uncheck",
  "selectOption",
  "setChecked",
  "tap",
  "hover",
  "dragTo",
  "clear",
] as const;

const PATCH_FLAG = Symbol("qaOverlayPatched");
const PAGE_PATCH_FLAG = Symbol("qaOverlayPagePatched");
const KEYBOARD_PATCH_FLAG = Symbol("qaOverlayKeyboardPatched");
const OVERLAY_RESOLVE_PAGES = new WeakSet<Page>();
const GUARDED_PAGES = new WeakSet<Page>();
const HANDLING_PAGES = new WeakSet<Page>();
const SESSIONS = new WeakMap<Page, OverlaySession>();
const PAGE_NAV_METHODS = ["goto", "reload", "goBack", "goForward"] as const;

export async function preparePageForInteraction(
  page: Page,
  options?: { waitForAppearanceMs?: number }
): Promise<OverlayDismissalResult> {
  installInteractionGuard(page);
  try {
    const overlay = await resolveBlockingOverlay(page, {
      waitForAppearanceMs: options?.waitForAppearanceMs ?? 2000,
    });
    const recorded = recordOverlay(page, overlay);
    if (!recorded.functionalTestContinued) {
      throw new OverlayBlockedError(recorded);
    }
    return recorded;
  } catch (error) {
    if (isStrictModeError(error)) {
      console.log(
        "[QA Automation] Overlay: ignored locator ambiguity; continuing Test Case"
      );
      return recordOverlay(page, {
        overlayDetected: false,
        dismissalAttempted: false,
        dismissalMethod: "none",
        dismissalSucceeded: true,
        functionalTestContinued: true,
        retryRequired: false,
        occurrences: [],
        reason:
          "Overlay candidate locators matched multiple elements. The helper ignored the locator ambiguity and did not treat it as an unresolved overlay.",
      });
    }
    throw error;
  }
}

export async function withModalHandling<T>(
  page: Page,
  action: () => Promise<T>,
  options?: { intentPoint?: { x: number; y: number } }
): Promise<T> {
  if (!isPageOpen(page)) {
    throw new Error("Cannot handle modals because the page is already closed");
  }
  installInteractionGuard(page);

  if (HANDLING_PAGES.has(page)) {
    return action();
  }

  HANDLING_PAGES.add(page);
  try {
    const before = await resolveBlockingOverlay(page, {
      waitForAppearanceMs: 100,
      intentPoint: options?.intentPoint,
    });
    recordOverlay(page, before);
    if (!before.functionalTestContinued) {
      throw new OverlayBlockedError(sessionOf(page).result);
    }

    try {
      return await action();
    } catch (error) {
      if (
        error instanceof OverlayBlockedError ||
        isTargetClosedError(error) ||
        !isPageOpen(page) ||
        !isInterceptError(error)
      ) {
        throw error;
      }

      if (!isPageOpen(page)) {
        throw error;
      }

      const recovered = await resolveBlockingOverlay(page, {
        waitForAppearanceMs: 0,
        intentPoint: options?.intentPoint,
      });
      recordOverlay(page, recovered, { retryRequired: true });
      if (!recovered.functionalTestContinued) {
        throw new OverlayBlockedError(sessionOf(page).result);
      }

      console.log(
        "[QA Automation] Overlay: retrying the original user action once"
      );
      return await action();
    }
  } finally {
    HANDLING_PAGES.delete(page);
  }
}

export function overlayHandlingState(page: Page): OverlayDismissalResult {
  return sessionOf(page).result;
}

function installInteractionGuard(page: Page): void {
  GUARDED_PAGES.add(page);
  sessionOf(page);
  patchLocatorActions(page);
  patchPageNavigation(page);
  patchKeyboard(page);
}

function patchLocatorActions(page: Page): void {
  const proto = Object.getPrototypeOf(page.locator("html")) as Record<
    string | symbol,
    unknown
  >;
  if (proto[PATCH_FLAG]) {
    return;
  }
  proto[PATCH_FLAG] = true;

  for (const method of ACTION_METHODS) {
    const original = proto[method];
    if (typeof original !== "function") {
      continue;
    }

    proto[method] = async function patchedLocatorAction(
      this: Locator,
      ...args: unknown[]
    ) {
      const owner = this.page();
      if (!isPageOpen(owner)) {
        throw new Error(
          "Cannot perform a user action because the page is already closed"
        );
      }
      if (
        !GUARDED_PAGES.has(owner) ||
        OVERLAY_RESOLVE_PAGES.has(owner) ||
        HANDLING_PAGES.has(owner)
      ) {
        return (original as (...actionArgs: unknown[]) => unknown).apply(
          this,
          args
        );
      }

      const nextArgs = await withInPageClickOptions(this, method, args);
      const intentPoint = await intentPointFromLocator(this);
      return withModalHandling(
        owner,
        async () =>
          (original as (...actionArgs: unknown[]) => unknown).apply(
            this,
            nextArgs
          ),
        { intentPoint }
      );
    };
  }
}

function patchPageNavigation(page: Page): void {
  const proto = Object.getPrototypeOf(page) as Record<string | symbol, unknown>;
  if (proto[PAGE_PATCH_FLAG]) {
    return;
  }
  proto[PAGE_PATCH_FLAG] = true;

  for (const method of PAGE_NAV_METHODS) {
    const original = proto[method];
    if (typeof original !== "function") {
      continue;
    }

    proto[method] = async function patchedPageNavigation(
      this: Page,
      ...args: unknown[]
    ) {
      if (!isPageOpen(this)) {
        throw new Error(
          "Cannot navigate because the page is already closed"
        );
      }
      const result = await (
        original as (...actionArgs: unknown[]) => Promise<unknown>
      ).apply(this, args);

      if (
        !isPageOpen(this) ||
        !GUARDED_PAGES.has(this) ||
        OVERLAY_RESOLVE_PAGES.has(this) ||
        HANDLING_PAGES.has(this)
      ) {
        return result;
      }

      const overlay = await resolveBlockingOverlay(this, {
        waitForAppearanceMs: 500,
      });
      const recorded = recordOverlay(this, overlay);
      if (!recorded.functionalTestContinued) {
        throw new OverlayBlockedError(recorded);
      }
      return result;
    };
  }
}

function patchKeyboard(page: Page): void {
  const keyboard = page.keyboard as unknown as Record<string | symbol, unknown>;
  if (keyboard[KEYBOARD_PATCH_FLAG]) {
    return;
  }
  keyboard[KEYBOARD_PATCH_FLAG] = true;

  const original = keyboard.press;
  if (typeof original !== "function") {
    return;
  }

  keyboard.press = async (...args: unknown[]) => {
    if (
      !isPageOpen(page) ||
      OVERLAY_RESOLVE_PAGES.has(page) ||
      HANDLING_PAGES.has(page)
    ) {
      return (original as (...actionArgs: unknown[]) => unknown).apply(
        keyboard,
        args
      );
    }

    return withModalHandling(page, async () =>
      (original as (...actionArgs: unknown[]) => unknown).apply(keyboard, args)
    );
  };
}

async function withInPageClickOptions(
  locator: Locator,
  method: string,
  args: unknown[]
): Promise<unknown[]> {
  if (method !== "click" && method !== "dblclick") {
    return args;
  }

  const href = await locator.getAttribute("href").catch(() => null);
  if (href == null || !isNonNavigatingHref(href)) {
    return args;
  }

  const options =
    args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
      ? { ...(args[0] as Record<string, unknown>) }
      : {};
  options.noWaitAfter = true;
  return [options, ...args.slice(1)];
}

async function intentPointFromLocator(
  locator: Locator
): Promise<{ x: number; y: number } | undefined> {
  try {
    const box = await locator.boundingBox();
    if (!box) {
      return undefined;
    }
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  } catch {
    return undefined;
  }
}

function sessionOf(page: Page): OverlaySession {
  const existing = SESSIONS.get(page);
  if (existing) {
    return existing;
  }

  const session: OverlaySession = {
    result: emptyOverlayResult(),
  };
  SESSIONS.set(page, session);
  return session;
}

function emptyOverlayResult(): OverlayDismissalResult {
  return {
    overlayDetected: false,
    dismissalAttempted: false,
    dismissalMethod: "none",
    dismissalSucceeded: true,
    functionalTestContinued: true,
    retryRequired: false,
    occurrences: [],
  };
}

function recordOverlay(
  page: Page,
  overlay: OverlayDismissalResult,
  extra?: { retryRequired?: boolean }
): OverlayDismissalResult {
  const session = sessionOf(page);
  const retryRequired = Boolean(extra?.retryRequired || overlay.retryRequired);
  const occurrence: OverlayOccurrence = {
    overlayDetected: overlay.overlayDetected,
    dismissalAttempted: overlay.dismissalAttempted,
    dismissalMethod: overlay.dismissalMethod,
    dismissalSucceeded: overlay.dismissalSucceeded,
    functionalTestContinued: overlay.functionalTestContinued,
    overlayDescription: overlay.overlayDescription,
    reason: overlay.reason,
    retryRequired,
  };

  if (overlay.overlayDetected || retryRequired) {
    session.result.occurrences ??= [];
    session.result.occurrences.push(occurrence);
  }

  if (overlay.overlayDetected) {
    session.result.overlayDetected = true;
    session.result.dismissalAttempted = overlay.dismissalAttempted;
    session.result.dismissalMethod = overlay.dismissalMethod;
    session.result.dismissalSucceeded = overlay.dismissalSucceeded;
    session.result.overlayDescription = overlay.overlayDescription;
    session.result.reason = overlay.reason;
  }

  if (!overlay.functionalTestContinued) {
    session.result.functionalTestContinued = false;
    session.result.dismissalSucceeded = overlay.dismissalSucceeded;
    session.result.reason = overlay.reason;
  }

  if (retryRequired) {
    session.result.retryRequired = true;
  }

  return session.result;
}

async function resolveBlockingOverlay(
  page: Page,
  options: {
    waitForAppearanceMs: number;
    intentPoint?: { x: number; y: number };
  }
): Promise<OverlayDismissalResult> {
  if (OVERLAY_RESOLVE_PAGES.has(page)) {
    return emptyOverlayResult();
  }

  OVERLAY_RESOLVE_PAGES.add(page);
  try {
    return await resolveBlockingOverlayOnce(page, options);
  } finally {
    OVERLAY_RESOLVE_PAGES.delete(page);
  }
}

async function resolveBlockingOverlayOnce(
  page: Page,
  options: {
    waitForAppearanceMs: number;
    intentPoint?: { x: number; y: number };
  }
): Promise<OverlayDismissalResult> {
  if (!isPageOpen(page)) {
    return emptyOverlayResult();
  }

  let lastDismissed: OverlayDismissalResult | undefined;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const detected = await waitForBlockingOverlay(page, {
      waitForAppearanceMs:
        attempt === 0 ? options.waitForAppearanceMs : 400,
      intentPoint: options.intentPoint,
    });
    if (!detected) {
      if (attempt === 0) {
        if (options.waitForAppearanceMs > 500) {
          console.log("[QA Automation] Overlay: none detected");
        }
        return emptyOverlayResult();
      }
      return lastDismissed ?? emptyOverlayResult();
    }

    console.log(`[QA Automation] Overlay detected: ${detected.description}`);
    await waitIfPageOpen(page, 300);

    const control = await dismissByVisibleControl(page, detected);
    if (control && (await overlayHostDismissed(page, detected))) {
      console.log(
        `[QA Automation] Overlay dismissed by visible control (${control}); continuing Test Case`
      );
      lastDismissed = {
        overlayDetected: true,
        dismissalAttempted: true,
        dismissalMethod: "visible_dismiss_control",
        dismissalSucceeded: true,
        functionalTestContinued: true,
        overlayDescription: detected.description,
        reason: `Blocking overlay was dismissed using a visible "${control}" control.`,
        retryRequired: false,
        occurrences: [],
      };
      continue;
    }

    const clickedOutside = await dismissByClickOutside(page, detected);
    if (clickedOutside && (await overlayHostDismissed(page, detected))) {
      console.log(
        "[QA Automation] Overlay dismissed by click-outside; continuing Test Case"
      );
      lastDismissed = {
        overlayDetected: true,
        dismissalAttempted: true,
        dismissalMethod: "click_outside",
        dismissalSucceeded: true,
        functionalTestContinued: true,
        overlayDescription: detected.description,
        reason: "Blocking overlay was dismissed by clicking outside the modal.",
        retryRequired: false,
        occurrences: [],
      };
      continue;
    }

    const method: OverlayDismissalMethod = control
      ? "visible_dismiss_control"
      : clickedOutside
        ? "click_outside"
        : "none";

    console.log(
      "[QA Automation] Overlay unresolved; functional Test Case cannot continue"
    );
    return {
      overlayDetected: true,
      dismissalAttempted: clickedOutside || Boolean(control),
      dismissalMethod: method,
      dismissalSucceeded: false,
      functionalTestContinued: false,
      overlayDescription: detected.description,
      reason:
        "A blocking overlay could not be safely dismissed, so the functional Test Case could not continue.",
      retryRequired: false,
      occurrences: [],
    };
  }

  return lastDismissed ?? emptyOverlayResult();
}

async function waitForBlockingOverlay(
  page: Page,
  options: {
    waitForAppearanceMs: number;
    intentPoint?: { x: number; y: number };
  }
): Promise<OverlayCandidate | undefined> {
  const deadline = Date.now() + Math.max(0, options.waitForAppearanceMs);

  let detected = await detectBlockingOverlay(page, options.intentPoint);
  while (!detected && Date.now() < deadline) {
    await waitIfPageOpen(page, 250);
    if (!isPageOpen(page)) {
      return undefined;
    }
    detected = await detectBlockingOverlay(page, options.intentPoint);
  }

  return detected;
}

async function overlayHostDismissed(
  page: Page,
  overlay: OverlayCandidate
): Promise<boolean> {
  await waitIfPageOpen(page, 200);
  if (!isPageOpen(page)) {
    return true;
  }
  if (overlay.stamp) {
    const host = page.locator(`[data-qa-overlay-id="${overlay.stamp}"]`);
    if ((await host.count().catch(() => 0)) === 0) {
      return true;
    }
    if (!(await host.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

async function detectBlockingOverlay(
  page: Page,
  intentPoint?: { x: number; y: number }
): Promise<OverlayCandidate | undefined> {
  const candidates = await listBlockingCandidates(page, intentPoint);
  return candidates[0];
}

async function listBlockingCandidates(
  page: Page,
  intentPoint?: { x: number; y: number }
): Promise<OverlayCandidate[]> {
  if (!isPageOpen(page)) {
    return [];
  }

  const ranked = await safeEvaluate<
    OverlayCandidate[],
    { selector: string; extraPoint?: { x: number; y: number } }
  >(
    page,
    ({ selector, extraPoint }) => {
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const viewportArea = Math.max(1, viewport.width * viewport.height);
      const samplePoints: Array<[number, number]> = [
        [0.5, 0.5],
        [0.5, 0.12],
        [0.5, 0.25],
        [0.15, 0.5],
        [0.85, 0.5],
        [0.5, 0.78],
      ];
      if (extraPoint) {
        samplePoints.push([
          extraPoint.x / Math.max(1, viewport.width),
          extraPoint.y / Math.max(1, viewport.height),
        ]);
      }

      function coverageOf(box: DOMRect): number {
        const width = Math.max(
          0,
          Math.min(box.right, viewport.width) - Math.max(box.left, 0)
        );
        const height = Math.max(
          0,
          Math.min(box.bottom, viewport.height) - Math.max(box.top, 0)
        );
        return (width * height) / viewportArea;
      }

      function inViewport(box: DOMRect): boolean {
        return (
          box.bottom > 0 &&
          box.right > 0 &&
          box.top < viewport.height &&
          box.left < viewport.width &&
          box.width >= 24 &&
          box.height >= 24
        );
      }

      function presentBox(element: Element): DOMRect | undefined {
        const style = window.getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number.parseFloat(style.opacity || "1") === 0
        ) {
          return undefined;
        }
        const box = element.getBoundingClientRect();
        return inViewport(box) ? box : undefined;
      }

      function interceptCount(element: Element): number {
        let hits = 0;
        for (const [nx, ny] of samplePoints) {
          const hit = document.elementFromPoint(
            viewport.width * nx,
            viewport.height * ny
          );
          if (hit && element.contains(hit)) {
            hits += 1;
          }
        }
        return hits;
      }

      function isMeaningfulOverlay(element: Element, box: DOMRect): boolean {
        const role = (element.getAttribute("role") || "").toLowerCase();
        const ariaModal = element.getAttribute("aria-modal") === "true";
        if (
          role === "dialog" ||
          role === "alertdialog" ||
          ariaModal ||
          element.tagName === "DIALOG"
        ) {
          return true;
        }

        const style = window.getComputedStyle(element);
        const zIndex = Number.parseInt(style.zIndex || "0", 10);
        const z = Number.isNaN(zIndex) ? 0 : zIndex;
        const positioned =
          style.position === "fixed" || style.position === "sticky";
        return positioned && z >= 10 && coverageOf(box) >= 0.4;
      }

      for (const stamped of Array.from(
        document.querySelectorAll("[data-qa-overlay-id]")
      )) {
        stamped.removeAttribute("data-qa-overlay-id");
      }

      const selectorNodes = Array.from(document.querySelectorAll(selector));
      const seen = new Set<Element>(selectorNodes);
      const extras: Element[] = [];
      if (document.body) {
        let scanned = 0;
        for (const element of Array.from(document.body.querySelectorAll("*"))) {
          if (++scanned > 3000 || extras.length >= 40) {
            break;
          }
          if (seen.has(element)) {
            continue;
          }
          const style = window.getComputedStyle(element);
          if (style.position !== "fixed" && style.position !== "sticky") {
            continue;
          }
          const zIndex = Number.parseInt(style.zIndex || "0", 10);
          if (Number.isNaN(zIndex) || zIndex < 10) {
            continue;
          }
          extras.push(element);
          seen.add(element);
        }
      }

      const nodes = [...selectorNodes, ...extras];
      const ranked: Array<{
        index: number;
        stamp: string;
        description: string;
        interceptCount: number;
        coverage: number;
        content: { x: number; y: number; width: number; height: number };
        viewport: { width: number; height: number };
      }> = [];

      for (let index = 0; index < nodes.length; index += 1) {
        const element = nodes[index];
        const box = presentBox(element);
        if (!box || !isMeaningfulOverlay(element, box)) {
          continue;
        }

        const intercepts = interceptCount(element);
        const coverage = coverageOf(box);
        if (intercepts <= 0) {
          continue;
        }

        let contentBox = box;
        for (const child of Array.from(element.children) as Element[]) {
          const childBox = presentBox(child);
          if (!childBox) {
            continue;
          }
          const childCoverage = coverageOf(childBox);
          if (childCoverage >= 0.08 && childCoverage < coverageOf(contentBox)) {
            contentBox = childBox;
          }
        }

        const role =
          element.getAttribute("role") ||
          element.getAttribute("data-state") ||
          element.tagName;
        const stamp = `qa-ov-${index}-${Math.round(coverage * 100)}`;
        element.setAttribute("data-qa-overlay-id", stamp);

        ranked.push({
          index,
          stamp,
          description: `${role} covering ${Math.round(coverage * 100)}% of the viewport`,
          interceptCount: intercepts,
          coverage,
          content: {
            x: contentBox.x,
            y: contentBox.y,
            width: contentBox.width,
            height: contentBox.height,
          },
          viewport,
        });
      }

      ranked.sort((left, right) => {
        if (right.interceptCount !== left.interceptCount) {
          return right.interceptCount - left.interceptCount;
        }
        if (right.coverage !== left.coverage) {
          return right.coverage - left.coverage;
        }
        return left.index - right.index;
      });

      return ranked;
    },
    { selector: CANDIDATE_SELECTOR, extraPoint: intentPoint }
  );

  return ranked ?? [];
}

async function dismissByClickOutside(
  page: Page,
  overlay: OverlayCandidate
): Promise<boolean> {
  if (overlay.coverage >= 0.85) {
    console.log(
      "[QA Automation] Overlay: full-viewport layer has no safe click-outside point"
    );
    return false;
  }

  const point = clickOutsidePoint(overlay);
  if (!point) {
    console.log(
      "[QA Automation] Overlay: no safe click-outside point outside modal bounds"
    );
    return false;
  }

  console.log(
    `[QA Automation] Overlay: clicking outside at (${Math.round(point.x)}, ${Math.round(point.y)})`
  );
  try {
    await page.mouse.click(point.x, point.y);
  } catch (error) {
    if (isStrictModeError(error)) {
      return false;
    }
    throw error;
  }
  await page.waitForTimeout(800);
  return true;
}

function clickOutsidePoint(
  overlay: OverlayCandidate
): { x: number; y: number } | undefined {
  const { content, viewport } = overlay;
  const pad = 12;
  const candidates = [
    { x: pad, y: pad },
    { x: viewport.width - pad, y: pad },
    { x: pad, y: viewport.height - pad },
    { x: viewport.width - pad, y: viewport.height - pad },
    { x: pad, y: viewport.height / 2 },
    { x: viewport.width - pad, y: viewport.height / 2 },
  ];

  return candidates.find((point) => {
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x > viewport.width ||
      point.y > viewport.height
    ) {
      return false;
    }
    return !pointInBox(point, content);
  });
}

function pointInBox(
  point: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

async function dismissByVisibleControl(
  page: Page,
  overlay: OverlayCandidate
): Promise<string | undefined> {
  const hosts: Locator[] = [];
  if (overlay.stamp) {
    hosts.push(page.locator(`[data-qa-overlay-id="${overlay.stamp}"]`));
  }

  const roots = page.locator(CANDIDATE_SELECTOR);
  const rootCount = await roots.count().catch(() => 0);
  if (overlay.index >= 0 && overlay.index < rootCount) {
    hosts.push(roots.nth(overlay.index));
  }

  if (overlay.coverage >= 0.4) {
    hosts.push(page.locator("body"));
  }

  for (const host of hosts) {
    const label = await clickSafeDismissIn(host);
    if (label) {
      return label;
    }
  }

  return undefined;
}

async function clickSafeDismissIn(root: Locator): Promise<string | undefined> {
  const namedControls: Locator[] = [];
  for (const name of DISMISS_NAMES) {
    namedControls.push(
      root.getByRole("button", { name }),
      root.getByRole("link", { name })
    );
  }
  namedControls.push(
    root.getByRole("button", { name: /^x$/i }),
    root.getByLabel(/^close$/i),
    root.getByLabel(/^cancel$/i)
  );

  for (const locator of namedControls) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 6); index += 1) {
      const control = locator.nth(index);
      if (!(await control.isVisible().catch(() => false))) {
        continue;
      }
      if (!(await control.isEnabled().catch(() => false))) {
        continue;
      }
      const label = (
        (await control.innerText().catch(() => "")) ||
        (await control.getAttribute("aria-label").catch(() => "")) ||
        ""
      ).trim();
      if (FORBIDDEN_CONTROL.test(label)) {
        continue;
      }
      console.log(
        `[QA Automation] Overlay: clicking visible dismiss control "${label || "unnamed"}"`
      );
      try {
        await control.click({ timeout: 5000 });
      } catch (error) {
        if (isStrictModeError(error)) {
          continue;
        }
        throw error;
      }
      await root.page().waitForTimeout(800);
      return label || "dismiss control";
    }
  }

  return undefined;
}

function isStrictModeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /strict mode violation/i.test(message);
}

function isInterceptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /intercepts pointer events|was intercepted|not receiving pointer events/i.test(
    message
  );
}

/**
 * Guards Playwright page use so helpers never evaluate or act on a closed page.
 */

import type { Page } from "@playwright/test";

export function isPageOpen(page: Page): boolean {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

export function isTargetClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target page, context or browser has been closed|target closed|has been closed/i.test(
    message
  );
}

export async function safeEvaluate<T, A = unknown>(
  page: Page,
  pageFunction: (arg: A) => T,
  arg: A
): Promise<T | undefined> {
  if (!isPageOpen(page)) {
    return undefined;
  }

  try {
    return (await page.evaluate(pageFunction as never, arg as never)) as T;
  } catch (error) {
    if (isTargetClosedError(error)) {
      console.log(
        "[QA Automation] Skipping page.evaluate because the page/context is closed"
      );
      return undefined;
    }
    throw error;
  }
}

export async function safeEvaluateNoArg<T>(
  page: Page,
  pageFunction: () => T
): Promise<T | undefined> {
  if (!isPageOpen(page)) {
    return undefined;
  }

  try {
    return (await page.evaluate(pageFunction as never)) as T;
  } catch (error) {
    if (isTargetClosedError(error)) {
      console.log(
        "[QA Automation] Skipping page.evaluate because the page/context is closed"
      );
      return undefined;
    }
    throw error;
  }
}

export async function waitIfPageOpen(page: Page, ms: number): Promise<void> {
  if (!isPageOpen(page)) {
    return;
  }
  await page.waitForTimeout(ms).catch((error) => {
    if (!isTargetClosedError(error)) {
      throw error;
    }
  });
}

/**
 * Application entry URL for generated Playwright specs.
 *
 * Resolution order:
 * 1. Explicit URL from the Test Case, when present
 * 2. Optional HOMEPAGE / BASE_URL override, when configured
 * 3. The project default Groupon homepage
 *
 * HOMEPAGE is never mandatory. Specs must run from a clean checkout.
 */

export const PROJECT_DEFAULT_APPLICATION_URL = "https://www.groupon.com/";

export interface ResolveApplicationUrlOptions {
  testCaseUrl?: string;
  testCaseText?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveApplicationUrl(
  options: ResolveApplicationUrlOptions = {}
): string {
  const env = options.env ?? process.env;

  const fromTestCase =
    firstHttpUrl(options.testCaseUrl) ?? extractHttpUrl(options.testCaseText);
  if (fromTestCase) {
    return fromTestCase;
  }

  const override = firstHttpUrl(env.HOMEPAGE) ?? firstHttpUrl(env.BASE_URL);
  if (override) {
    return override;
  }

  return PROJECT_DEFAULT_APPLICATION_URL;
}

export function extractHttpUrl(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  return firstHttpUrl(match?.[0]);
}

function firstHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = value.trim().replace(/[.,;:)\]}]+$/g, "");
  if (!cleaned) {
    return undefined;
  }

  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Reusable Groupon deal URL recognition.
 *
 * A Groupon deal destination follows /deals/<slug>.
 * Query parameters after the slug do not change that.
 *
 * This is product knowledge for identifying deal/result cards.
 * It does not encode a particular slug, query, or Test Case expectation.
 */

export function isGrouponDealHref(
  href: string | null | undefined,
  baseUrl: string = "https://www.groupon.com/"
): boolean {
  return grouponDealSlug(href, baseUrl) !== undefined;
}

export function grouponDealSlug(
  href: string | null | undefined,
  baseUrl: string = "https://www.groupon.com/"
): string | undefined {
  if (!href) {
    return undefined;
  }

  const trimmed = href.trim();
  if (!trimmed) {
    return undefined;
  }

  const lowered = trimmed.toLowerCase();
  if (
    lowered.startsWith("#") ||
    lowered.startsWith("javascript:") ||
    lowered.startsWith("mailto:") ||
    lowered.startsWith("tel:")
  ) {
    return undefined;
  }

  try {
    const url = new URL(trimmed, baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]?.toLowerCase() !== "deals") {
      return undefined;
    }
    const slug = parts[1]?.trim();
    return slug ? slug : undefined;
  } catch {
    return undefined;
  }
}

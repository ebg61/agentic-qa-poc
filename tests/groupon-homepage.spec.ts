import { test, expect } from '@playwright/test';

test('inspect links on Groupon homepage', async ({ page }) => {
  await page.goto('https://www.groupon.com/', {
    waitUntil: 'domcontentloaded',
  });

  const links = await page.locator('a').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      text: (anchor.textContent || '').trim(),
      href: (anchor as HTMLAnchorElement).href,
    }))
  );

  console.log(`Found ${links.length} links`);

  for (const link of links) {
    console.log(`${link.text} → ${link.href}`);
  }

  expect(links.length).toBeGreaterThan(0);
});
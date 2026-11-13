import { test } from '@playwright/test';

test('capture sequence map with in-lane labels', async ({ page }) => {
  await page.goto('http://localhost:3106', { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForTimeout(2000);

  const enterButton = page.locator('text=enter').first();
  if ((await enterButton.count()) > 0) {
    await enterButton.click();
    await page.waitForTimeout(3000);
  }

  await page.screenshot({
    path: 'test-results/minimap-labels-workspace.png',
    fullPage: false,
  });
});

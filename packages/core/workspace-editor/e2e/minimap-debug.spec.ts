import { test } from '@playwright/test';

test('capture minimap screenshots', async ({ page }) => {
  await page.goto('http://localhost:3106');

  await page.waitForTimeout(2000);

  await page.screenshot({
    path: 'test-results/minimap-full-page.png',
    fullPage: false,
  });

  const minimap = page.locator('[class*="minimap"], [data-testid*="minimap"]').first();
  if ((await minimap.count()) > 0) {
    await minimap.screenshot({ path: 'test-results/minimap-only.png' });
  }

  const linearView = page.locator('[class*="linear"], [data-testid*="linear"]').first();
  if ((await linearView.count()) > 0) {
    await linearView.screenshot({ path: 'test-results/linear-view.png' });
  }
});

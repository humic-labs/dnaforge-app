import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { resolveDesktopDevPort } from '../../tools/devops/scripts/lib/dev-cdp-port.mjs';

const root = resolve(__dirname, '../..');
const desktopUrl =
  process.env.PLAYWRIGHT_DESKTOP_URL ??
  `http://localhost:${resolveDesktopDevPort({ cwd: resolve(root, 'apps/desktop') })}`;
const desktopPort = resolveDesktopDevPort({ cwd: resolve(root, 'apps/desktop') });

export default defineConfig({
  testDir: '.',
  testMatch: 'sequence-webgl-parity.e2e.ts',
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['list']],
  globalSetup: './sequence-webgl-setup.ts',
  outputDir: '../../test-results/sequence-webgl',
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    baseURL: desktopUrl,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm --dir apps/desktop exec vite --config vite.renderer.config.ts --host 127.0.0.1 --port ${desktopPort} --strictPort`,
    url: desktopUrl,
    cwd: root,
    reuseExistingServer: true,
    timeout: 120000,
  },
});

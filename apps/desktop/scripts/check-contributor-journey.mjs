import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(appDir, '../..');
const output = path.resolve(
  process.argv[2] ?? path.join(root, '.evidence', `contributor-${Date.now()}`)
);
const profile = path.join(output, 'profile');
assert.ok(
  !existsSync(profile),
  'Use a new output directory so this check starts with a fresh profile.'
);
mkdirSync(output, { recursive: true });
const settings = Object.fromEntries(
  readFileSync(path.join(appDir, '.env.local'), 'utf8')
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
      return match ? [[match[1], match[2]]] : [];
    })
);
const devPort = Number(settings.DESKTOP_DEV_PORT);
const apiPort = Number(settings.API_PORT);
const debugPort = Number(settings.DESKTOP_DEBUG_PORT) || (devPort >= 1421 ? devPort + 7800 : 9223);
assert.ok(Number.isInteger(devPort) && devPort > 0 && Number.isInteger(apiPort) && apiPort > 0);
const source = path.join(appDir, 'src/components/ProjectSwitcherPopover.tsx');
const before = readFileSync(source, 'utf8');
const originalLabel = '<span>New project</span>';
const changedLabel = '<span>Create hackathon project</span>';
assert.equal(
  before.split(originalLabel).length,
  2,
  'The exercise source label must exist exactly once.'
);
assert.equal(
  spawnSync('git', ['diff', '--quiet', 'HEAD', '--', source], { cwd: root }).status,
  0,
  'Restore local edits to ProjectSwitcherPopover.tsx before running this check.'
);
const sourceHash = createHash('sha256').update(before).digest('hex');
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const summary = {
  head,
  platform: process.platform,
  sourceHash,
  output,
  profile,
  startedAt: new Date().toISOString(),
  assertions: [],
  errors: [],
};
const startupURL = `http://127.0.0.1:${debugPort}/json/list`;
try {
  const response = await fetch(startupURL, { signal: AbortSignal.timeout(1000) });
  assert.fail(
    `The debug port is already occupied (HTTP ${response.status}); stop this checkout's dev app first.`
  );
} catch (error) {
  if (error.code === 'ERR_ASSERTION') throw error;
}
const child = spawn('pnpm', ['run', 'dev'], {
  cwd: appDir,
  env: {
    ...process.env,
    DNAFORGE_BACKGROUND_WINDOW: '1',
    ELECTRON_CLI_ARGS: JSON.stringify([`--user-data-dir=${profile}`]),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
let childExit = null;
child.on('exit', (code, signal) => {
  childExit = { code, signal };
});
child.on('error', (error) => {
  childExit = { error: error.message };
});
const logs = [];
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    logs.push(String(chunk));
    process.stdout.write(chunk);
  });
let browser;
let context;
let cdp;
let sourceChanged = false;
let failure;
const frames = [];
const frameWrites = [];
try {
  await expect
    .poll(
      async () => {
        assert.equal(childExit, null, `Dev launcher exited: ${JSON.stringify(childExit)}`);
        try {
          const targets = await (
            await fetch(startupURL, { signal: AbortSignal.timeout(2000) })
          ).json();
          return targets.some(
            (target) =>
              target.type === 'page' &&
              new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${devPort}/`, 'u').test(target.url)
          );
        } catch {
          return false;
        }
      },
      { timeout: 600_000, intervals: [1000] }
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  context = browser.contexts()[0];
  let page;
  await expect
    .poll(
      () => {
        page = context
          .pages()
          .find((candidate) =>
            new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${devPort}/`, 'u').test(candidate.url())
          );
        return Boolean(page);
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.electronAPI?.startup?.getState?.());
        return state?.pageLoaded === true && state?.shellReady === true;
      },
      { timeout: 600_000 }
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        try {
          return (
            await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(2000) })
          ).status;
        } catch {
          return 0;
        }
      },
      { timeout: 120_000 }
    )
    .toBe(200);
  summary.assertions.push('Loaded renderer, ready shell and sidecar HTTP 200');
  page.on('pageerror', (error) => summary.errors.push(error.message));
  await context.tracing.start({ screenshots: true, snapshots: true });
  cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (event) => {
    const name = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
    frames.push({ name, timestamp: event.metadata.timestamp });
    frameWrites.push(writeFile(path.join(output, name), Buffer.from(event.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 900,
    everyNthFrame: 2,
  });
  for (const name of ['Dev Assets', 'Test Fixtures']) {
    const row = page.getByRole('treeitem', { name, exact: true });
    if ((await row.count()) && (await row.getAttribute('aria-expanded')) === 'true')
      await row.click();
  }
  const samples = page.getByRole('treeitem', { name: 'DNAForge Samples', exact: true });
  await expect(samples).toBeVisible({ timeout: 60_000 });
  if ((await samples.getAttribute('aria-expanded')) !== 'true') await samples.click();
  const notebooks = page.getByRole('treeitem', { name: 'notebooks', exact: true });
  if ((await notebooks.getAttribute('aria-expanded')) !== 'true') await notebooks.click();
  const notebookName = '01 — Programme charter — burden-aware three-input logic in E. coli';
  const row = page.getByRole('treeitem', { name: notebookName, exact: true });
  const notebookPath = await row.getAttribute('data-entry-path');
  const relativeNotebook = notebookPath ? path.relative(profile, notebookPath) : '..';
  assert.ok(
    notebookPath && !relativeNotebook.startsWith('..') && !path.isAbsolute(relativeNotebook),
    'Edit only the sample copy inside this check’s profile.'
  );
  await row.dblclick();
  const editor = page.getByTestId('notebook-editor-body').locator('[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(output, '01-notebook-before.png') });
  const metadata = JSON.parse(
    await readFile(path.join(notebookPath, '.forge', 'notebook.json'), 'utf8')
  );
  assert.equal(metadata.authority?.type, 'markdown');
  assert.ok(
    typeof metadata.authority.path === 'string' &&
      path.basename(metadata.authority.path) === metadata.authority.path
  );
  const markdownPath = path.join(notebookPath, metadata.authority.path);
  const originalMarkdown = await readFile(markdownPath, 'utf8');
  const addition = 'Hello from my local hackathon checkout.';
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(addition);
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(markdownPath, 'utf8'), { timeout: 30_000 }).toContain(addition);
  const closeNotebook = page.getByRole('button', {
    name: 'Close Programme charter — burden-aware three-input logic in E. coli',
    exact: true,
  });
  const notebookTab = page.getByRole('tab').filter({ has: closeNotebook });
  await expect(notebookTab.locator('[data-tab-dirty="true"]')).toHaveCount(0, { timeout: 30_000 });
  await page.screenshot({ path: path.join(output, '02-notebook-saved.png') });
  await closeNotebook.click();
  await expect(closeNotebook).toBeHidden();
  await row.dblclick();
  await expect(editor).toContainText(addition);
  await page.screenshot({ path: path.join(output, '03-notebook-reopened.png') });
  summary.assertions.push(
    'Bundled sample notebook edited through UI, saved to disk and reopened with the new text'
  );
  summary.notebook = {
    path: markdownPath,
    beforeHash: createHash('sha256').update(originalMarkdown).digest('hex'),
    afterHash: createHash('sha256')
      .update(await readFile(markdownPath))
      .digest('hex'),
  };
  await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
  await expect(page.getByTestId('project-switcher-new-project')).toHaveText('New project');
  await page.screenshot({ path: path.join(output, '04-source-before.png') });
  sourceChanged = true;
  await writeFile(source, before.replace(originalLabel, changedLabel));
  await expect(page.getByTestId('project-switcher-new-project')).toHaveText(
    'Create hackathon project',
    { timeout: 60_000 }
  );
  await page.screenshot({ path: path.join(output, '05-source-reloaded.png') });
  await writeFile(source, before);
  sourceChanged = false;
  await expect(page.getByTestId('project-switcher-new-project')).toHaveText('New project', {
    timeout: 60_000,
  });
  await page.screenshot({ path: path.join(output, '06-source-restored.png') });
  summary.assertions.push(
    'A source label edit appeared in the live app and restoring the source restored the UI'
  );
  const tests = spawnSync(
    'pnpm',
    [
      '--dir',
      'apps/desktop',
      'test',
      '--',
      'src/features/workspace-loader/workspace-projects.test.ts',
    ],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000 }
  );
  writeFileSync(
    path.join(output, 'focused-test.log'),
    `${tests.stdout ?? ''}${tests.stderr ?? ''}`
  );
  assert.equal(tests.status, 0, 'The documented focused test must pass.');
  summary.assertions.push('Documented focused workspace-projects test passed');
  assert.deepEqual(
    summary.errors,
    [],
    'The contributor journey must not throw renderer exceptions.'
  );
} catch (error) {
  failure = error;
  summary.failure = error.stack ?? String(error);
} finally {
  if (sourceChanged) await writeFile(source, before);
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  await Promise.all(frameWrites);
  if (context) await context.tracing.stop({ path: path.join(output, 'trace.zip') }).catch(() => {});
  if (browser) await browser.close();
  const stop = spawnSync('pnpm', ['run', 'dev', '--', '--stop'], {
    cwd: appDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 120_000,
  });
  writeFileSync(path.join(output, 'stop.log'), `${stop.stdout ?? ''}${stop.stderr ?? ''}`);
  if (!childExit) child.kill('SIGTERM');
  writeFileSync(path.join(output, 'dev.log'), logs.join(''));
  writeFileSync(path.join(output, 'frames.json'), JSON.stringify(frames, null, 2));
  if (frames.length > 1 && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
    const concat = frames
      .map(
        (frame, index) =>
          `file '${frame.name}'\nduration ${index + 1 < frames.length ? Math.max(0.01, frames[index + 1].timestamp - frame.timestamp) : 0.25}`
      )
      .join('\n');
    writeFileSync(path.join(output, 'frames.txt'), concat + '\n');
    const video = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'frames.txt',
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        'journey.mp4',
      ],
      { cwd: output, encoding: 'utf8', timeout: 120_000 }
    );
    summary.video = {
      exitCode: video.status,
      stderr: video.stderr,
      path: path.join(output, 'journey.mp4'),
    };
  }
  summary.sourceRestored =
    createHash('sha256').update(readFileSync(source)).digest('hex') === sourceHash;
  summary.stopExitCode = stop.status;
  summary.finishedAt = new Date().toISOString();
  summary.passed = !failure && summary.sourceRestored && stop.status === 0;
  writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(summary, null, 2) + '\n');
}
console.log(`CONTRIBUTOR_JOURNEY_${summary.passed ? 'OK' : 'FAILED'} ${JSON.stringify(summary)}`);
if (failure) console.error(failure);
process.exitCode = summary.passed ? 0 : 1;

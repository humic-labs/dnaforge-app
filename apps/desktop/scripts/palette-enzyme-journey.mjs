import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { reloadNativePage } from './lib/native-journey-readiness.mjs';

const root = path.resolve(
  process.env.DNAFORGE_VERIFY_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
);
const sourceFiles = execFileSync(
  'git',
  [
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
    '--',
    'apps/desktop/src',
    'apps/desktop/scripts',
    'packages',
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
  .split('\0')
  .filter((file) => /^(apps\/desktop\/(src|scripts)|packages)\//u.test(file));
const sourceHash = createHash('sha256');
for (const file of [...new Set(sourceFiles)].sort()) {
  sourceHash.update(file);
  sourceHash.update(readFileSync(path.join(root, file)));
}
const sourceFingerprint = sourceHash.digest('hex');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const out = args.includes('--out') ? path.resolve(option('--out')) : null;
assert.ok(out, 'Pass --out with an evidence directory outside the checkout.');
assert.ok(!out.startsWith(`${root}${path.sep}`), 'Keep evidence outside the checkout.');
mkdirSync(out, { recursive: true });
const settings = Object.fromEntries(
  readFileSync(path.join(root, 'apps/desktop/.env.local'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.split('='))
);
const rendererPort = Number(settings.DESKTOP_DEV_PORT);
const debugPort = Number(settings.DESKTOP_DEBUG_PORT) || rendererPort + 7800;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
const page = browser
  .contexts()[0]
  .pages()
  .find((candidate) => {
    const url = new URL(candidate.url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) && Number(url.port) === rendererPort;
  });
assert.ok(page, 'The task renderer must be running on its configured port.');
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 400 && /\/data\/rebase\/|\/genome\/|\/tiles\//u.test(response.url()))
    errors.push(`${response.status()} ${response.url()}`);
});
const observations = [];
const startupObservations = [];
const reload = (name) =>
  reloadNativePage(page, {
    observe: ({ phase, startup }) =>
      startupObservations.push({ name: `${name}-${phase}`, value: startup }),
  });
const capture = async (name, value) => {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  observations.push({ name, value });
};
let verdict = 'failed';
let failure = null;
try {
  await page.waitForFunction(() => window.__test?.setWorkspaceFoldersForTest);
  const runtime = await page.evaluate(async () => ({
    profile: window.electronAPI.runtime.getProfile(),
    provenance: await window.electronAPI.runtime.getProvenance(),
  }));
  assert.equal(runtime.profile.kind, 'scenario-e2e');
  assert.equal(path.resolve(runtime.provenance.projectRoot), root);
  observations.push({ name: 'runtime', value: runtime });
  if (args.includes('--doctor')) {
    console.log(JSON.stringify(runtime));
  } else {
    const workspace = path.join(out, 'workspace');
    const referencePath = path.join(out, 'reference.fa');
    mkdirSync(workspace, { recursive: true });
    execFileSync('git', ['init', '-q', workspace]);
    cpSync(
      path.join(
        root,
        'apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/plasmids/pUC19'
      ),
      path.join(workspace, 'pUC19'),
      { recursive: true }
    );
    writeFileSync(referencePath, `>chr1\n${'ACGT'.repeat(250)}\n>chr2\n${'AGCT'.repeat(500)}\n`);
    copyFileSync(
      path.join(root, 'test-fixtures/indexed/palette-signal.bw'),
      path.join(workspace, 'signal.bw')
    );
    await page.evaluate(async (workspaceRoot) => {
      window.__webglExposeForTests = true;
      await window.__test.setWorkspaceFoldersForTest([workspaceRoot]);
      await window.__test.openFile(`${workspaceRoot}/pUC19/pUC19.gb`);
    }, workspace);
    await page.getByTestId('toolbar-restriction-enzymes').click();
    await page.getByPlaceholder('Name', { exact: true }).fill('SacI');
    const sacI = page.locator('[data-enzyme-name="SacI"]');
    await expect(sacI).toContainText('1 cut', { timeout: 30000 });
    await capture('01-catalog-sacI', await sacI.innerText());
    await sacI.click();
    await expect(page.getByTitle('Remove SacI', { exact: true })).toBeVisible();
    const sites = () =>
      page.evaluate(
        () =>
          window.__webglRenderer?.cutSites?.map((site) => ({
            name: site.enzyme.name,
            position: site.position,
            cutPositionTop: site.cutPositionTop,
            cutPositionBottom: site.cutPositionBottom,
          })) ?? []
      );
    await expect.poll(sites).toEqual([expect.objectContaining({ name: 'SacI' })]);
    const selected = await sites();
    await capture('02-selected-sacI', selected);
    await reload('restore-enzymes');
    await page.getByTestId('toolbar-restriction-enzymes').waitFor();
    await expect.poll(sites).toEqual(selected);
    await page.getByTestId('toolbar-restriction-enzymes').click();
    await page.getByTitle('Remove SacI', { exact: true }).click();
    await expect.poll(sites).toEqual([]);
    await capture('03-empty-enzyme-selection', await sites());

    const trackInputs = { workspaceRoot: workspace, referencePath };
    const saved = await page.evaluate(async ({ workspaceRoot, referencePath }) => {
      const { platform } = await import('/src/platform/index.ts');
      const imported = await platform().referenceAssets.importLocal({
        operationId: crypto.randomUUID(),
        sourcePath: referencePath,
        themeMode: 'light',
      });
      if (imported.status !== 'ready') throw new Error(JSON.stringify(imported));
      const savedView = await platform().trackViews.command({
        operation: 'create',
        project: workspaceRoot,
        referenceId: imported.entry.id,
        requestId: crypto.randomUUID(),
        name: 'Palette acceptance',
        path: 'Palette acceptance.dnaforge-track-view.json',
        viewport: { chrom: 'chr2', start0: 0, end0: 100 },
        tracks: [
          {
            source: { kind: 'path', path: `${workspaceRoot}/signal.bw` },
            format: 'bigwig',
            label: 'Measured signal',
            color: '#d97706',
            heightPx: 120,
            range: { min: 0, max: 12 },
          },
        ],
      });
      await window.__test.openFile(savedView.path);
      return savedView;
    }, trackInputs);
    await expect(page.getByTestId('indexed-genome-tab')).toHaveAttribute(
      'data-coordinate-ready',
      'true',
      { timeout: 60000 }
    );
    const trackId = saved.tracks[0].trackId;
    const diagnostics = () =>
      page.evaluate(
        (id) => window.__webglRendererByProduct?.indexed?.getTrackDiagnostics(id),
        trackId
      );
    await expect.poll(async () => (await diagnostics())?.barCount ?? 0).toBeGreaterThan(0);
    await page
      .getByRole('button', { name: 'Open settings for Measured signal', exact: true })
      .click();
    const color = page.getByRole('button', { name: 'Color for Measured signal', exact: true });
    await expect(color).toHaveAttribute('data-color', '#d97706');
    await color.click();
    const presets = page.getByLabel('Suggested track colors').getByRole('button');
    assert.equal(await presets.count(), 12);
    await capture(
      '04-track-palette',
      await presets.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
    );
    await page.getByRole('button', { name: 'Use #16a34a', exact: true }).click();
    await expect(color).toHaveAttribute('data-color', '#16a34a');
    await color.click();
    await page
      .getByRole('textbox', { name: 'Hex color for Measured signal', exact: true })
      .fill('#123456');
    await page
      .getByRole('textbox', { name: 'Hex color for Measured signal', exact: true })
      .press('Enter');
    await expect(color).toHaveAttribute('data-color', '#123456');
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click();
    await expect(color).toHaveAttribute('data-color', '#3b82f6');
    await color.click();
    await page
      .getByRole('textbox', { name: 'Hex color for Measured signal', exact: true })
      .fill('#123456');
    await page
      .getByRole('textbox', { name: 'Hex color for Measured signal', exact: true })
      .press('Enter');
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    await expect
      .poll(() => JSON.parse(readFileSync(saved.path, 'utf8')).dataTracks[0].color)
      .toBe(0x123456);
    await capture('05-saved-custom-color', {
      diagnostics: await diagnostics(),
      document: JSON.parse(readFileSync(saved.path, 'utf8')),
    });
    await reload('restore-track-color');
    await page
      .getByRole('button', { name: 'Open settings for Measured signal', exact: true })
      .click();
    await expect(color).toHaveAttribute('data-color', '#123456');
    await expect.poll(async () => (await diagnostics())?.barCount ?? 0).toBeGreaterThan(0);
    await capture('06-restored-custom-color', await diagnostics());
    assert.deepEqual(errors, []);
  }
  verdict = 'passed';
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  writeFileSync(
    path.join(out, 'receipt.json'),
    JSON.stringify(
      {
        verdict,
        sourceFingerprint,
        failure,
        root,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        observations,
        startupObservations,
        errors,
      },
      null,
      2
    )
  );
  await browser.close();
}

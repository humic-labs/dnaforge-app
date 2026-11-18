import {
  runInventoryRunValueAttributions,
  runInventoryRunValueAttributionsResume,
  runInventoryRunValueAttributionsReopen,
} from './journeys/inventory-run-value-attributions.mjs';
import {
  runInventoryRunValues,
  runInventoryRunValuesResume,
  runInventoryRunValuesReopen,
} from './journeys/inventory-run-values.mjs';
import {
  runInventoryPlatePlanObservation,
  runInventoryPlatePlanObservationResume,
  runInventoryPlatePlanObservationReopen,
} from './journeys/inventory-plate-plan-observations.mjs';
import {
  runInventoryPlatePlans,
  runInventoryPlatePlansResume,
  runInventoryPlatePlansReopen,
} from './journeys/inventory-plate-plans.mjs';
import {
  runInventoryScientificCitations,
  runInventoryScientificCitationsResume,
  runInventoryScientificCitationsReopen,
  runInventoryScientificCitationsReattach,
  runInventoryScientificCitationsReattachResume,
} from './journeys/inventory-scientific-citations.mjs';
import {
  runInventoryRunRecordedWork,
  runInventoryRunRecordedWorkReopen,
} from './journeys/inventory-run-recorded-work.mjs';
import {
  runInventoryProtocolRunJourney,
  runInventoryProtocolRunResume,
  runInventoryProtocolRunReopen,
} from './journeys/inventory-protocol-run.mjs';
import {
  runInventoryScientificJourney,
  runInventoryScientificResume,
  runInventoryScientificReopen,
  runInventoryScientificSourceEdit,
  runInventoryScientificSourceEditResume,
} from './journeys/inventory-scientific.mjs';
import {
  runInventoryArrivalEvidenceJourney,
  runInventoryArrivalEvidenceResume,
  runInventoryArrivalEvidenceReopen,
  runInventoryArrivalEvidenceTextJourney,
  runInventoryArrivalEvidenceTextResume,
} from './journeys/inventory-arrival-evidence.mjs';
import {
  runInventoryStockroomJourney,
  runInventoryStockroomResume,
  runInventoryStockroomReopen,
  runInventoryStockroomCorrectionsJourney,
  runInventoryStockroomCorrectionsResume,
  runInventoryStockroomCorrectionsReopen,
} from './journeys/inventory-stockroom.mjs';
import {
  runInventoryArrivalJourney,
  runInventoryArrivalResume,
  runInventoryArrivalReopen,
  runInventoryArrivalComponents,
  runInventoryArrivalComponentsResume,
  runInventoryArrivalComponentsReopen,
} from './journeys/inventory-arrivals.mjs';
import {
  runInventoryOpeningJourney,
  runInventoryOpeningResume,
  runInventoryOpeningReopen,
  runInventoryOpeningTimer,
  runInventoryOpeningTimerReopen,
} from './journeys/inventory-opening-validity.mjs';
import {
  runInventoryLotJourney,
  runInventoryLotResume,
  runInventoryLotReopen,
  releaseInventoryJourneyLot,
} from './journeys/inventory-lot-controls.mjs';
import {
  runInventoryAmountsJourney,
  runInventoryAmountsResume,
  runInventoryAmountsReopen,
} from './journeys/inventory-amounts.mjs';
import {
  runInventoryBenchlingApplicationJourney,
  runInventoryBenchlingApplicationResume,
  runInventoryBenchlingApplicationReopen,
} from './journeys/inventory-benchling-application.mjs';
import {
  runInventoryContentsJourney,
  runInventoryContentsResume,
  runInventoryContentsReopen,
} from './journeys/inventory-contents.mjs';
import {
  runInventoryMappedJourney,
  runInventoryMappedResume,
  runInventoryMappedReopen,
} from './journeys/inventory-mapped-tables.mjs';
import { runInventoryBenchlingCaptureJourney } from './journeys/inventory-benchling-captures.mjs';
import {
  runInventoryHierarchyJourney,
  runInventoryHierarchyReopen,
  runInventoryHierarchyResume,
} from './journeys/inventory-hierarchy.mjs';
import {
  runInventorySourceRevisionJourney,
  runInventorySourceRevisionReopen,
} from './journeys/inventory-source-revisions.mjs';
import {
  runInventoryStocktakeJourney,
  runInventoryStocktakeReopen,
} from './journeys/inventory-stocktake.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { runInventoryTableJourney, runInventoryTableReopen } from './journeys/inventory-tables.mjs';
import { runInventoryCompositionJourney } from './journeys/inventory-composition.mjs';
import {
  runInventoryPortabilityJourney,
  runInventoryPortabilityReopen,
} from './journeys/inventory-portability.mjs';
import {
  runInventoryConditionsJourney,
  runInventoryConditionsReopen,
  runInventoryThermalContextJourney,
  runInventoryTemperatureCatalogRecovery,
} from './journeys/inventory-conditions.mjs';
import { runInventoryLabelJourney, runInventoryLabelReopen } from './journeys/inventory-labels.mjs';
import {
  runInventoryItemCodeJourney,
  runInventoryItemCodeReopen,
} from './journeys/inventory-item-codes.mjs';
import {
  runInventoryCatalogJourney,
  runInventoryCatalogReopen,
} from './journeys/inventory-catalog.mjs';
import {
  runInventoryConfigurationJourney,
  runInventoryConfigurationReopen,
} from './journeys/inventory-configuration.mjs';
import {
  runInventoryCustodyJourney,
  runInventoryCustodyReopen,
} from './journeys/inventory-custody.mjs';
import {
  runInventoryReservationJourney,
  runInventoryReservationReopen,
} from './journeys/inventory-reservations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const stage = args.includes('--stage') ? option('--stage') : 'doctor';
const runValueAttributionStages = {
  'run-value-attributions': runInventoryRunValueAttributions,
  'run-value-attributions-resume': runInventoryRunValueAttributionsResume,
  'run-value-attributions-reopen': runInventoryRunValueAttributionsReopen,
};
const runValueStages = {
  'run-values': runInventoryRunValues,
  'run-values-resume': runInventoryRunValuesResume,
  'run-values-reopen': runInventoryRunValuesReopen,
};
const platePlanObservationStages = {
  'plate-plan-observation': runInventoryPlatePlanObservation,
  'plate-plan-observation-resume': runInventoryPlatePlanObservationResume,
  'plate-plan-observation-reopen': runInventoryPlatePlanObservationReopen,
};
const platePlanStages = {
  'plate-plans': runInventoryPlatePlans,
  'plate-plans-resume': runInventoryPlatePlansResume,
  'plate-plans-reopen': runInventoryPlatePlansReopen,
};
const citationStages = {
  'scientific-citations': runInventoryScientificCitations,
  'scientific-citations-resume': runInventoryScientificCitationsResume,
  'scientific-citations-reopen': runInventoryScientificCitationsReopen,
  'scientific-citations-reattach': runInventoryScientificCitationsReattach,
  'scientific-citations-reattach-resume': runInventoryScientificCitationsReattachResume,
};
const recordedWorkStages = {
  'run-recorded-work': runInventoryRunRecordedWork,
  'run-recorded-work-reopen': runInventoryRunRecordedWorkReopen,
};
assert.ok(
  [
    ...Object.keys(recordedWorkStages),
    ...Object.keys(runValueStages),
    ...Object.keys(runValueAttributionStages),
    ...Object.keys(platePlanObservationStages),
    ...Object.keys(platePlanStages),
    ...Object.keys(citationStages),
    'doctor',
    'before',
    'journey',
    'reopen',
    'materials',
    'material-reopen',
    'lineage',
    'layouts',
    'composition',
    'composition-reopen',
    'reservations',
    'reservation-reopen',
    'custody',
    'custody-reopen',
    'configuration',
    'configuration-reopen',
    'catalog',
    'catalog-reopen',
    'item-codes',
    'item-code-reopen',
    'labels',
    'labels-preview',
    'label-reopen',
    'conditions',
    'conditions-reopen',
    'thermal-context',
    'conditions-catalog-recover',
    'archive-preview',
    'archive-reopen',
    'table-receive',
    'table-reopen',
    'stocktake',
    'stocktake-reopen',
    'source-revision',
    'source-revision-reopen',
    'hierarchy',
    'hierarchy-reopen',
    'hierarchy-resume',
    'mapped-table',
    'mapped-resume',
    'mapped-reopen',
    'contents',
    'contents-reopen',
    'contents-resume',
    'amounts',
    'amounts-resume',
    'amounts-reopen',
    'refresh-fixture',
    'arrival-evidence',
    'arrival-evidence-resume',
    'arrival-evidence-reopen',
    'arrival-evidence-text',
    'arrival-evidence-text-resume',
    'protocol-run',
    'protocol-run-resume',
    'protocol-run-reopen',
    'scientific',
    'scientific-resume',
    'scientific-reopen',
    'scientific-source-edit',
    'scientific-source-edit-resume',
    'stockroom',
    'stockroom-resume',
    'stockroom-reopen',
    'stockroom-corrections',
    'stockroom-corrections-resume',
    'stockroom-corrections-reopen',
    'arrival',
    'arrival-resume',
    'arrival-reopen',
    'arrival-components',
    'arrival-components-resume',
    'arrival-components-reopen',
    'lots',
    'lots-resume',
    'lots-reopen',
    'opening',
    'opening-resume',
    'opening-timer',
    'opening-timer-reopen',
    'opening-reopen',
    'benchling-apply',
    'benchling-apply-reopen',
    'benchling-apply-resume',
    'benchling-capture',
    'benchling-capture-reopen',
  ].includes(stage),
  'Choose a mapped inventory journey stage.'
);
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
const debugPort = Number(settings.DESKTOP_DEBUG_PORT);
assert.ok(rendererPort && debugPort, 'Configure explicit renderer and debug ports.');
const files = execFileSync(
  'git',
  [
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
    '--',
    ':(glob)**/*inventory*',
    'apps/desktop/src/features/inventory',
    'apps/desktop/src/features/scientific-document',
    'apps/desktop/src/components/ui/styles.ts',
    'apps/desktop/src/components/ui/controls.tsx',
    'apps/desktop/src/components/PortalMenu.tsx',
    'apps/desktop/src/presentation',
    'apps/desktop/src/App.tsx',
    'apps/desktop/src/components/ExplorerAddPicker.tsx',
    'apps/desktop/src/hooks/useWorkspaceArtifactActions.ts',
    'apps/desktop/src/main/native-protocol-packages.ts',
    ':(glob)apps/desktop/src/main/native-protocol-*',
    'apps/desktop/src/main/ipc/protocols.ts',
    'apps/desktop/src/shared/protocol-packages.ts',
    ':(glob)apps/desktop/src/shared/protocol-*',
    'apps/desktop/src/shared/protocol-client.ts',
    'apps/desktop/src/shared/protocol-command.ts',
    'apps/desktop/src/shared/ipc/protocols.contract.ts',
    'apps/desktop/src/shared/ipc/contracts.ts',
    'apps/desktop/src/services/protocol-package-changes.ts',
    'apps/desktop/src/features/agent-bridge/catalog/protocols.ts',
    'apps/desktop/src/features/ai/tools/protocol-document.ts',
    'apps/desktop/src/services/native-scientific-package-reconcile.ts',
    'packages/core/domain-services/src/protocol-package.ts',
    ':(glob)packages/core/domain-services/src/protocol-*',
    'packages/core/domain-services/src/protocol-document-structure.ts',
    'packages/core/domain-services/src/protocol-run-model.ts',
    'packages/core/domain-services/src/paper-protocol-model.ts',
    'apps/desktop/src/feature-registry',
    'apps/desktop/src/shared/activity-view.ts',
    'apps/desktop/src/main/features/native-documents.ts',
    'apps/desktop/src/main/native-document-command-server.ts',
    'apps/desktop/src/main/agent-grant-authority.ts',
    'apps/desktop/src/preload',
    'apps/desktop/src/platform',
    'apps/desktop/electron.vite.config.ts',
    'apps/api/src/native_workflow_tools.py',
    'packages/core/agent-tools/renderer-tool-manifest.json',
    'packages/core/domain-services/src/metadata-fields.ts',
    'packages/core/domain-services/src/index.ts',
    'packages/core/domain-services/package.json',
    'packages/core/scientific-objects/package.json',
    'packages/core/scientific-objects/src/unique-json.ts',
    'packages/core/scientific-objects/src/delimited-rows.ts',
    'apps/desktop/src/shared/delimited-rows.ts',
    'apps/desktop/src/shared/delimitedRows.ts',
    'apps/desktop/src/shared/native-document-transport.ts',
    'package.json',
    'pnpm-lock.yaml',
    'packages/core/domain-services/scripts',
    'packages/core/domain-services/src/inventory-label-glyphs.ts',
    'packages/core/scientific-artifacts/src/shared/lims.ts',
    'packages/core/scientific-artifacts/src/shared/entity-schema.ts',
    'apps/desktop/src/shared/components/entity-metadata',
    'apps/desktop/src/features/lims/components/registry/RegistrySchemaManager.tsx',
  ],
  {
    cwd: root,
    encoding: 'utf8',
  }
)
  .split('\0')
  .filter(Boolean);
const source = [...new Set(files)].sort().map((file) => ({
  file,
  sha256: createHash('sha256')
    .update(readFileSync(path.join(root, file)))
    .digest('hex'),
}));
const receipt = {
  schema: 'dnaforge.inventory-desktop-journey.v1',
  stage,
  status: 'running',
  startedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source,
  observations: [],
};
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
let page;
let recording;

async function startRecording() {
  const directory = path.join(out, 'original-frames');
  mkdirSync(directory, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames = [];
  session.on('Page.screencastFrame', (event) => {
    const file = path.join(directory, `${String(frames.length).padStart(6, '0')}.png`);
    writeFileSync(file, Buffer.from(event.data, 'base64'));
    frames.push({ file, timestamp: event.metadata.timestamp ?? Date.now() / 1000 });
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return { session, frames };
}

async function stopRecording() {
  if (!recording) return;
  await recording.session.send('Page.stopScreencast');
  await recording.session.detach();
  const frames = recording.frames;
  writeFileSync(path.join(out, 'original-frame-timestamps.json'), JSON.stringify(frames, null, 2));
  if (frames.length < 2) throw new Error('The interaction video did not capture enough frames.');
  const quote = (file) => file.replaceAll("'", "'\\''");
  const concat =
    frames
      .map((frame, index) => {
        const next = frames[index + 1];
        const duration = next ? Math.max(0.001, next.timestamp - frame.timestamp) : 1;
        return `file '${quote(frame.file)}'\nduration ${duration}\n`;
      })
      .join('') + `file '${quote(frames.at(-1).file)}'\n`;
  writeFileSync(path.join(out, 'frames.concat'), concat);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    path.join(out, 'frames.concat'),
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    path.join(out, 'inventory-journey.mp4'),
  ]);
  receipt.video = { file: 'inventory-journey.mp4', originalFrames: frames.length };
}

async function capture(name, value) {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  receipt.observations.push({ name, value });
  await page.waitForTimeout(500);
}

async function choose(scope, label, name) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function inventoryRead(scope) {
  return page.evaluate(async (input) => {
    const state = await window.electronAPI.inventory.inspect(input);
    const history = [];
    let afterRevision = 0;
    while (afterRevision < (state?.revision ?? 0)) {
      const entries = await window.electronAPI.inventory.history({
        ...input,
        afterRevision,
        limit: 1000,
      });
      const snapshotEntries = entries.filter((entry) => entry.receipt.revision <= state.revision);
      if (!snapshotEntries.length)
        throw new Error('Inventory history is incomplete for the captured revision.');
      for (const entry of snapshotEntries) {
        if (entry.receipt.revision !== afterRevision + 1)
          throw new Error('Inventory history has a missing or repeated revision.');
        history.push(entry);
        afterRevision = entry.receipt.revision;
      }
    }
    return { state, history };
  }, scope);
}

async function openInventory(projectName) {
  const banner = page.getByRole('button', { name: 'Not now', exact: true });
  if (await banner.isVisible()) await banner.click();
  await page.getByTestId('inventory-button').click();
  await page.getByTestId('inventory-panel').waitFor();
  await choose(page, 'Inventory project', projectName);
  await expect(page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}

try {
  page = browser
    .contexts()[0]
    .pages()
    .find((candidate) => {
      const url = new URL(candidate.url());
      return ['localhost', '127.0.0.1'].includes(url.hostname) && Number(url.port) === rendererPort;
    });
  assert.ok(page, 'The task renderer must be running on its configured port.');
  await page.waitForFunction(() => window.electronAPI?.runtime?.getProvenance);
  const runtime = await page.evaluate(async () => ({
    profile: window.electronAPI.runtime.getProfile(),
    provenance: await window.electronAPI.runtime.getProvenance(),
  }));
  assert.equal(runtime.profile.kind, 'scenario-e2e');
  assert.equal(path.resolve(runtime.provenance.projectRoot), root);
  receipt.runtime = runtime;
  if (stage === 'before') {
    await page.waitForFunction(() => window.__test?.setWorkspaceFoldersForTest);
    await expect(page.getByTestId('inventory-button')).toHaveCount(0);
    await page.screenshot({ path: path.join(out, 'before-inventory-workspace.png') });
    receipt.observations.push({ name: 'inventory activity absent', count: 0 });
  }
  if (stage === 'journey') {
    const projects = await page.evaluate(() => window.electronAPI.inventory.projects());
    const project = projects.find(
      (candidate) => candidate.name === 'My Project' && !candidate.pinned
    );
    assert.ok(project, 'Use the owned isolated profile’s writable My Project.');
    assert.ok(
      project.path.startsWith(`${runtime.provenance.userDataPath}/`),
      'The fixture project must belong to this isolated profile.'
    );
    const content = readFileSync(
      path.join(root, 'test-fixtures/sequences/circular/pUC19.gb'),
      'utf8'
    );
    const imported = await page.evaluate(
      async (input) => {
        const { platform } = await import('/src/platform/index.ts');
        return platform().workspace.registerImportedSequenceFromContent(input);
      },
      { content, fileName: 'inventory-acceptance-pUC19.gb', targetRoot: project.path }
    );
    assert.equal(imported.registered, true, JSON.stringify(imported));
    const materialId = imported.entityIds[0];
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === materialId);
    assert.ok(material, 'The native material picker must admit the imported scientific record.');
    const scope = { project: project.projectId, inventoryId: project.defaultInventoryId };
    assert.equal((await inventoryRead(scope)).state, null, 'Use a fresh inventory fixture.');
    receipt.fixture = {
      project,
      material,
      imported,
      sourceSha256: createHash('sha256').update(content).digest('hex'),
    };
    recording = await startRecording();
    await openInventory(project.name);
    await capture('01-empty-inventory', await page.getByTestId('inventory-panel').innerText());

    async function addLocation(name, positions, parent) {
      await page.getByRole('button', { name: 'Add location', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add location', exact: true });
      await dialog.getByLabel('Location name', { exact: true }).fill(name);
      await dialog.getByLabel('Position names', { exact: true }).fill(positions);
      if (parent) await choose(dialog, 'Location', parent);
      await dialog.getByRole('button', { name: 'Add location', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await addLocation('Freezer acceptance', 'Shelf 1');
    await addLocation('Box acceptance', 'A1, A2', 'Freezer acceptance');
    const hierarchy = await inventoryRead(scope);
    const box = Object.values(hierarchy.state.storage).find(
      (item) => item.name === 'Box acceptance'
    );
    assert.ok(box);
    await page.getByRole('treeitem').filter({ hasText: 'Box acceptance' }).click();
    await expect(page.getByTestId('inventory-positions')).toBeVisible();
    await capture('02-hierarchy', hierarchy);

    await page
      .getByTestId('inventory-panel')
      .locator('header')
      .getByRole('button', { name: 'Receive stock', exact: true })
      .click();
    const receive = page.getByRole('dialog', { name: 'Receive stock', exact: true });
    await receive.getByLabel('Find material', { exact: true }).fill(materialId);
    await choose(
      receive,
      'Material',
      new RegExp(material.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    await receive.getByLabel('Container name', { exact: true }).fill('Tube acceptance');
    await choose(receive, 'Location', 'Freezer acceptance / Shelf 1 / Box acceptance');
    await choose(receive, 'Position', 'A1');
    await receive.getByLabel('Quantity', { exact: true }).fill('100');
    await capture('03-receive-form', { quantity: '100', unit: 'uL', position: 'A1' });
    await receive.getByRole('button', { name: 'Receive stock', exact: true }).click();
    await expect(receive).toBeHidden();
    const received = await inventoryRead(scope);
    const stock = Object.values(received.state.stocks).find(
      (item) => item.materialId === materialId
    );
    assert.ok(stock);
    assert.deepEqual(stock.quantity, { kind: 'known', value: '100', unit: 'uL' });
    assert.deepEqual(received.state.vessels[stock.vesselId].placement, {
      kind: 'located',
      storageId: box.id,
      slotId: 'A1',
    });
    await capture('04-received', received);

    const row = page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stock.id}"]`);
    await row.click();
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    const move = page.getByRole('dialog', { name: 'Move container', exact: true });
    await choose(move, 'Location', 'Freezer acceptance / Shelf 1 / Box acceptance');
    await choose(move, 'Position', 'A2');
    await move.getByRole('button', { name: 'Move container', exact: true }).click();
    await expect(move).toBeHidden();
    assert.deepEqual((await inventoryRead(scope)).state.vessels[stock.vesselId].placement, {
      kind: 'located',
      storageId: box.id,
      slotId: 'A2',
    });
    await capture('05-moved', await inventoryRead(scope));

    await page.getByRole('button', { name: 'Use stock', exact: true }).click();
    const use = page.getByRole('dialog', { name: 'Use stock', exact: true });
    await use.getByLabel('Quantity', { exact: true }).fill('20');
    await use.getByLabel('Reason', { exact: true }).fill('Inventory acceptance experiment');
    await capture('06-use-form', { quantity: '20', unit: 'uL' });
    await use.getByRole('button', { name: 'Use stock', exact: true }).click();
    await expect(use).toBeHidden();
    const used = await inventoryRead(scope);
    assert.deepEqual(used.state.stocks[stock.id].quantity, {
      kind: 'known',
      value: '80',
      unit: 'uL',
    });
    assert.equal(
      used.history
        .flatMap((entry) => entry.request.commands)
        .filter((command) => command.kind === 'consume').length,
      1
    );
    await expect(row).toContainText('80 µL');
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText('Used 20 µL');
    await capture('07-used-history', used);
    receipt.expected = {
      scope,
      stockId: stock.id,
      vesselId: stock.vesselId,
      boxId: box.id,
      state: used.state,
      history: used.history,
    };
    writeFileSync(
      path.join(out, 'reopen-fixture.json'),
      JSON.stringify({ project, ...receipt.expected }, null, 2)
    );
  }
  if (stage === 'materials') {
    assert.ok(args.includes('--fixture'), 'Pass the earlier native journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    const { project, scope } = fixture;
    assert.ok(
      project.path.startsWith(`${runtime.provenance.userDataPath}/`),
      'Use the original isolated profile.'
    );
    const initial = await inventoryRead(scope);
    assert.equal(initial.state.stocks[fixture.stockId].quantity.value, '80');
    const materialId = initial.state.stocks[fixture.stockId].materialId;
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === materialId);
    assert.ok(material);
    receipt.fixture = { project, material, initial };
    recording = await startRecording();
    await openInventory(project.name);
    await capture('01-before-material-operations', initial);
    let readback = initial;
    let lot = Object.values(initial.state.lots).find(
      (item) => item.name === 'Supplier lot acceptance'
    );
    let stock = Object.values(initial.state.stocks).find(
      (item) => item.source.kind === 'lot' && item.source.lotId === lot?.id
    );
    let aliquot = Object.values(initial.state.stocks).find(
      (item) => initial.state.vessels[item.vesselId].name === 'Aliquot acceptance'
    );
    const poolBefore = Object.values(initial.state.lots).find(
      (item) => item.name === 'Pooled acceptance'
    );
    let pooled = Object.values(initial.state.stocks).find(
      (item) => item.source.kind === 'lot' && item.source.lotId === poolBefore?.id
    );
    let dialog;
    const row = (id) =>
      page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`);
    if (args.includes('--resume')) {
      assert.ok(
        lot && stock && aliquot && pooled,
        'Resume only after the captured successful pooling checkpoint.'
      );
      assert.equal(initial.state.stocks[stock.id].quantity.value, '65');
      assert.equal(initial.state.stocks[aliquot.id].quantity.value, '15');
      assert.equal(initial.state.stocks[pooled.id].quantity.value, '20');
    } else {
      await page.getByRole('button', { name: 'Add lot', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Add lot or preparation', exact: true });
      await dialog.getByLabel('Batch name', { exact: true }).fill('Supplier lot acceptance');
      await dialog.getByLabel('Find output material', { exact: true }).fill(materialId);
      await choose(dialog, 'Output material', new RegExp(material.name));
      await dialog.getByLabel('Supplier', { exact: true }).fill('Synthetic supplier');
      await dialog.getByLabel('Supplier lot number', { exact: true }).fill('ACCEPTANCE-123');
      await dialog
        .getByLabel('Reason', { exact: true })
        .fill('Start managing the synthetic supplier lot');
      await dialog.getByRole('button', { name: 'Add lot or preparation', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      lot = Object.values(readback.state.lots).find(
        (item) => item.name === 'Supplier lot acceptance'
      );
      assert.ok(lot);
      await releaseInventoryJourneyLot({ page, expect, choose }, lot.name);
      await page
        .getByTestId('inventory-panel')
        .locator('header')
        .getByRole('button', { name: 'Receive stock', exact: true })
        .click();
      dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
      await dialog.getByLabel('Find material', { exact: true }).fill(materialId);
      await choose(dialog, 'Material', new RegExp(material.name));
      await choose(dialog, 'Lot or preparation', 'Supplier lot acceptance');
      await dialog.getByLabel('Container name', { exact: true }).fill('Supplier tube acceptance');
      await dialog.getByLabel('Quantity', { exact: true }).fill('100');
      await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      stock = Object.values(readback.state.stocks).find(
        (item) => item.source.kind === 'lot' && item.source.lotId === lot.id
      );
      assert.ok(stock);

      await row(stock.id).click();
      await page.getByRole('button', { name: 'Container limits', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Container limits', exact: true });
      await dialog.getByLabel('Capacity (µL)', { exact: true }).fill('200');
      await dialog.getByLabel('Dead volume (µL)', { exact: true }).fill('10');
      await dialog
        .getByLabel('Reason', { exact: true })
        .fill('Verified synthetic container specification');
      await dialog.getByRole('button', { name: 'Container limits', exact: true }).click();
      await expect(dialog).toBeHidden();
      await capture('02-received-lot-and-limits', await inventoryRead(scope));
      await page.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Transfer or aliquot', exact: true });
      await dialog.getByLabel('Source amount (µL)', { exact: true }).fill('20');
      await dialog
        .getByLabel('Destination container name', { exact: true })
        .fill('Aliquot acceptance');
      await dialog.getByLabel('Reason', { exact: true }).fill('Prepare working aliquot');
      await dialog.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      aliquot = Object.values(readback.state.stocks).find(
        (item) => readback.state.vessels[item.vesselId].name === 'Aliquot acceptance'
      );
      assert.ok(aliquot);
      assert.equal(readback.state.stocks[stock.id].quantity.value, '80');
      assert.equal(aliquot.quantity.value, '20');
      assert.deepEqual(aliquot.source, stock.source);
      await capture('03-aliquot-conserved', readback);
      await row(aliquot.id).click();
      await page.getByRole('button', { name: 'Pool stocks', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Pool stocks', exact: true });
      await dialog.getByLabel('Source amount (µL)', { exact: true }).fill('5');
      await choose(dialog, 'Second stock', /^Supplier tube acceptance/);
      await dialog.getByLabel('Second amount (µL)', { exact: true }).fill('15');
      await dialog.getByLabel('Output batch name', { exact: true }).fill('Pooled acceptance');
      await dialog.getByLabel('Find output material', { exact: true }).fill(materialId);
      await choose(dialog, 'Output material', new RegExp(material.name));
      await dialog
        .getByLabel('Destination container name', { exact: true })
        .fill('Pooled tube acceptance');
      await dialog.getByLabel('Reason', { exact: true }).fill('Pool working preparations');
      await dialog.getByRole('button', { name: 'Pool stocks', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      const pooledLot = Object.values(readback.state.lots).find(
        (item) => item.name === 'Pooled acceptance'
      );
      pooled = Object.values(readback.state.stocks).find(
        (item) => item.source.kind === 'lot' && item.source.lotId === pooledLot?.id
      );
      assert.ok(pooled);
      assert.equal(pooled.quantity.value, '20');
      assert.equal(readback.state.stocks[stock.id].quantity.value, '65');
      assert.equal(readback.state.stocks[aliquot.id].quantity.value, '15');
      assert.equal(pooledLot.origin.inputs.length, 2);
      await capture('04-pooled-conserved', readback);
    }
    const water = await page.evaluate(async () => {
      const { platform } = await import('/src/platform/index.ts');
      await platform().lims.defineSchema({
        kind: 'entity',
        name: 'inventory-buffer-acceptance',
        displayName: 'Inventory buffer acceptance',
        fields: [{ key: 'description', label: 'Description', type: 'text' }],
      });
      return platform().lims.registerEntity({
        kind: 'inventory-buffer-acceptance',
        name: 'Water acceptance',
        fields: { description: 'Synthetic water inventory acceptance fixture' },
      });
    });
    const waterPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: water.id, limit: 100 }
    );
    assert.ok(
      waterPage.items.some((item) => item.id === water.id),
      'The tracked diluent fixture must be a real admitted material.'
    );
    await page
      .getByTestId('inventory-panel')
      .locator('header')
      .getByRole('button', { name: 'Receive stock', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
    await dialog.getByLabel('Find material', { exact: true }).fill(water.id);
    await choose(dialog, 'Material', /^Water acceptance/);
    await dialog.getByLabel('Container name', { exact: true }).fill('Water tube acceptance');
    await dialog.getByLabel('Quantity', { exact: true }).fill('100');
    await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
    await expect(dialog).toBeHidden();
    const currentPool = (await inventoryRead(scope)).state.lots[pooled.source.lotId];
    if (
      currentPool.controls.kind === 'managed' &&
      currentPool.controls.assessment.value === 'unassessed'
    )
      await releaseInventoryJourneyLot({ page, expect, choose }, currentPool.name);
    await row(pooled.id).click();
    await page.getByRole('button', { name: 'Dilute stock', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Dilute stock', exact: true });
    await dialog.getByLabel('Sample amount (µL)', { exact: true }).fill('10');
    await choose(dialog, 'Tracked diluent', /^Water tube acceptance/);
    await dialog.getByLabel('Diluent amount (µL)', { exact: true }).fill('30');
    await dialog.getByLabel('Output batch name', { exact: true }).fill('Diluted acceptance');
    await dialog.getByLabel('Find output material', { exact: true }).fill(materialId);
    await choose(dialog, 'Output material', new RegExp(material.name));
    await dialog
      .getByLabel('Destination container name', { exact: true })
      .fill('Diluted tube acceptance');
    await dialog.getByLabel('Reason', { exact: true }).fill('Prepare diluted working solution');
    await dialog.getByRole('button', { name: 'Dilute stock', exact: true }).click();
    await expect(dialog).toBeHidden();
    readback = await inventoryRead(scope);
    const dilutedLot = Object.values(readback.state.lots).find(
      (item) => item.name === 'Diluted acceptance'
    );
    const diluted = Object.values(readback.state.stocks).find(
      (item) => item.source.kind === 'lot' && item.source.lotId === dilutedLot?.id
    );
    assert.ok(diluted);
    assert.equal(diluted.quantity.value, '40');
    assert.equal(readback.state.stocks[pooled.id].quantity.value, '10');
    const waterStock = Object.values(readback.state.stocks).find(
      (item) => item.materialId === water.id
    );
    assert.equal(waterStock.quantity.value, '70');
    assert.equal(dilutedLot.origin.sample.quantity.value, '10');
    assert.equal(dilutedLot.origin.diluent.quantity.value, '30');
    await row(diluted.id).click();
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText(
      'Diluted stock into Diluted acceptance'
    );
    await capture('05-diluted-conserved-and-history', readback);
    receipt.expected = {
      state: readback.state,
      history: readback.history,
      water,
      lotId: lot.id,
      stockId: stock.id,
      aliquotId: aliquot.id,
      pooledId: pooled.id,
      dilutedId: diluted.id,
    };
    writeFileSync(
      path.join(out, 'material-reopen-fixture.json'),
      JSON.stringify({ project, scope, ...receipt.expected }, null, 2)
    );
  }

  if (['arrival-evidence-text', 'arrival-evidence-text-resume'].includes(stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact completed PDF fixture or text checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    const previous = page.getByRole('dialog', { name: 'Receive delivery', exact: true });
    if (await previous.isVisible())
      await previous.getByRole('button', { name: 'Cancel', exact: true }).click();
    if (stage === 'arrival-evidence-text-resume') {
      const existing = page.getByTestId('inventory-physical-dialog');
      for (let attempt = 0; attempt < 3 && (await existing.count()); attempt++)
        await page.keyboard.press('Escape');
      await expect(existing).toBeHidden();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'arrival-evidence-text'
        ? runInventoryArrivalEvidenceTextJourney
        : runInventoryArrivalEvidenceTextResume
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (['arrival-evidence', 'arrival-evidence-resume', 'arrival-evidence-reopen'].includes(stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact native22 fixture or PDF evidence checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (stage === 'arrival-evidence-resume') {
      const existing = page.getByTestId('inventory-physical-dialog');
      for (let attempt = 0; attempt < 3 && (await existing.count()); attempt++)
        await page.keyboard.press('Escape');
      await expect(existing).toBeHidden();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'arrival-evidence'
        ? runInventoryArrivalEvidenceJourney
        : stage === 'arrival-evidence-resume'
          ? runInventoryArrivalEvidenceResume
          : runInventoryArrivalEvidenceReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (
    [
      'stockroom-corrections',
      'stockroom-corrections-resume',
      'stockroom-corrections-reopen',
    ].includes(stage)
  ) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact text-evidence fixture or correction checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (stage === 'stockroom-corrections-resume') {
      const existing = page.getByTestId('inventory-physical-dialog');
      for (let attempt = 0; attempt < 3 && (await existing.count()); attempt++)
        await page.keyboard.press('Escape');
      await expect(existing).toBeHidden();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'stockroom-corrections'
        ? runInventoryStockroomCorrectionsJourney
        : stage === 'stockroom-corrections-resume'
          ? runInventoryStockroomCorrectionsResume
          : runInventoryStockroomCorrectionsReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (Object.hasOwn(runValueAttributionStages, stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact typed-value or attribution checkpoint fixture.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    receipt.expected = await runValueAttributionStages[stage]({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
  }
  if (Object.hasOwn(runValueStages, stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact completed manual-plan inventory fixture or typed value checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    receipt.expected = await runValueStages[stage]({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
  }
  if (Object.hasOwn(platePlanObservationStages, stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact post-plan inventory fixture or manual observation checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (await page.getByRole('option').count()) await page.keyboard.press('Escape');
    const report = page.getByTestId('plate-plan-observation-form');
    if (await report.isVisible())
      await report.getByRole('button', { name: 'Close manual report', exact: true }).click();
    const plans = page.getByTestId('inventory-plate-plans');
    if (await plans.isVisible())
      await plans.getByRole('button', { name: 'Close plate plans', exact: true }).click();
    await openInventory(fixture.project.name);
    receipt.expected = await platePlanObservationStages[stage]({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
  }
  if (Object.hasOwn(platePlanStages, stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact current inventory fixture or plate-plan checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    const existing = page.getByTestId('inventory-plate-plans');
    if (await existing.isVisible()) {
      if (await page.getByRole('option').count()) await page.keyboard.press('Escape');
      await existing.getByRole('button', { name: 'Close plate plans', exact: true }).click();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await platePlanStages[stage]({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
      nativeDialogs: args.includes('--native-dialogs'),
    });
  }
  if (Object.hasOwn(citationStages, stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact existing Run work fixture or citation checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    receipt.expected = await citationStages[stage]({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
  }
  if (Object.hasOwn(recordedWorkStages, stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact completed Protocol Run revision93 fixture.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    receipt.expected = await recordedWorkStages[stage]({
      page,
      expect,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
  }
  if (['protocol-run', 'protocol-run-resume', 'protocol-run-reopen'].includes(stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass an exact currentv24 fixture or Protocol Run checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'protocol-run'
        ? runInventoryProtocolRunJourney
        : stage === 'protocol-run-resume'
          ? runInventoryProtocolRunResume
          : runInventoryProtocolRunReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (
    [
      'scientific',
      'scientific-resume',
      'scientific-reopen',
      'scientific-source-edit',
      'scientific-source-edit-resume',
    ].includes(stage)
  ) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact current native23 fixture or scientific checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (stage === 'scientific-resume' || stage === 'scientific-source-edit-resume') {
      const existing = page.getByTestId('inventory-physical-dialog');
      for (let attempt = 0; attempt < 3 && (await existing.count()); attempt++)
        await page.keyboard.press('Escape');
      await expect(existing).toBeHidden();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'scientific'
        ? runInventoryScientificJourney
        : stage === 'scientific-resume'
          ? runInventoryScientificResume
          : stage === 'scientific-source-edit'
            ? runInventoryScientificSourceEdit
            : stage === 'scientific-source-edit-resume'
              ? runInventoryScientificSourceEditResume
              : runInventoryScientificReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (['stockroom', 'stockroom-resume', 'stockroom-reopen'].includes(stage)) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact native22 arrival fixture or stockroom checkpoint.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (stage === 'stockroom-resume') {
      const existing = page.getByTestId('inventory-physical-dialog');
      for (let attempt = 0; attempt < 3 && (await existing.count()); attempt++)
        await page.keyboard.press('Escape');
      await expect(existing).toBeHidden();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'stockroom'
        ? runInventoryStockroomJourney
        : stage === 'stockroom-resume'
          ? runInventoryStockroomResume
          : runInventoryStockroomReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (stage === 'arrival' || stage === 'arrival-resume' || stage === 'arrival-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass an exact native21 inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (stage === 'arrival-resume') {
      const existing = page.getByTestId('inventory-physical-dialog');
      for (let attempt = 0; attempt < 3 && (await existing.count()); attempt++)
        await page.keyboard.press('Escape');
      await expect(existing).toBeHidden();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'arrival'
        ? runInventoryArrivalJourney
        : stage === 'arrival-resume'
          ? runInventoryArrivalResume
          : runInventoryArrivalReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
    writeFileSync(
      path.join(out, 'arrival-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (
    ['arrival-components', 'arrival-components-resume', 'arrival-components-reopen'].includes(stage)
  ) {
    assert.ok(
      args.includes('--fixture'),
      'Pass the exact completed first arrival or component checkpoint fixture.'
    );
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (stage === 'arrival-components-resume') {
      const existing = page.getByTestId('inventory-physical-dialog');
      for (let attempt = 0; attempt < 3 && (await existing.count()); attempt++)
        await page.keyboard.press('Escape');
      await expect(existing).toBeHidden();
    }
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'arrival-components'
        ? runInventoryArrivalComponents
        : stage === 'arrival-components-resume'
          ? runInventoryArrivalComponentsResume
          : runInventoryArrivalComponentsReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (stage === 'opening' || stage === 'opening-resume' || stage === 'opening-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass an exact native v20 fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'opening'
        ? runInventoryOpeningJourney
        : stage === 'opening-resume'
          ? runInventoryOpeningResume
          : runInventoryOpeningReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
    writeFileSync(
      path.join(out, 'opening-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'opening-timer' || stage === 'opening-timer-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the exact completed opening or timer fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'opening-timer' ? runInventoryOpeningTimer : runInventoryOpeningTimerReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
  }
  if (stage === 'lots' || stage === 'lots-resume' || stage === 'lots-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass an exact current native v19 inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'lots'
        ? runInventoryLotJourney
        : stage === 'lots-resume'
          ? runInventoryLotResume
          : runInventoryLotReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
    writeFileSync(
      path.join(out, 'lot-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'refresh-fixture') {
    assert.ok(args.includes('--fixture'), 'Pass the original project/scope/state/history fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    assert.ok(fixture.state && Array.isArray(fixture.history));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const actual = await inventoryRead(fixture.scope);
    assert.equal(actual.state.revision, fixture.state.revision);
    assert.deepEqual(
      actual.history,
      fixture.history,
      'Refresh cannot accept any new inventory intent.'
    );
    receipt.expected = { ...fixture, ...actual };
    writeFileSync(
      path.join(out, 'inventory-current-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
    await capture('refreshed-current-native-fixture', {
      previousSchema: fixture.state.schema,
      currentSchema: actual.state.schema,
      ...actual,
    });
  }
  if (stage === 'amounts' || stage === 'amounts-resume' || stage === 'amounts-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass an exact current native inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'amounts'
        ? runInventoryAmountsJourney
        : stage === 'amounts-resume'
          ? runInventoryAmountsResume
          : runInventoryAmountsReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
    writeFileSync(
      path.join(out, 'amounts-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }

  if (stage === 'contents' || stage === 'contents-reopen' || stage === 'contents-resume') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'contents'
        ? runInventoryContentsJourney
        : stage === 'contents-resume'
          ? runInventoryContentsResume
          : runInventoryContentsReopen
    )({ page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory: out });
    writeFileSync(
      path.join(out, 'contents-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (
    stage === 'benchling-apply' ||
    stage === 'benchling-apply-resume' ||
    stage === 'benchling-apply-reopen'
  ) {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await (
      stage === 'benchling-apply'
        ? runInventoryBenchlingApplicationJourney
        : stage === 'benchling-apply-resume'
          ? runInventoryBenchlingApplicationResume
          : runInventoryBenchlingApplicationReopen
    )({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
      projectRoot: root,
    });
    writeFileSync(
      path.join(out, 'benchling-application-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'benchling-capture' || stage === 'benchling-capture-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await runInventoryBenchlingCaptureJourney({
      page,
      expect,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
      projectRoot: root,
      userDataPath: runtime.provenance.userDataPath,
    });
    writeFileSync(
      path.join(out, 'benchling-capture-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'mapped-table' || stage === 'mapped-resume' || stage === 'mapped-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run =
      stage === 'mapped-table'
        ? runInventoryMappedJourney
        : stage === 'mapped-resume'
          ? runInventoryMappedResume
          : runInventoryMappedReopen;
    receipt.expected = await run({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
      projectRoot: root,
    });
    writeFileSync(
      path.join(out, 'mapped-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'hierarchy' || stage === 'hierarchy-reopen' || stage === 'hierarchy-resume') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run =
      stage === 'hierarchy'
        ? runInventoryHierarchyJourney
        : stage === 'hierarchy-resume'
          ? runInventoryHierarchyResume
          : runInventoryHierarchyReopen;
    receipt.expected = await run({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
    writeFileSync(
      path.join(out, 'hierarchy-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'source-revision' || stage === 'source-revision-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run =
      stage === 'source-revision'
        ? runInventorySourceRevisionJourney
        : runInventorySourceRevisionReopen;
    receipt.expected = await run({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
    writeFileSync(
      path.join(out, 'source-revision-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'stocktake' || stage === 'stocktake-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run = stage === 'stocktake' ? runInventoryStocktakeJourney : runInventoryStocktakeReopen;
    receipt.expected = await run({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
    writeFileSync(
      path.join(out, 'stocktake-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'table-receive' || stage === 'table-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run = stage === 'table-receive' ? runInventoryTableJourney : runInventoryTableReopen;
    receipt.expected = await run({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
    });
    writeFileSync(
      path.join(out, 'table-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'archive-preview' || stage === 'archive-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the current owned inventory fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run =
      stage === 'archive-preview' ? runInventoryPortabilityJourney : runInventoryPortabilityReopen;
    receipt.expected = await run({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
      projectRoot: root,
      userDataPath: runtime.provenance.userDataPath,
    });
    writeFileSync(
      path.join(out, 'archive-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (
    stage === 'conditions' ||
    stage === 'conditions-reopen' ||
    stage === 'thermal-context' ||
    stage === 'conditions-catalog-recover'
  ) {
    assert.ok(args.includes('--fixture'), 'Pass the current inventory journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    if (stage === 'conditions-catalog-recover') {
      const preview = page.getByRole('dialog', { name: 'Catalog update preview', exact: true });
      if (await preview.isVisible())
        await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
      const setup = page.getByRole('dialog', { name: 'Inventory setup', exact: true });
      if (await setup.isVisible())
        await setup.getByRole('button', { name: 'Close', exact: true }).click();
    }
    await openInventory(fixture.project.name);
    const run =
      stage === 'conditions-catalog-recover'
        ? runInventoryTemperatureCatalogRecovery
        : stage === 'thermal-context'
          ? runInventoryThermalContextJourney
          : stage === 'conditions'
            ? runInventoryConditionsJourney
            : runInventoryConditionsReopen;
    receipt.expected = await run({ page, expect, choose, inventoryRead, capture, fixture });
    writeFileSync(
      path.join(out, 'conditions-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'labels' || stage === 'labels-preview' || stage === 'label-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the physical item-code journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run = stage === 'label-reopen' ? runInventoryLabelReopen : runInventoryLabelJourney;
    receipt.expected = await run({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
      evidenceDirectory: out,
      nativeDialogs: stage !== 'labels-preview',
    });
    writeFileSync(
      path.join(out, 'label-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'item-codes' || stage === 'item-code-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the earlier inventory journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run = stage === 'item-codes' ? runInventoryItemCodeJourney : runInventoryItemCodeReopen;
    receipt.expected = await run({ page, expect, choose, inventoryRead, capture, fixture });
    writeFileSync(
      path.join(out, 'item-code-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'catalog' || stage === 'catalog-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the configuration journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run = stage === 'catalog' ? runInventoryCatalogJourney : runInventoryCatalogReopen;
    receipt.expected = await run({ page, expect, choose, inventoryRead, capture, fixture });
    writeFileSync(
      path.join(out, 'catalog-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'configuration' || stage === 'configuration-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the inventory journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run =
      stage === 'configuration'
        ? runInventoryConfigurationJourney
        : runInventoryConfigurationReopen;
    receipt.expected = await run({ page, expect, choose, inventoryRead, capture, fixture });
    writeFileSync(
      path.join(out, 'configuration-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'custody' || stage === 'custody-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the inventory journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run = stage === 'custody' ? runInventoryCustodyJourney : runInventoryCustodyReopen;
    receipt.expected = await run({ page, expect, choose, inventoryRead, capture, fixture });
    writeFileSync(
      path.join(out, 'custody-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'reservations' || stage === 'reservation-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the inventory journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const run =
      stage === 'reservations' ? runInventoryReservationJourney : runInventoryReservationReopen;
    receipt.expected = await run({ page, expect, choose, inventoryRead, capture, fixture });
    writeFileSync(
      path.join(out, 'reservation-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'composition') {
    assert.ok(args.includes('--fixture'), 'Pass the material journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await runInventoryCompositionJourney({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
    });
    writeFileSync(
      path.join(out, 'composition-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'composition-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the completed composition fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const after = await inventoryRead(fixture.scope);
    assert.deepEqual(after.state, fixture.state);
    assert.deepEqual(after.history, fixture.history);
    await page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${fixture.stockId}"]`)
      .click();
    await expect(page.getByTestId('inventory-stock-composition')).toContainText('1/3 ng/µL');
    await expect(page.getByTestId('inventory-lot-contributions')).toContainText('1 ng/µL');
    await capture('05-reopened-exact-composition-and-input-history', after);
  }
  if (stage === 'layouts') {
    assert.ok(args.includes('--fixture'), 'Pass the workspace journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    const { project, scope } = fixture;
    assert.ok(project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    const initial = await inventoryRead(scope);
    const materialId = initial.state.stocks[fixture.stockId].materialId;
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === materialId);
    assert.ok(material);
    recording = await startRecording();
    await openInventory(project.name);
    async function addLayout(name, kind) {
      await page.getByRole('button', { name: 'Add location', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add location', exact: true });
      await dialog.getByLabel('Location name', { exact: true }).fill(name);
      await choose(dialog, 'Position layout', kind);
      if (kind === 'Ordered stack')
        await dialog.getByLabel('Stack capacity', { exact: true }).fill('2');
      else {
        await dialog.getByLabel('Rows', { exact: true }).fill('2');
        await dialog.getByLabel('Columns', { exact: true }).fill('3');
      }
      await choose(dialog, 'Location', 'Top level');
      await dialog.getByRole('button', { name: 'Add location', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await addLayout('Plate stack acceptance', 'Ordered stack');
    await addLayout('Well plate acceptance', 'Well plate');
    await addLayout('Top plate acceptance', 'Well plate');
    await addLayout('Tube box acceptance', 'Tube box');
    let readback = await inventoryRead(scope);
    const named = (name) =>
      Object.values(readback.state.storage).find((item) => item.name === name);
    const plate = named('Well plate acceptance');
    const top = named('Top plate acceptance');
    const stack = named('Plate stack acceptance');
    const box = named('Tube box acceptance');
    assert.ok(plate && top && stack && box);
    const wells = Object.values(readback.state.vessels).filter(
      (item) => item.kind === 'fixed-well' && item.placement.storageId === plate.id
    );
    assert.equal(wells.length, 6);
    await page.getByRole('treeitem').filter({ hasText: 'Well plate acceptance' }).click();
    await expect(page.getByTestId('inventory-positions').locator('[data-position-id]')).toHaveCount(
      6
    );
    await capture('01-permanent-six-well-plate', readback);
    await page.getByTestId('inventory-positions').locator('[data-position-id="A1"]').click();
    await page
      .getByTestId('inventory-detail-drawer')
      .getByRole('button', { name: 'Receive stock', exact: true })
      .click();
    let dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
    await dialog.getByLabel('Find material', { exact: true }).fill(materialId);
    await choose(dialog, 'Material', new RegExp(material.name));
    await dialog.getByLabel('Quantity', { exact: true }).fill('25');
    await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
    await expect(dialog).toBeHidden();
    readback = await inventoryRead(scope);
    const well = wells.find((item) => item.placement.slotId === 'A1');
    const stock = Object.values(readback.state.stocks).find((item) => item.vesselId === well.id);
    assert.ok(stock);
    await page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${stock.id}"]`)
      .click();
    await expect(
      page.getByTestId('inventory-detail-drawer').getByRole('button', { name: 'Move', exact: true })
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId('inventory-detail-drawer')
        .getByRole('button', { name: 'Dispose container', exact: true })
    ).toHaveCount(0);
    await expect(page.getByTestId('inventory-detail-drawer')).toContainText(
      'This well moves with its plate'
    );
    await capture('02-fixed-well-stock-and-actions', readback);
    await page.getByRole('button', { name: 'Close stock details', exact: true }).click();
    async function moveIntoStack(name) {
      await page.getByRole('treeitem').filter({ hasText: name }).click();
      await page.getByRole('button', { name: 'Move location', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Move location', exact: true });
      await choose(dialog, 'Location', 'Plate stack acceptance');
      await dialog.getByRole('button', { name: 'Move location', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await moveIntoStack('Well plate acceptance');
    await moveIntoStack('Top plate acceptance');
    readback = await inventoryRead(scope);
    assert.deepEqual(readback.state.vessels[well.id].placement, well.placement);
    assert.deepEqual(readback.state.storage[plate.id].placement, {
      kind: 'located',
      storageId: stack.id,
      slotId: '1',
    });
    assert.deepEqual(readback.state.storage[top.id].placement, {
      kind: 'located',
      storageId: stack.id,
      slotId: '2',
    });
    await page.getByRole('treeitem').filter({ hasText: 'Plate stack acceptance' }).first().click();
    await capture('03-ordered-two-plate-stack', readback);
    await page.getByRole('treeitem').filter({ hasText: 'Well plate acceptance' }).click();
    await page.getByRole('button', { name: 'Move location', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Move location', exact: true });
    await choose(dialog, 'Location', 'Top level');
    await dialog.getByRole('button', { name: 'Move location', exact: true }).click();
    await expect(dialog.getByTestId('inventory-refused')).toContainText('top item');
    assert.deepEqual(await inventoryRead(scope), readback);
    await capture('04-buried-plate-removal-refused', await dialog.innerText());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByTestId('inventory-refused')
      .getByRole('button', { name: 'Edit change', exact: true })
      .click();
    await page.getByRole('treeitem').filter({ hasText: 'Top plate acceptance' }).click();
    await page.getByRole('button', { name: 'Move location', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Move location', exact: true });
    await choose(dialog, 'Location', 'Top level');
    await dialog.getByRole('button', { name: 'Move location', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('treeitem').filter({ hasText: 'Well plate acceptance' }).click();
    await page.getByRole('button', { name: 'Dispose plate', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Dispose', exact: true });
    await dialog.getByLabel('Reason', { exact: true }).fill('Dispose completed acceptance plate');
    await dialog.getByRole('button', { name: 'Dispose', exact: true }).click();
    await expect(dialog).toBeHidden();
    readback = await inventoryRead(scope);
    assert.equal(readback.state.storage[plate.id].lifecycle, 'disposed');
    for (const old of wells) assert.equal(readback.state.vessels[old.id].lifecycle, 'disposed');
    assert.equal(readback.state.stocks[stock.id].quantity.value, '25');
    await page.getByRole('button', { name: 'Disposed', exact: true }).click();
    await expect(
      page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stock.id}"]`)
    ).toContainText('25 µL');
    await capture('05-aggregate-disposal-retains-history', readback);
    receipt.expected = {
      state: readback.state,
      history: readback.history,
      plateId: plate.id,
      stockId: stock.id,
      wellIds: wells.map((item) => item.id),
      stackId: stack.id,
    };
  }

  if (stage === 'lineage') {
    assert.ok(args.includes('--fixture'), 'Pass the material workflow fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    const { project, scope } = fixture;
    assert.ok(project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    const before = await inventoryRead(scope);
    const source = before.state.stocks[fixture.stockId];
    const aliquot = before.state.stocks[fixture.aliquotId];
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: source.materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === source.materialId);
    assert.ok(material);
    recording = await startRecording();
    await openInventory(project.name);
    const row = (id) =>
      page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`);
    await row(source.id).click();
    await page.getByRole('button', { name: 'Record preparation', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Add lot or preparation', exact: true });
    await dialog.getByLabel('Batch name', { exact: true }).fill('Preparation acceptance');
    await dialog.getByLabel('Find output material', { exact: true }).fill(source.materialId);
    await choose(dialog, 'Output material', new RegExp(material.name));
    await choose(dialog, 'Batch origin', 'Internal preparation');
    await dialog
      .getByLabel('Preparation method', { exact: true })
      .fill('Synthetic preparation with a recorded source identity');
    await dialog
      .getByLabel('Reason', { exact: true })
      .fill('Start managing the synthetic preparation');
    await dialog.getByRole('button', { name: 'Add lot or preparation', exact: true }).click();
    await expect(dialog).toBeHidden();
    let after = await inventoryRead(scope);
    const preparation = Object.values(after.state.lots).find(
      (lot) => lot.name === 'Preparation acceptance'
    );
    assert.ok(preparation);
    assert.deepEqual(after.state.stocks[source.id].quantity, source.quantity);
    assert.deepEqual(preparation.origin.inputs[0].source, source.source);
    await capture('01-preparation-without-implied-withdrawal', after);
    await releaseInventoryJourneyLot({ page, expect, choose }, preparation.name);
    await row(source.id).click();
    await page.getByRole('button', { name: 'Assign lot', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Assign lot', exact: true });
    await choose(dialog, 'Lot or preparation', 'Preparation acceptance');
    await dialog.getByLabel('Reason', { exact: true }).fill('Explicit attribution correction');
    await dialog.getByRole('button', { name: 'Assign lot', exact: true }).click();
    await expect(dialog).toBeHidden();
    after = await inventoryRead(scope);
    assert.deepEqual(after.state.stocks[source.id].source, { kind: 'lot', lotId: preparation.id });
    assert.deepEqual(after.state.stocks[aliquot.id].source, aliquot.source);
    assert.deepEqual(after.state.lots[preparation.id].origin.inputs[0].source, source.source);
    await capture('02-attributed-without-rewriting-aliquot', after);
    await page.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Transfer or aliquot', exact: true });
    await dialog.getByLabel('Source amount (µL)', { exact: true }).fill('1');
    await choose(dialog, 'Transfer destination', 'Existing compatible stock');
    await choose(dialog, 'Existing stock', /^Aliquot acceptance/);
    await dialog
      .getByLabel('Reason', { exact: true })
      .fill('Attempt incompatible attribution transfer');
    await dialog.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
    await expect(dialog.getByTestId('inventory-refused')).toContainText('same material and lot');
    assert.deepEqual(await inventoryRead(scope), after);
    await capture('03-incompatible-transfer-refused', await dialog.innerText());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByTestId('inventory-refused')
      .getByRole('button', { name: 'Edit change', exact: true })
      .click();
    receipt.expected = { state: after.state, history: after.history };
  }

  if (stage === 'material-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the completed material journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(
      fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`),
      'Reopen the original isolated profile.'
    );
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const readback = await inventoryRead(fixture.scope);
    assert.deepEqual(readback.state, fixture.state);
    assert.deepEqual(readback.history, fixture.history);
    const row = page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${fixture.dilutedId}"]`);
    await expect(row).toContainText('40 µL');
    await row.click();
    await expect(page.getByTestId('inventory-detail-drawer')).toContainText('Diluted acceptance');
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText(
      'Diluted stock into Diluted acceptance'
    );
    await capture('06-materials-reopened', readback);
  }
  if (stage === 'reopen') {
    assert.ok(args.includes('--fixture'), 'Pass --fixture from the completed journey.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(
      fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`),
      'Reopen the original isolated profile.'
    );
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const readback = await inventoryRead(fixture.scope);
    assert.deepEqual(readback.state, fixture.state);
    assert.deepEqual(readback.history, fixture.history);
    const row = page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${fixture.stockId}"]`);
    await expect(row).toContainText('80 µL');
    await expect(row).toContainText('Box acceptance');
    await expect(row).not.toContainText('Loading material');
    await row.click();
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText('Used 20 µL');
    await capture('08-reopened', readback);
  }
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    await stopRecording();
  } catch (error) {
    receipt.status = 'failed';
    receipt.videoFailure = String(error);
    process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ stage, status: receipt.status, out, failure: receipt.failure }));

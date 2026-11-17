import { directTrackAdmissionRequest, parseSequenceLayerCsv } from '@waypoint/genome-data';
import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import { useCanvasStore } from '../../features/canvas/public/store';
import { openDocument } from '../../features/document-opening/public/open-document';
import { openWorkspaceFromSource } from '../../features/workspace-loader/open-workspace-from-source';
import { createTrackedEmptyWorkspace } from '../../features/workspace-loader/workspace-created-telemetry';
import { reconcileWorkspaceAfterFilesChanged } from '../../services/workspace-operations';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
} from '../../features/sequence/public/attach-indexed-bigwig';
import { importGenomeSources } from '../../features/sequence/public/import-genome-sources';
import {
  captureSequenceDataLayerViews,
  selectSequenceDataLayerView,
} from '../../features/sequence/public/sequence-data-layer-view-commands';
import {
  SEQUENCE_DATA_LAYERS_CHANGED,
  sequenceDataLayerCommandSchema,
  type SequenceDataLayerCreateRequest,
} from '../../shared/sequence-data-layer';
import { sequenceDataLayerIndexedTargetId } from '../../shared/sequence-data-layer-indexed-target';
import manifest from '../../../../../test-fixtures/genome-view-prototypes/native-datasets/manifest.json';

export type NativeDataLayerExample =
  | 'crispri'
  | 'regulondb'
  | 'regseq-araAB'
  | 'regseq-arcA'
  | 'regseq-groSL'
  | 'regseq-aphA'
  | 'shape-rpsT_5'
  | '01-tradis'
  | '02-chemical-genetics'
  | '06-proteome'
  | '07-rna-decay'
  | '17-conservation'
  | '05-ribosome-profiling'
  | '08-tss-coverage'
  | '09-termseq'
  | '11-hns-fis'
  | '13-gyrase'
  | '14-supercoiling'
  | '15-methylation'
  | '19-evolution';

type Dataset = (typeof manifest.datasets)[number];
type OpenView = { panelId: string; tabId: string; documentId: string };
const FIXTURE_DIRECTORY = '../../../../../test-fixtures/genome-view-prototypes/native-datasets/';
const files = import.meta.glob<string>(
  '../../../../../test-fixtures/genome-view-prototypes/native-datasets/**/*.{csv,fasta,gb,bed}',
  { query: '?raw', import: 'default', eager: true }
);

async function readFixture(file: string): Promise<string> {
  const content = files[`${FIXTURE_DIRECTORY}${file}`];
  const artifact = manifest.artifacts.find((entry) => entry.file === file);
  if (content === undefined || !artifact) throw new Error(`Missing scientific fixture ${file}.`);
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  if (sha256 !== artifact.sha256 || bytes.length !== artifact.bytes)
    throw new Error(`Scientific fixture ${file} differs from its registered source.`);
  return content;
}

function datasetById(id: string): Dataset {
  const dataset = manifest.datasets.find((entry) => entry.id === id);
  if (!dataset) throw new Error(`Unknown scientific example ${id}.`);
  return dataset;
}

function findView(tabId: string) {
  for (const [panelId, panel] of Object.entries(useCanvasStore.getState().panels)) {
    const tab = panel.tabs.find((entry) => entry.id === tabId);
    if (tab) return { panelId, tab };
  }
  throw new Error('The scientific example view was closed.');
}

async function mountProject(project: { rootPath: string; displayName: string }): Promise<void> {
  await openWorkspaceFromSource(
    { kind: 'local-folder', path: project.rootPath, name: project.displayName },
    { inPlace: true }
  );
  await reconcileWorkspaceAfterFilesChanged({ workspaceRoot: project.rootPath, strict: true });
}

async function openOrdinaryReference(project: string, dataset: Dataset): Promise<OpenView> {
  const fileName = dataset.referenceFile;
  const content = await readFixture(fileName);
  const source = manifest.artifacts.find((entry) => entry.file === fileName)!;
  const imported = await platform().workspace.registerImportedSequenceFromContent({
    targetRoot: project,
    fileName,
    content,
    expectedSourceSha256: source.sha256,
  });
  if (!imported.registered || imported.entityIds.length !== 1)
    throw new Error(imported.reason ?? 'The supplied sequence could not be registered.');
  await reconcileWorkspaceAfterFilesChanged({ workspaceRoot: project, strict: true });
  const opened = await openDocument({
    target: { kind: 'file', path: `${project}/${imported.relPath}`, tabType: 'sequence' },
    label: dataset.reference.id,
    placement: { kind: 'focused' },
  });
  if (opened.status !== 'presented') throw new Error('The supplied sequence could not be opened.');
  const { tab } = findView(opened.tabId);
  if (!tab.sequenceDocument || tab.indexedGenome || tab.entityId !== imported.entityIds[0])
    throw new Error('The example requires an ordinary saved sequence.');
  useCanvasStore.getState().setTabViewState(opened.panelId, opened.tabId, {
    sequenceMapShape: 'linear',
    sequenceRendererVisibility: 'map',
    sequenceWebglCenterBp: dataset.reference.length / 2,
    sequenceViewportCenterBp: dataset.reference.length / 2,
    sequenceWebglZoom: 1,
  });
  return { ...opened, documentId: tab.entityId };
}

function indexedView(tabId: string, dataset: Dataset): OpenView {
  const { tab, panelId } = findView(tabId);
  const genome = tab.indexedGenome;
  if (
    !genome?.assembly ||
    !genome.assemblyReferenceIdentity ||
    genome.chrom !== dataset.reference.id ||
    !assemblyReferencesFromIndexedGenome(genome).some(
      (reference) =>
        reference.name === dataset.reference.id && reference.length === dataset.reference.length
    )
  )
    throw new Error('The example requires its exact prepared reference.');
  return {
    panelId,
    tabId,
    documentId: sequenceDataLayerIndexedTargetId({
      referenceId: genome.assembly.assemblyId,
      chrom: genome.chrom,
      ...genome.assemblyReferenceIdentity,
    }),
  };
}

function numericValues(csv: string, columns: readonly string[]): number[] {
  return parseSequenceLayerCsv(csv).rows.flatMap((row) =>
    columns.flatMap((column) => {
      const text = row.values[column]?.trim();
      const value = Number(text);
      return text && Number.isFinite(value) ? [value] : [];
    })
  );
}

async function inspectTarget(project: string, view: OpenView, dataset: Dataset) {
  const result = await platform().sequenceDataLayers.run({
    operation: 'target',
    project,
    targetDocumentId: view.documentId,
  });
  if (result.status !== 'target')
    throw new Error(
      result.status === 'failed' ? result.message : 'The sequence target is unavailable.'
    );
  if (result.target.sequenceFingerprint !== `sha256:${dataset.reference.normalizedSequenceSha256}`)
    throw new Error('The supplied measurements do not match the opened reference sequence.');
  return result.target;
}

async function addCsvLayer(input: {
  project: string;
  view: OpenView;
  dataset: Dataset;
  label: string;
  geometry: 'bars' | 'points' | 'arcs' | 'matrix';
  palette: 'balance' | 'cividis';
  domain: [number, number];
  transform?: 'linear' | 'log10';
  source?: Extract<SequenceDataLayerCreateRequest['csv'], { kind: 'layer' }>;
  valueColumns?: string[];
}): Promise<Extract<SequenceDataLayerCreateRequest['csv'], { kind: 'layer' }>> {
  const { dataset, view, project } = input;
  if (!dataset.mapping || !dataset.valueColumns || !dataset.unit)
    throw new Error('The example does not declare numeric measurements.');
  const target = await inspectTarget(project, view, dataset);
  const valueColumns = input.valueColumns ?? dataset.valueColumns;
  const captured = captureSequenceDataLayerViews(view.documentId).find(
    (entry) => entry.tabId === view.tabId
  );
  if (!captured) throw new Error('The example view changed before data publication.');
  const request = sequenceDataLayerCommandSchema.parse({
    operation: 'create',
    project,
    requestId: `native-${dataset.id}-${Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify(valueColumns))
        )
      ),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('')}-v1`,
    targetDocumentId: view.documentId,
    expectedSequenceFingerprint: target.sequenceFingerprint,
    expectedAnnotationFingerprint: target.annotationFingerprint,
    csv: input.source ?? { kind: 'text', text: await readFixture(dataset.file) },
    mapping: dataset.mapping,
    valueColumns,
    label: input.label,
    unit: dataset.unit,
    unresolvedPolicy: dataset.unresolvedPolicy ?? 'reject',
    aggregation: 'none',
    presentation: {
      sampleId: valueColumns[0],
      annotationColors: false,
      signalVisible: true,
      style: {
        geometry: input.geometry,
        colorScale: {
          kind: 'continuous',
          domain: input.domain,
          colors: [...SCIENTIFIC_COLOR_PALETTES[input.palette].colors],
          missingColor: '#cbd5e1',
          transform: input.transform ?? 'linear',
        },
      },
    },
  });
  const layer = await platform().sequenceDataLayers.run(request);
  if (layer.status !== 'published')
    throw new Error(layer.status === 'failed' ? layer.message : 'A measurement row did not map.');
  const selected = selectSequenceDataLayerView(captured, { project, layerId: layer.document.id });
  if (selected !== 'updated') throw new Error(`The example view selection was ${selected}.`);
  window.dispatchEvent(new Event(SEQUENCE_DATA_LAYERS_CHANGED));
  return {
    kind: 'layer',
    source: { project: layer.project ?? project, id: layer.document.id, revision: layer.revision },
  };
}

function focusIndexed(
  view: OpenView,
  label: string,
  positions: readonly number[],
  length: number
): void {
  const sorted = [...positions].sort((a, b) => a - b);
  let first = 0,
    best = 0,
    bestEnd = 0;
  for (let last = 0; last < sorted.length; last++) {
    while (sorted[last] - sorted[first] > 10_000) first++;
    if (last - first > bestEnd - best) {
      best = first;
      bestEnd = last;
    }
  }
  const center = sorted.length ? (sorted[best] + sorted[bestEnd]) / 2 : length / 2;
  const start0 = Math.max(0, Math.min(length - 12_000, Math.floor(center - 6_000)));
  const end0 = Math.min(length, start0 + 12_000);
  const { tab } = findView(view.tabId);
  const genome = tab.indexedGenome;
  if (!genome) throw new Error('The indexed view was closed during data admission.');
  useCanvasStore.getState().updateTab(view.panelId, view.tabId, {
    label,
    indexedGenome: {
      ...genome,
      scope: { kind: 'locus', chrom: genome.chrom, start: start0, end: end0 },
    },
    viewState: {
      ...tab.viewState,
      indexedViewport: { start0, end0 },
      indexedViewportCommand: { id: Date.now(), chrom: genome.chrom, start0, end0 },
    },
  });
}

export async function applyNativeDataLayerExample(
  id: NativeDataLayerExample,
  indexedTabId?: string
): Promise<void> {
  const dataset = datasetById(id);
  const project = await createTrackedEmptyWorkspace({ name: dataset.reference.id + ' · ' + id });
  await mountProject(project);
  if (id === 'crispri' || id === 'regulondb' || /^\d{2}-/u.test(id)) {
    if (!indexedTabId) throw new Error('The example requires its indexed reference.');
    const view = indexedView(indexedTabId, dataset);
    const csv = await readFixture(dataset.file);
    if (id === 'crispri') {
      const maximum = Math.max(...numericValues(csv, ['growthEffect']).map(Math.abs));
      await addCsvLayer({
        project: project.rootPath,
        view,
        dataset,
        label: 'CRISPRi growth effects',
        geometry: 'points',
        palette: 'balance',
        domain: [-maximum, maximum],
      });
      focusIndexed(
        view,
        'CRISPRi guide placements',
        numericValues(csv, ['start0']),
        dataset.reference.length
      );
    } else if (id === 'regulondb' || id === '11-hns-fis') {
      await inspectTarget(project.rootPath, view, dataset);
      const checkout = await platform().path.projectRoot();
      if (!checkout) throw new Error('The binding-site example requires its development checkout.');
      const sources =
        id === 'regulondb'
          ? [{ dataset, label: 'RegulonDB binding sites' }]
          : [
              { dataset: datasetById('11-hns-fis-fis-me'), label: 'Fis · mid-exponential binding' },
              {
                dataset: datasetById('11-hns-fis-hns-me'),
                label: 'H-NS · mid-exponential binding',
              },
            ];
      const genome = findView(view.tabId).tab.indexedGenome!;
      const requests = [];
      for (const source of sources) {
        const imported = await platform().workspace.importFile({
          targetRoot: project.rootPath,
          sourcePath: `${checkout}/test-fixtures/genome-view-prototypes/native-datasets/${source.dataset.file}`,
        });
        const hash = await platform().fs.contentHash({
          workspaceRoot: project.rootPath,
          workspaceRelativePath: imported.relPath,
        });
        if (
          hash !==
          `sha256:${manifest.artifacts.find((entry) => entry.file === source.dataset.file)!.sha256}`
        )
          throw new Error('The imported binding sites differ from their registered source.');
        requests.push(
          directTrackAdmissionRequest({
            assemblyId: assemblyIdFromIndexedGenome(genome),
            input: { kind: 'path', path: `${project.rootPath}/${imported.relPath}` },
            formatId: 'bed',
            scientificKind: 'interval',
            label: source.label,
            ingress: 'session',
            sessionId: `native-${id}`,
          })
        );
      }
      const results = await importGenomeSources({
        laneOwnerId: view.tabId,
        assemblyId: assemblyIdFromIndexedGenome(genome),
        assemblyDisplayName: dataset.reference.id,
        assemblyReferences: assemblyReferencesFromIndexedGenome(genome),
        localAuthorityContext: 'workspace-grounded',
        requests,
      });
      const failed = results.find((result) => result.status === 'failed');
      if (failed?.status === 'failed') throw new Error(failed.message);
      focusIndexed(
        view,
        id === 'regulondb' ? 'RegulonDB binding sites' : 'Fis and H-NS binding intervals',
        csv
          .trim()
          .split('\n')
          .map((row) => Number(row.split('\t')[1])),
        dataset.reference.length
      );
    } else if (id === '13-gyrase') {
      const maximum = Math.max(...numericValues(csv, ['n3e']));
      for (const [condition, label] of [
        ['cfx', 'Gyrase cleavage · ciprofloxacin 10 µM'],
        ['oxo', 'Gyrase cleavage · oxolinic acid'],
        ['micro', 'Gyrase cleavage · microcin B17'],
      ] as const) {
        await addCsvLayer({
          project: project.rootPath,
          view,
          dataset: datasetById(`13-gyrase-${condition}`),
          label,
          geometry: 'points',
          palette: 'cividis',
          domain: [0, maximum],
        });
      }
      focusIndexed(
        view,
        'Gyrase cleavage · author W3110-Mu reference',
        numericValues(csv, ['start0']),
        dataset.reference.length
      );
    } else if (id === '15-methylation') {
      const source = await addCsvLayer({
        project: project.rootPath,
        view,
        dataset,
        label: 'Baseline methylated fractions',
        geometry: 'matrix',
        palette: 'cividis',
        domain: [0, 1],
      });
      const coverage = datasetById('15-methylation-coverage');
      const values = numericValues(csv, coverage.valueColumns!);
      await addCsvLayer({
        project: project.rootPath,
        view,
        dataset: coverage,
        label: 'Methylation read support',
        geometry: 'bars',
        palette: 'cividis',
        domain: [0, Math.max(...values)],
        source,
      });
      focusIndexed(
        view,
        'Methylation fractions and coverage · baseline replicates',
        numericValues(csv, ['start0']),
        dataset.reference.length
      );
    } else if (dataset.mapping?.kind === 'positions') {
      const startColumn = dataset.mapping.startColumn;
      if (!startColumn) throw new Error('The source has no declared coordinate column.');
      if (!dataset.valueColumns) throw new Error('The source has no declared measurement columns.');
      const values = numericValues(csv, dataset.valueColumns);
      const maximum = Math.max(...values.map(Math.abs));
      const label =
        id === '05-ribosome-profiling'
          ? 'Ribosome footprint density'
          : id === '08-tss-coverage'
            ? 'Strand-specific RNA coverage'
            : id === '09-termseq'
              ? 'RNA 3′-end read counts'
              : id === '19-evolution'
                ? 'Published SNP clone counts'
                : 'Psoralen crosslinking signal';
      await addCsvLayer({
        project: project.rootPath,
        view,
        dataset,
        label,
        geometry:
          id === '14-supercoiling'
            ? 'matrix'
            : id === '09-termseq' || id === '19-evolution'
              ? 'points'
              : 'bars',
        palette: id === '14-supercoiling' ? 'balance' : 'cividis',
        domain: id === '14-supercoiling' ? [-maximum, maximum] : [Math.min(0, ...values), maximum],
      });
      if (id === '08-tss-coverage') {
        const points = datasetById('08-tss-tss-step-height');
        const pointValues = numericValues(await readFixture(points.file), points.valueColumns!);
        await addCsvLayer({
          project: project.rootPath,
          view,
          dataset: points,
          label: 'Published TSS step heights',
          geometry: 'points',
          palette: 'cividis',
          domain: [Math.min(0, ...pointValues), Math.max(...pointValues)],
        });
      }
      const offset = dataset.mapping.coordinateSystem === 'one-based-inclusive' ? 1 : 0;
      focusIndexed(
        view,
        label,
        numericValues(csv, [startColumn]).map((position) => position - offset),
        dataset.reference.length
      );
    } else {
      if (!dataset.valueColumns) throw new Error('The source has no declared measurement columns.');
      const values = numericValues(csv, dataset.valueColumns);
      const labels = {
        '01-tradis': 'BW25113 gene insertion indices',
        '02-chemical-genetics': 'Mutant growth scores',
        '06-proteome': 'BW25113 protein copies per cell',
        '07-rna-decay': 'Single-gene transcript lifetimes',
        '17-conservation': 'Published gene states · matched subset',
      };
      const label = labels[id as keyof typeof labels];
      if (!label) throw new Error('Unknown gene-property example.');
      const signed = id === '02-chemical-genetics' || id === '17-conservation';
      const maximum = Math.max(...values.map(Math.abs));
      const binding = await addCsvLayer({
        project: project.rootPath,
        view,
        dataset,
        label,
        geometry: id === '01-tradis' ? 'bars' : 'matrix',
        palette: signed ? 'balance' : 'cividis',
        domain: signed
          ? [-maximum, maximum]
          : [id === '06-proteome' ? Math.min(...values) : Math.min(0, ...values), maximum],
        transform: id === '06-proteome' ? 'log10' : 'linear',
      });
      const layer = await platform().sequenceDataLayers.run({
        operation: 'inspect',
        project: project.rootPath,
        id: binding.source.id,
      });
      if (layer.status !== 'published') throw new Error('The gene-property layer is unavailable.');
      focusIndexed(
        view,
        label + ' · MG1655 gene mapping',
        layer.document.dataset.samples[0].observations.map((observation) => observation.start),
        dataset.reference.length
      );
    }
    return;
  }
  const view = await openOrdinaryReference(project.rootPath, dataset);
  if (id.startsWith('regseq-')) {
    const all = await Promise.all(
      manifest.datasets
        .filter((entry) => entry.id.startsWith('regseq-'))
        .map(async (entry) => numericValues(await readFixture(entry.file), ['LB', 'Anaero']))
    );
    const maximum = Math.max(...all.flat().map(Math.abs));
    const source = await addCsvLayer({
      project: project.rootPath,
      view,
      dataset,
      label: 'Promoter information footprint',
      geometry: 'bars',
      palette: 'balance',
      domain: [-maximum, maximum],
    });
    await addCsvLayer({
      project: project.rootPath,
      view,
      dataset,
      label: 'Anaerobic promoter footprint',
      geometry: 'points',
      palette: 'balance',
      domain: [-maximum, maximum],
      source,
      valueColumns: ['Anaero'],
    });
  } else {
    const values = numericValues(await readFixture(dataset.file), ['reactivity']);
    await addCsvLayer({
      project: project.rootPath,
      view,
      dataset,
      label: 'rpsT SHAPE reactivity',
      geometry: 'bars',
      palette: 'cividis',
      domain: [Math.min(0, ...values), Math.max(...values)],
    });
    await addCsvLayer({
      project: project.rootPath,
      view,
      dataset: datasetById('shape-rpsT_5-pairs'),
      label: 'Supplied RNA base pairs',
      geometry: 'arcs',
      palette: 'balance',
      domain: [0, 1],
    });
  }
}

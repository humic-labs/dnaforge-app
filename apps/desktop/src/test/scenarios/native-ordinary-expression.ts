import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import { useCanvasStore } from '../../features/canvas/public/store';
import { openDocument } from '../../features/document-opening/public/open-document';
import { openWorkspaceFromSource } from '../../features/workspace-loader/open-workspace-from-source';
import { reconcileWorkspaceAfterFilesChanged } from '../../services/workspace-operations';
import { createTrackedEmptyWorkspace } from '../../features/workspace-loader/workspace-created-telemetry';
import {
  captureSequenceDataLayerViews,
  selectSequenceDataLayerView,
} from '../../features/sequence/public/sequence-data-layer-view-commands';
import { SEQUENCE_DATA_LAYERS_CHANGED } from '../../shared/sequence-data-layer';
import expression from '../../../../../test-fixtures/genome-view-prototypes/PRECISE1K-subset.json';

export async function applyNativeOrdinaryExpression(): Promise<void> {
  const bridge = platform();
  const checkout = await bridge.path.projectRoot();
  if (!checkout)
    throw new Error('The native expression example requires its development checkout.');
  const project = await createTrackedEmptyWorkspace({ name: 'Expression on an existing sequence' });
  const imported = await bridge.workspace.registerImportedSequence({
    targetRoot: project.rootPath,
    expectedSourceSha256: 'd971a6818465a4b0f1046966338681e5f1ea7836950ac4936c36ec9e5e7ee73a',
    sourcePath: `${checkout}/test-fixtures/genome-view-prototypes/MG1655-rut-locus.gb`,
  });
  if (!imported.registered || imported.entityIds.length !== 1)
    throw new Error(
      imported.reason ?? 'The sequence was not admitted by its native document owner.'
    );
  await openWorkspaceFromSource(
    { kind: 'local-folder', path: project.rootPath, name: project.displayName },
    { inPlace: true }
  );
  await reconcileWorkspaceAfterFilesChanged({ workspaceRoot: project.rootPath, strict: true });
  const opened = await openDocument({
    target: { kind: 'file', path: `${project.rootPath}/${imported.relPath}`, tabType: 'sequence' },
    label: 'MG1655 rut locus · expression',
    placement: { kind: 'focused' },
  });
  if (opened.status !== 'presented') throw new Error('The ordinary sequence could not be opened.');
  const tab = useCanvasStore
    .getState()
    .panels[opened.panelId]?.tabs.find((tab) => tab.id === opened.tabId);
  if (!tab?.sequenceDocument || tab.indexedGenome || tab.entityId !== imported.entityIds[0])
    throw new Error('The example requires an ordinary saved sequence.');
  useCanvasStore.getState().setTabViewState(opened.panelId, opened.tabId, {
    sequenceMapShape: 'linear',
    sequenceRendererVisibility: 'map',
    sequenceWebglCenterBp: 8500,
    sequenceViewportCenterBp: 8500,
    sequenceWebglZoom: 1,
  });
  const target = await bridge.sequenceDataLayers.run({
    operation: 'target',
    project: project.rootPath,
    targetDocumentId: tab.entityId,
  });
  if (target.status !== 'target')
    throw new Error(
      target.status === 'failed' ? target.message : 'The exact sequence identity is unavailable.'
    );
  const columns = expression.matrix.columns.map((column) => column.id);
  const csv = [
    ['locus_tag', ...columns].join(','),
    ...expression.records.map((record) => [record.id, ...record.values].join(',')),
  ].join('\n');
  const views = captureSequenceDataLayerViews(tab.entityId);
  const layer = await bridge.sequenceDataLayers.run({
    operation: 'create',
    project: project.rootPath,
    requestId: 'native-precise-expression-v1',
    targetDocumentId: tab.entityId,
    expectedSequenceFingerprint: target.target.sequenceFingerprint,
    expectedAnnotationFingerprint: target.target.annotationFingerprint,
    csv: { kind: 'text', text: csv },
    mapping: { kind: 'annotation', identifierColumn: 'locus_tag', identifierField: 'locus_tag' },
    valueColumns: columns,
    label: 'PRECISE-1K expression',
    unit: 'published log2 TPM',
    unresolvedPolicy: 'exclude',
    aggregation: 'none',
    presentation: {
      sampleId: columns[0],
      annotationColors: true,
      signalVisible: true,
      style: {
        geometry: 'bars',
        colorScale: {
          kind: 'continuous',
          domain: [0, 16],
          colors: [...SCIENTIFIC_COLOR_PALETTES.viridis.colors],
          missingColor: '#cbd5e1',
          transform: 'linear',
        },
      },
    },
  });
  if (layer.status !== 'published')
    throw new Error(
      layer.status === 'failed'
        ? layer.message
        : 'The expression layer needs an explicit mapping correction.'
    );
  for (const view of views)
    selectSequenceDataLayerView(view, { project: project.rootPath, layerId: layer.document.id });
  window.dispatchEvent(new Event(SEQUENCE_DATA_LAYERS_CHANGED));
}

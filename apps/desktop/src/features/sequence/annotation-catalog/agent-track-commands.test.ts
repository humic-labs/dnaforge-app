import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { trackBindingId } from '@waypoint/genome-data/annotation-catalog';
import { useCanvasStore } from '../../canvas/public/store';
import {
  updateSequenceAnnotationTracks,
  inspectSequenceAnnotationTracks,
} from '../public/annotation-catalog-commands';
import { sequenceViewMemoryKey } from '../view-state/sequence-view-state';
import { loadAnnotationCatalogs } from './annotation-catalog-registry';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';
import { defaultLayoutFor } from './default-layout';
import {
  appViewsSchema,
  createAppViewsTool,
  appViewsOutputSchema,
} from '../../ai/public/tools/app-views';
import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';

const documentId = 'fixture:sequence:agent-annotation-tracks';
const tool = checkedToolFactory(createAppViewsTool, appViewsOutputSchema)();
const execute = (operation: unknown) =>
  tool.execute!(appViewsSchema.parse({ operation }), {
    toolCallId: 'annotation-tracks-proof',
    messages: [],
  });
const revisionOf = (result: unknown) =>
  z.object({ ok: z.literal(true), revision: z.string() }).parse(result).revision;

beforeAll(async () => {
  await loadAnnotationCatalogs(bundledStoreBridge());
});
beforeEach(() => {
  localStorage.clear();
  useCanvasStore.getState().reset();
});

function openTracks() {
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: documentId,
    label: 'MG1655',
    sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
  });
  expect(
    updateSequenceAnnotationTracks({
      ownerTabId: tabId,
      command: {
        kind: 'set-layout',
        layout: defaultLayoutFor('NC_000913.3'),
      },
    }).status
  ).toBe('updated');
  return tabId;
}

describe('agent annotation tracks share the human command owner', () => {
  it('changes the native layout and the same reopen memory from an inspected revision', async () => {
    const tabId = openTracks();
    const revision = revisionOf(await execute({ kind: 'inspect-tracks', tabId }));
    const result = await execute({
      kind: 'configure-tracks',
      tabId,
      expectedRevision: revision,
      command: { kind: 'set-visibility', trackId: 'promoters', visible: false },
    });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(revisionOf(result)).not.toBe(revision);
    const native = inspectSequenceAnnotationTracks(tabId);
    expect(
      native.status === 'found' &&
        native.tracks.find((t) => t.binding.id === 'promoters')?.binding.visible
    ).toBe(false);
    const memory = JSON.parse(localStorage.getItem(sequenceViewMemoryKey(documentId))!);
    expect(
      memory.annotationCatalogLayout.tracks.find((t: { id: string }) => t.id === 'promoters')
        .visible
    ).toBe(false);
  });

  it('refuses an older agent command after a human changes the layout', async () => {
    const tabId = openTracks();
    const revision = revisionOf(await execute({ kind: 'inspect-tracks', tabId }));
    updateSequenceAnnotationTracks({
      ownerTabId: tabId,
      command: {
        kind: 'set-visibility',
        trackId: trackBindingId('promoters'),
        visible: false,
      },
    });
    const before = localStorage.getItem(sequenceViewMemoryKey(documentId));
    const result = await execute({
      kind: 'configure-tracks',
      tabId,
      expectedRevision: revision,
      command: { kind: 'set-visibility', trackId: 'promoters', visible: true },
    });
    expect(result).toMatchObject({ ok: false, code: 'STALE_VIEW', stateChanged: false });
    expect(localStorage.getItem(sequenceViewMemoryKey(documentId))).toBe(before);
  });

  it('retains the exact layout when the native source validator refuses the command', async () => {
    const tabId = openTracks();
    const revision = revisionOf(await execute({ kind: 'inspect-tracks', tabId }));
    const before = localStorage.getItem(sequenceViewMemoryKey(documentId));
    const result = await execute({
      kind: 'configure-tracks',
      tabId,
      expectedRevision: revision,
      command: { kind: 'set-source', trackId: 'terminators', sourceId: 'predicted-operons-50bp' },
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_TRACK_CONFIGURATION',
      stateChanged: false,
    });
    expect(localStorage.getItem(sequenceViewMemoryKey(documentId))).toBe(before);
  });
});

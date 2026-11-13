import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeNotebookDocumentClient } from './notebook-document-client';
import { captureNotebookDocumentUpdate, resetNotebookWorkflowForTests } from './notebook-workflow';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookSource,
} from '../../main/notebook-document-owner';
import { NotebookDocumentModel } from '../../shared/notebook-model/document';
import { getNotebookBaseExtensions } from '../../shared/notebook-model/extensions/notebook-model-extensions';
import { NotebookMentionNode } from '../../shared/notebook-model/extensions/notebook-mention-model';
import { NotebookEmbedNode } from '../../shared/notebook-model/extensions/notebook-embed-model';
import { canonicalNotebookJson } from '../../db/notebook-markdown-codec';
import { contentFingerprint } from '../../shared/content-fingerprint';
import { NativeDocumentCommandError } from '../../shared/native-document-error';
import { __resetTelemetryCorrelationForTests } from '../../lib/telemetry-correlation';
import type { NativeNotebookRequest } from '../../shared/notebook-document';

const state = vi.hoisted(() => ({
  events: [] as Array<{ event: string; properties: Record<string, unknown> }>,
  execute: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({
  captureAnalyticsOptionalOrigin: () => ({
    consentScope: '550e8400-e29b-41d4-a716-446655440004',
    contextId: '550e8400-e29b-41d4-a716-446655440003',
    processId: '550e8400-e29b-41d4-a716-446655440005',
    classification: 'synthetic',
  }),
  getAnalyticsCaptureGeneration: () => 1,
  getAnalyticsIdentifiedAccountId: () => '550e8400-e29b-41d4-a716-446655440006',
  isAnalyticsCaptureReady: () => true,
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
  subscribeAnalyticsCaptureReady: () => () => {},
  trackRendererEvent: (event: string, properties: Record<string, unknown>) => {
    state.events.push({ event, properties });
    return true;
  },
}));
vi.mock('../../platform', () => ({ platform: () => ({ notebook: { execute: state.execute } }) }));
vi.mock('../workspace/public/file-document-client', () => ({
  registerNativeDocumentClientFlush() {},
  waitForNativeFileDocumentReadiness: async () => {},
}));
vi.mock('../../shared/unsaved-draft-recovery', () => ({
  readAllUnsavedDrafts: async () => [],
  deleteUnsavedDraft: async () => {},
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addRichToast() {} }) },
}));
vi.mock('./store', () => ({ usePageStore: { getState: () => ({ pages: {} }) } }));

const ROOT = '/registered';
const PAGE = 'notebook';

function makeSource(content: JSONContent): NativeNotebookSource {
  return {
    content: structuredClone(content),
    title: 'Notebook',
    fingerprint: contentFingerprint(canonicalNotebookJson(content)),
    metadataRaw: '{}',
    preservedPreamble: '',
    preservedTitleProjection: { kind: 'missing-heading', source: '', lineEnding: '\n' },
    sourceShape: 'v2-package',
  };
}

function paragraph(text: string): JSONContent {
  return new NotebookDocumentModel(
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    'Notebook'
  ).content;
}

const commits = (kind: string) =>
  state.events.filter(
    ({ event, properties }) =>
      event === 'workflow_action_observed' &&
      properties.workflow === 'content' &&
      properties.workflow_action === 'commit' &&
      properties.outcome_kind === kind
  );

let owner: NativeNotebookWorkingCopyOwner | undefined;
let editor: Editor | undefined;

beforeEach(() => {
  state.events = [];
  resetNotebookWorkflowForTests();
  __resetTelemetryCorrelationForTests();
});

afterEach(async () => {
  editor?.destroy();
  editor = undefined;
  await owner?.close();
  owner = undefined;
  state.execute.mockReset();
  resetNotebookWorkflowForTests();
});

it('reports the commit of a Save made after a refused Save and Keep my edits', async () => {
  let disk = makeSource(paragraph('Original note.'));
  const options: NativeNotebookOptions = {
    resolve: async () => ({
      documentId: PAGE,
      path: ROOT + '/Notebook',
      workspaceRoot: ROOT,
      readOnly: false,
      assertCurrent() {},
    }),
    load: async () => disk,
    publish: async (_scope, source, value) => {
      if (source.fingerprint !== disk.fingerprint)
        throw new NativeDocumentCommandError(
          'NOTEBOOK_EXTERNAL_CONFLICT',
          'The notebook changed outside DNAForge.',
          false
        );
      disk = makeSource(value);
      return { source: disk };
    },
    loadRecord: async () => undefined,
    storeRecord: async () => {},
    retainedDirty: async () => [],
    normalizePath: (path) => path,
    prepareInsertion: async () => {
      throw new Error('Unused source insertion.');
    },
    search: async () => [],
    list: async () => [],
    create: async () => {
      throw new Error('Unused notebook creation.');
    },
  };
  owner = new NativeNotebookWorkingCopyOwner(options);
  const nativeOwner = owner;
  state.execute.mockImplementation((request: NativeNotebookRequest) =>
    nativeOwner.execute(request)
  );
  const client = new NativeNotebookDocumentClient(PAGE);
  await client.initialize();
  const authored = new Editor({
    extensions: [...getNotebookBaseExtensions(), NotebookMentionNode, NotebookEmbedNode],
    content: client.snapshot!.copy.content,
    onUpdate: ({ transaction, editor: current }) => {
      const content = current.getJSON();
      captureNotebookDocumentUpdate({
        owner: current,
        pageId: PAGE,
        workspaceRoot: ROOT,
        transaction,
        content,
      });
      client.capture(transaction, content);
    },
  });
  editor = authored;
  client.attach(authored);
  authored.commands.insertContentAt(authored.state.doc.content.size - 1, ' LOCAL EDIT');
  await client.flush();

  disk = makeSource(paragraph('External note.'));
  expect(await client.save()).toBe(false);
  const refusals = commits('notebook_save_conflict');
  expect(refusals).toHaveLength(1);
  expect(commits('notebook_committed')).toEqual([]);

  await client.command({ kind: 'keep-local', expectedCanonicalFingerprint: disk.fingerprint });
  expect(await client.save()).toBe(true);

  expect(canonicalNotebookJson(disk.content)).toBe(canonicalNotebookJson(authored.getJSON()));
  const saved = commits('notebook_committed');
  expect(saved).toHaveLength(1);
  expect(saved[0].properties).toMatchObject({
    action_phase: 'result',
    workflow_status: 'saved',
    success: true,
    record_write_status: 'written',
    record_projection_status: 'ready',
    artifact_correlation_id: refusals[0].properties.artifact_correlation_id,
  });
  expect(saved[0].properties.action_id).not.toBe(refusals[0].properties.action_id);
});

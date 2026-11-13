import { describe, expect, it } from 'vitest';
import {
  nativeFileDocumentOutputSchema,
  nativeSequenceDocumentOutputSchema,
  nativeNotebookDocumentOutputSchema,
} from './native-document-output-schemas';
import {
  searchWorkspaceOutputSchema,
  projectHistoryOutputSchema,
  importReviewOutputSchema,
  administrationOutputSchema,
} from './native-workflow-output-schemas';

const common = {
  documentId: 'document-one',
  path: '/project/source.txt',
  workspaceRoot: '/project',
  revision: 'revision-one',
  persistedRevision: 'revision-one',
  ready: true,
  readOnly: false,
  dirty: false,
  saving: false,
  canUndo: false,
  canRedo: false,
  capabilities: ['inspect', 'save'],
};
const file = { ...common, ok: true, type: 'text', text: 'AACC', length: 4, nextOffset: null };
const sequenceSnapshot = {
  ...common,
  path: '/project/source.gb',
  version: 1,
  savedVersion: 1,
  length: 4,
  annotationCount: 0,
  bases: { start: 0, end: 4, text: 'AACC' },
  annotations: [],
  nextAnnotationOffset: null,
};
const sequence = { ...sequenceSnapshot, ok: true };
const notebookSnapshot = {
  documentId: common.documentId,
  workspaceRoot: common.workspaceRoot,
  revision: common.revision,
  persistedRevision: common.persistedRevision,
  ready: common.ready,
  readOnly: common.readOnly,
  dirty: common.dirty,
  saving: common.saving,
  canUndo: common.canUndo,
  canRedo: common.canRedo,
  path: '/project/notebook/notebook.md',
  pageId: common.documentId,
  title: 'Notebook',
  canonicalFingerprint: 'fingerprint-one',
  version: 1,
  blockCount: 1,
  blocks: [
    { index: 0, block: { type: 'paragraph', content: [{ type: 'text', text: 'Saved text' }] } },
  ],
  nextOffset: null,
  recovery: { baselineMismatch: false },
};
const notebook = { ...notebookSnapshot, ok: true, editable: true };
const search = {
  ok: true,
  query: 'source',
  projects: [{ name: 'Project', root: '/project' }],
  results: [
    {
      entityId: 'document-one',
      entityType: 'sequence',
      name: 'source',
      workspaceRoot: '/project',
      workspaceName: 'Project',
    },
  ],
  nextCursor: null,
};
const history = {
  ok: true,
  status: 'ok',
  operation: 'inspect',
  stateChanged: false,
  paths: [],
  warnings: [],
  inspection: {
    workspaceRoot: '/project',
    tracked: true,
    head: 'head-one',
    branch: 'dev',
    revision: 'history-one',
    entries: [
      { path: 'source.gb', status: 'modified', staged: false, unstaged: true, package: false },
    ],
    totalEntries: 1,
    nextOffset: null,
    protectedStagedPaths: [],
  },
};
const review = {
  ok: true,
  id: 'review-one',
  revision: 'review-revision-one',
  workspaceRoot: '/project',
  destinationDir: '/project/imports',
  phase: 'review',
  sourceName: 'records.csv',
  sourceFingerprint: 'source-one',
  sourceKind: 'csv',
  columns: [
    {
      sourceColumn: 'name',
      mappedField: 'name',
      mappingMode: 'mapped',
      confidence: 'deterministic',
      warnings: [],
    },
  ],
  totalRecords: 1,
  records: [
    {
      id: 'record-one',
      accepted: true,
      action: 'create',
      entityDraft: { kind: 'strain', name: 'Example', fields: { notes: 'Source note' } },
      duplicateCandidates: [],
      proposedLinks: [],
      unresolvedLinks: [],
      errors: [],
      warnings: [],
      source: { name: 'Example' },
    },
  ],
  nextOffset: null,
  canApply: true,
};
const settings = {
  ok: true,
  kind: 'settings',
  stateChanged: false,
  snapshot: {
    ownerId: 'owner-one',
    generation: 1,
    revision: 'settings-one',
    values: {
      theme: 'light',
      displayZoom: 1,
      assemblyColorScheme: 'tailwind',
      webglPerformance: 'auto',
    },
    adopted: [],
    persistence: 'saved',
    unsavedKeys: [],
    zoom: { status: 'applied', factor: 1 },
  },
};
const cases = [
  { name: 'file', schema: nativeFileDocumentOutputSchema, value: file },
  { name: 'sequence', schema: nativeSequenceDocumentOutputSchema, value: sequence },
  { name: 'notebook', schema: nativeNotebookDocumentOutputSchema, value: notebook },
  { name: 'search', schema: searchWorkspaceOutputSchema, value: search },
  { name: 'history', schema: projectHistoryOutputSchema, value: history },
  { name: 'import review', schema: importReviewOutputSchema, value: review },
  { name: 'administration', schema: administrationOutputSchema, value: settings },
];

describe('concrete native command success output contracts', () => {
  it.each(cases)(
    'accepts the public $name owner shape and refuses an unstructured success',
    ({ schema, value }) => {
      expect(schema.safeParse(value)).toMatchObject({ success: true });
      expect(schema.safeParse({ ok: true }).success).toBe(false);
      expect(schema.safeParse({ ...value, ok: false }).success).toBe(false);
    }
  );
  it('accepts exact dirty inventory and typed scientific projections without full working copies', () => {
    const dirty = {
      ok: true,
      documents: [
        {
          documentId: common.documentId,
          target: { documentId: common.documentId },
          path: common.path,
          workspaceRoot: common.workspaceRoot,
          kind: 'text',
          revision: common.revision,
          readOnly: false,
          dirty: true,
          saving: false,
          recovery: false,
          inspectionRequired: false,
        },
      ],
      nextCursor: null,
    };
    expect(nativeFileDocumentOutputSchema.safeParse(dirty).success).toBe(true);
    expect(
      nativeFileDocumentOutputSchema.safeParse({
        ...sequence,
        type: 'sequence',
        kind: 'sequence',
        sequence: sequenceSnapshot,
      }).success
    ).toBe(true);
    expect(
      nativeFileDocumentOutputSchema.safeParse({
        ...common,
        ok: true,
        type: 'notebook',
        notebook: notebookSnapshot,
      }).success
    ).toBe(true);
    expect(
      nativeFileDocumentOutputSchema.safeParse({
        ...common,
        ok: true,
        type: 'scientific',
        readOnly: true,
        capabilities: ['inspect'],
        reason: 'No native working-copy adapter',
      }).success
    ).toBe(true);
    expect(
      nativeFileDocumentOutputSchema.safeParse({
        ...dirty,
        documents: [{ ...dirty.documents[0], target: {} }],
      }).success
    ).toBe(false);
  });
  it('keeps the three existing concrete browser and legacy tab response shapes', () => {
    expect(
      nativeFileDocumentOutputSchema.safeParse({
        ok: true,
        path: '/project/source.txt',
        type: 'text',
        revision: 'legacy-one',
        ready: true,
        readOnly: false,
        dirty: false,
      }).success
    ).toBe(true);
    expect(
      nativeSequenceDocumentOutputSchema.safeParse({
        ok: true,
        documentId: 'sequence-one',
        version: 1,
        dirty: true,
        canUndo: true,
        canRedo: false,
        length: 4,
        annotationCount: 0,
        nextMutationInput: { documentId: 'sequence-one', expectedVersion: 1 },
      }).success
    ).toBe(true);
    expect(
      nativeNotebookDocumentOutputSchema.safeParse({
        ok: true,
        pageId: 'page-one',
        revision: 'legacy-one',
        title: 'Notebook',
        dirty: false,
        editable: true,
        blocks: [],
        blockCount: 0,
        nextOffset: null,
      }).success
    ).toBe(true);
  });
  it('admits a native catalog identity and save settlement on the strict snapshot', () => {
    const identity = '["binding","1","/project","source.gb","genbank"]';
    const withIdentity = { ...sequence, bindingIdentity: identity };
    expect(nativeSequenceDocumentOutputSchema.safeParse(withIdentity).success).toBe(true);
    expect(
      nativeSequenceDocumentOutputSchema.safeParse({ ...sequence, bindingIdentity: '' }).success
    ).toBe(false);
    expect(
      nativeFileDocumentOutputSchema.safeParse({
        ...withIdentity,
        type: 'sequence',
        kind: 'sequence',
        sequence: { ...sequenceSnapshot, bindingIdentity: identity },
      }).success
    ).toBe(true);
    const saved = {
      ...withIdentity,
      saved: true,
      outcome: 'saved' as const,
      saveResult: {
        status: 'saved' as const,
        eventId: 'evt-1',
        lineage: 'recorded' as const,
        fileSha256: `sha256:${'a'.repeat(64)}`,
        writeReceipt: {
          nativeActionId: 'act-1',
          revisionId: 'evt-1',
          contentSha256: 'a'.repeat(64),
          wrote: true,
        },
      },
      history: {
        status: 'committed' as const,
        historyStatus: 'committed' as const,
        nativeActionId: 'act-1',
      },
    };
    expect(nativeSequenceDocumentOutputSchema.safeParse(saved).success).toBe(true);
    expect(
      nativeSequenceDocumentOutputSchema.safeParse({
        ...saved,
        history: { ...saved.history, nativeActionId: '' },
      }).success
    ).toBe(false);
  });
  it('refuses private document copies and raw recovery payloads', () => {
    expect(
      nativeFileDocumentOutputSchema.safeParse({ ...file, content: 'private full content' }).success
    ).toBe(false);
    expect(
      nativeSequenceDocumentOutputSchema.safeParse({
        ...sequence,
        copy: { sequence: 'private full sequence' },
      }).success
    ).toBe(false);
    expect(
      nativeNotebookDocumentOutputSchema.safeParse({
        ...notebook,
        recovery: { baselineMismatch: false, content: { type: 'doc' } },
      }).success
    ).toBe(false);
  });
  it('admits only an empty overflow table preview while retaining its row and column counts', () => {
    const table = {
      rows: 1000,
      columns: 50,
      rowOffset: 0,
      columnOffset: 0,
      cells: [],
      requiresSmallerWindow: true,
    };
    const value = { ...common, ok: true, type: 'csv', table };
    expect(nativeFileDocumentOutputSchema.safeParse(value).success).toBe(true);
    expect(
      nativeFileDocumentOutputSchema.safeParse({
        ...value,
        table: { ...table, cells: [[{ value: 'unexpected content', type: 'text' }]] },
      }).success
    ).toBe(false);
  });
  it('retains a concrete account-bound private import action without accepting its capability link', () => {
    const action = {
      id: 'action-one',
      revision: 'action-revision-one',
      createdAt: '2026-10-31T00:00:00Z',
      expiresAt: '2026-10-31T01:00:00Z',
      account: { accountId: 'account-one', desktopSessionId: 'session-one' },
      originAgent: null,
      state: 'prepared',
      effects: ['write-workspace'],
      target: {
        kind: 'share-import',
        review: {
          source: {
            shareId: 'share-one',
            shortId: 'short-one',
            bundleSha256: 'bundle-one',
            artifactName: 'Sequence',
            fileCount: 1,
            conversationCount: 0,
            totalBytes: 4,
          },
          destination: {
            kind: 'new-private-project',
            workspaceUuid: 'project-two',
            displayName: 'Private copy',
            repoPath: '/project-two',
          },
        },
      },
    };
    expect(administrationOutputSchema.safeParse({ ok: true, kind: 'action', action }).success).toBe(
      true
    );
    expect(
      administrationOutputSchema.safeParse({
        ok: true,
        kind: 'action',
        action: { ...action, target: { kind: 'share-import', review: {} } },
      }).success
    ).toBe(false);
    expect(
      administrationOutputSchema.safeParse({
        ok: true,
        kind: 'action',
        action: {
          ...action,
          target: {
            ...action.target,
            review: {
              ...action.target.review,
              sourceUrl: 'dnaforge://import-share?token=private-capability',
            },
          },
        },
      }).success
    ).toBe(false);
  });
});

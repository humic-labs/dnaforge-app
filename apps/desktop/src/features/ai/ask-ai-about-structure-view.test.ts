import { beforeEach, expect, it, vi } from 'vitest';
import { initializeTestSchema } from '../../test/initializeTestSchema';
import { createEntityReference } from '../../db/entity-references';
import { coordinateDigest } from '../../shared/molecular-view';
import {
  molecularDocumentReferenceFor,
  molecularDocumentReferenceLocator,
} from '../../shared/molecular-document-reference';
import { askAiAboutStructureView } from './ask-ai-about-structure-view';
import { expandReferencesFromIds } from './orchestration/reference-context';

const { picker, capture, resolveDocument } = vi.hoisted(() => ({
  picker: vi.fn(),
  capture: vi.fn(),
  resolveDocument: vi.fn(),
}));
vi.mock('./hooks/useChat', () => ({
  useChatStore: { getState: () => ({ setPendingAskAiPicker: picker }) },
}));
vi.mock('../agent-bridge/public/structure-tools', () => ({ handleMolSaveView: capture }));
vi.mock('../molecular-documents/public/references', () => ({
  resolveMolecularDocumentReference: resolveDocument,
  resolveLegacyMolecularDocumentReference: vi.fn(),
  recoverMolecularDocumentRevision: vi.fn(),
}));

beforeEach(async () => {
  await initializeTestSchema();
  picker.mockReset();
  capture.mockReset();
  resolveDocument.mockReset();
});

async function capturedViewFixture() {
  const text = 'HEADER EXACT DISPLAYED COORDINATES\nEND\n';
  const snapshot = await createEntityReference({
    entityType: 'structure',
    displayLabel: 'Current document',
    locator: 'entity://structure/saved-view:captured',
    deepLinkParams: null,
    data: {
      kind: 'molecular-view',
      version: 1,
      title: 'Current document',
      caption: '',
      scene: JSON.stringify({
        kind: 'single',
        root: { kind: 'root' },
        metadata: { key: 'detail' },
      }),
      initialSnapshotIndex: 0,
      coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
      source: {},
      evidence: [],
      preview: 'data:image/png;base64,AAAA',
      createdAt: 1,
    },
    source: 'user',
    workspaceScope: null,
    workspaceRootPath: '/project',
  });
  const document = {
    schema: 'dnaforge.molecular-document.v2' as const,
    id: '33290000-0000-4000-8000-000000000001',
    name: 'Current document',
    currentReferenceId: snapshot.id,
    history: [{ referenceId: snapshot.id, snapshot: JSON.parse(snapshot.data!) }],
  };
  const documentReference = await molecularDocumentReferenceFor('project-fixture', document);
  const reference = await createEntityReference({
    entityType: 'molecular-document',
    displayLabel: 'Current document',
    locator: molecularDocumentReferenceLocator(documentReference),
    data: documentReference,
    deepLinkParams: null,
    source: 'user',
    workspaceScope: 'project-fixture',
    workspaceRootPath: '/project',
  });
  capture.mockResolvedValue({
    ok: true,
    referenceId: reference.id,
    revisionId: snapshot.id,
    documentReference,
    activeViewReference: { ...documentReference, viewId: 'detail' },
    title: 'Current document',
  });
  resolveDocument.mockImplementation(async (value) => ({
    documentReference: value,
    snapshot: document.history[0].snapshot,
    catalogEntityId: 'project-fixture::' + document.id,
    saved: {
      document,
      path: '/project/view.dnaforge-molecular.json',
      workspaceRoot: '/project',
      revision: 'b'.repeat(64),
    },
  }));
  return { text, snapshot, documentReference };
}

it('attaches the displayed document view with its immutable snapshot and document owner', async () => {
  const { text, snapshot } = await capturedViewFixture();
  const reference = await askAiAboutStructureView({
    structureViewId: 'molecular-document:catalog-1',
    attrs: {
      source: 'file',
      sourceId: text,
      label: 'Current document',
      molViewSpec: JSON.parse(snapshot.data!).scene,
      molecularDocumentId: '33290000-0000-4000-8000-000000000001',
      molecularDocumentRevision: 'a'.repeat(64),
      molecularDocumentSavedReferenceId: snapshot.id,
      molecularDocumentPath: '/project/Molecular views/Current document.molecular.json',
    },
    selection: null,
    workspaceRoot: '/project',
  });
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      structureViewId: 'molecular-document:catalog-1',
    })
  );
  expect(JSON.parse(reference.data!)).toMatchObject({
    kind: 'molecular-document',
    documentId: '33290000-0000-4000-8000-000000000001',
    revisionId: snapshot.id,
  });
  expect(reference.entity_type).toBe('molecular-document');
  expect(picker).toHaveBeenCalledWith(expect.objectContaining({ reference, contextKind: 'view' }));
  const context = await expandReferencesFromIds('Explain the displayed view.', [reference.id]);
  expect(context).toContain(snapshot.id);
  expect(context).toContain('molecular-document');
  expect(context).toContain('33290000-0000-4000-8000-000000000001');
  expect(context).toContain('parameterAccess');
});

it('pins the actual displayed coordinate-source view through the document owner', async () => {
  await capturedViewFixture();
  const reference = await askAiAboutStructureView({
    structureViewId: 'raw-structure-1',
    attrs: { source: 'pdb', sourceId: '1HRC' },
    selection: null,
    workspaceRoot: null,
  });
  expect(reference.entity_type).toBe('molecular-document');
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({ structureViewId: 'raw-structure-1' })
  );
});

it('refuses an incomplete document binding even when its underlying structure is available', async () => {
  await expect(
    askAiAboutStructureView({
      structureViewId: 'molecular-document:catalog-1',
      attrs: {
        source: 'pdb',
        sourceId: '1HRC',
        molecularDocumentPath: '/project/view.molecular.json',
      },
      selection: null,
      workspaceRoot: '/project',
    })
  ).rejects.toThrow(/document.*unavailable/i);
  expect(capture).not.toHaveBeenCalled();
  expect(picker).not.toHaveBeenCalled();
});

it('never falls back to a structure when pinning the displayed view fails', async () => {
  capture.mockResolvedValue({ ok: false, error: 'The displayed view changed during capture.' });
  await expect(
    askAiAboutStructureView({
      structureViewId: 'saved-view:working',
      attrs: { source: 'pdb', sourceId: '1HRC' },
      selection: null,
      workspaceRoot: null,
    })
  ).rejects.toThrow('The displayed view changed during capture.');
  expect(picker).not.toHaveBeenCalled();
});

it('keeps view ownership and a resolvable selection ID together in model context', async () => {
  const { text, snapshot } = await capturedViewFixture();
  const residue = { chain: 'A', position: 1, labelCompId: 'ALA' };
  const reference = await askAiAboutStructureView({
    structureViewId: 'saved-view:working',
    attrs: {
      source: 'file',
      sourceId: text,
      molViewSpec: JSON.parse(snapshot.data!).scene,
      molViewSpecSavedReferenceId: snapshot.id,
    },
    selection: {
      entityType: 'structure',
      displayLabel: 'Alanine A1',
      locator: 'working',
      deepLinkParams: {
        highlightGroups: [
          {
            id: 'selected',
            label: 'Alanine A1',
            selections: [{ chain: 'A', ranges: [[1, 1]] }],
            visible: true,
          },
        ],
      },
      structure: { residues: [residue], visibleRepresentations: [] },
    },
    workspaceRoot: '/project',
  });
  const fence = await expandReferencesFromIds('', [reference.id]);
  const document = new DOMParser().parseFromString(fence, 'application/xml');
  const payload = JSON.parse(document.documentElement.textContent!);
  expect(payload.descriptor.locator.refId).toBe(reference.id);
  expect(payload.documentReference).toMatchObject({ revisionId: snapshot.id, viewId: 'detail' });
  expect(payload.parameterAccess.inspect.input.documentReference).toEqual(
    payload.documentReference
  );
});

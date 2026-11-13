import { userMessage, userMessagePayload } from '@waypoint/user-messages';
import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MolecularPresentationControls } from './MolecularPresentationControls';
import { MolecularViewWorkspace } from './MolecularViewWorkspace';
import type { MolstarPlugin } from '../molstar/cache';
import type { Structure3dAttrs } from '../types';
import type { MolecularView } from '../utils/molecularView';
import { captureMolViewSpecView } from '../molstar/molViewSpec';

const fixture = vi.hoisted(() => {
  const scene = JSON.stringify({
    kind: 'multiple',
    snapshots: [
      { metadata: { title: 'Overview' }, root: { kind: 'root' } },
      { metadata: { title: 'Pocket' }, root: { kind: 'root' } },
    ],
  });
  const view = {
    kind: 'molecular-view',
    version: 1,
    scene,
    title: 'Binding explanation',
    caption: 'Observed contacts',
    coordinates: { format: 'pdb', text: 'coords', sha256: 'a'.repeat(64) },
    source: {},
    evidence: [],
    preview: 'data:image/png;base64,AAAA',
    createdAt: 1,
  };
  const reference = {
    id: '10000000-0000-4000-8000-000000000001',
    entity_type: 'structure',
    display_label: view.title,
    data: JSON.stringify(view),
    locator: 'entity://structure/saved-view:10000000-0000-4000-8000-000000000001',
    status: 'created',
    source: 'user',
    workspace_scope: null,
    workspace_root_path: '/project',
    deep_link_params: null,
    created_at: 1,
    updated_at: 1,
  };
  return {
    scene,
    currentScene: scene,
    authoredScene: undefined as string | undefined,
    currentCoordinates: { format: 'pdb', text: 'coords' },
    currentSnapshotIndex: undefined as number | undefined,
    loaded: true,
    draw: undefined as (() => void) | undefined,
    view,
    reference,
    save: vi.fn(),
    binding: vi.fn(),
    documentReference: {
      kind: 'molecular-document',
      version: 1,
      projectId: 'project',
      documentId: '20000000-0000-4000-8000-000000000001',
      revisionId: reference.id,
      revisionSha256: 'a'.repeat(64),
    },
    read: vi.fn(),
    history: vi.fn(),
    importSnapshot: vi.fn(),
    nativeRead: vi.fn(),
    captureNotebook: vi.fn(),
    navigate: vi.fn(),
    fetchPages: vi.fn(),
    folders: [{ path: '/project', name: 'Project' }],
  };
});
vi.mock('../../../store', () => ({
  usePageStore: Object.assign(
    (select: (state: { pageList: never[] }) => unknown) => select({ pageList: [] }),
    { getState: () => ({ fetchPages: fixture.fetchPages }) }
  ),
}));
vi.mock('../../../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: { folders: { path: string; name: string }[] }) => unknown) =>
    select({ folders: fixture.folders }),
}));
vi.mock('../molstar/molViewSpec', () => ({
  captureMolViewSpecView: vi.fn((_plugin: MolstarPlugin, options?: { cameraPolicy?: string }) => ({
    scene:
      options?.cameraPolicy === 'preserve-authored'
        ? (fixture.authoredScene ?? fixture.currentScene)
        : fixture.currentScene,
    coordinates: fixture.currentCoordinates,
    initialSnapshotIndex: fixture.currentSnapshotIndex,
    pinnedAssets: [],
  })),
  activeMolViewSpecScene: () => fixture.currentScene,
  sameLoadedMolViewSpecScene: () => fixture.loaded,
}));
vi.mock('../utils/molecularPresentation', () => ({
  readMolecularPresentation: fixture.read,
  getMolecularPresentationHistory: fixture.history,
  importMolecularPresentationSnapshot: fixture.importSnapshot,
  samePresentationAppearance: (a: string, b: string) => a === b,
}));
vi.mock('../../../../../platform', () => ({
  platform: () => ({ molecularDocuments: { read: fixture.nativeRead } }),
}));
vi.mock('../store', () => ({
  useStructure3dStore: { getState: () => ({ expandedStructures: {} }) },
}));
vi.mock('../../../../../db/entity-references', () => ({
  getEntityReferenceByLocator: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../agent-bridge/public/structure-tools', () => ({
  handleMolSaveView: fixture.save,
}));
vi.mock('../../../molecular-presentation-notebook', () => ({
  captureMolecularPresentationToNotebook: fixture.captureNotebook,
}));
vi.mock('../../../../ai/public/navigate-to-reference', () => ({
  navigateToReference: fixture.navigate,
}));

vi.mock('../../../../molecular-documents/public/services', () => ({
  inspectMolecularDocumentBinding: fixture.binding,
}));

const documentBinding = {
  molecularDocumentId: '20000000-0000-4000-8000-000000000001',
  molecularDocumentPath: '/project/Binding explanation.molecular.json',
  molecularDocumentRevision: 'b'.repeat(64),
  molecularDocumentSavedReferenceId: fixture.reference.id,
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  fixture.loaded = true;
  vi.mocked(captureMolViewSpecView).mockClear();
  fixture.draw = undefined;
  fixture.currentScene = fixture.scene;
  fixture.authoredScene = undefined;
  fixture.currentCoordinates = { format: 'pdb', text: 'coords' };
  fixture.currentSnapshotIndex = undefined;
  fixture.read.mockReset().mockResolvedValue({ reference: fixture.reference, view: fixture.view });
  fixture.history.mockReset().mockResolvedValue([fixture.reference]);
  fixture.importSnapshot
    .mockReset()
    .mockImplementation(async (id: string, view: MolecularView) => ({
      ...fixture.reference,
      id,
      display_label: view.title,
      data: JSON.stringify(view),
    }));
  fixture.nativeRead.mockReset().mockImplementation(async ({ path, workspaceRoot }) => ({
    path,
    workspaceRoot,
    document: {
      history: (await fixture.history()).map((reference: typeof fixture.reference) => ({
        referenceId: reference.id,
        snapshot: JSON.parse(reference.data),
      })),
    },
  }));
  fixture.binding.mockReset().mockImplementation(async (attrs: Structure3dAttrs) => ({
    documentReference: attrs.molecularDocumentId ? fixture.documentReference : undefined,
  }));
  fixture.save.mockReset().mockResolvedValue({
    ok: true,
    referenceId: fixture.reference.id,
    revisionId: fixture.reference.id,
    documentReference: fixture.documentReference,
    ...documentBinding,
  });
  fixture.captureNotebook
    .mockReset()
    .mockResolvedValue({ reference: { id: 'notebook-reference' } });
  fixture.navigate.mockReset().mockResolvedValue(undefined);
  fixture.fetchPages.mockReset().mockResolvedValue(undefined);
});
function setup(overrides: Partial<Structure3dAttrs> = {}) {
  const onSelect = vi.fn(),
    onRestore = vi.fn();
  const plugin = molstarPluginFixture({
    canvas3d: {
      camera: { stateChanged: { subscribe: () => ({ unsubscribe() {} }) } },
      didDraw: {
        subscribe: (callback: () => void) => {
          fixture.draw = callback;
          return {
            unsubscribe() {
              fixture.draw = undefined;
            },
          };
        },
      },
    },
  });
  const attrs: Structure3dAttrs = {
    source: 'pdb',
    sourceId: '6KX1',
    molViewSpec: fixture.scene,
    molViewSpecSavedReferenceId: fixture.reference.id,
    ...documentBinding,
    ...overrides,
  };
  const controls = (current: Structure3dAttrs) => (
    <MolecularViewWorkspace>
      <MolecularPresentationControls
        structureId="working-structure"
        attrs={current}
        plugin={plugin}
        ready
        onSelect={onSelect}
        onRestore={onRestore}
      />
    </MolecularViewWorkspace>
  );
  const rendered = render(controls(attrs));
  return {
    onSelect,
    onRestore,
    rerenderAttrs: (next: Partial<Structure3dAttrs>) =>
      rendered.rerender(controls({ ...attrs, ...next })),
  };
}
it('disables Save for an unchanged saved document before and after native readback', async () => {
  const read = fixture.nativeRead.getMockImplementation()!;
  let finishRead!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  fixture.nativeRead.mockImplementation(async (input) => {
    await pending;
    return read(input);
  });
  setup();
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled();
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  await act(async () => finishRead());
  await screen.findByRole('button', { name: 'History' });
  expect(save).toBeDisabled();
  act(() => {
    fixture.draw?.();
    fixture.draw?.();
  });
  expect(save).toBeDisabled();
  fireEvent.click(save);
  expect(fixture.save).not.toHaveBeenCalled();
});

it('keeps a newly packaged default view clean until its display changes ', async () => {
  const defaultView = {
    ...fixture.view,
    scene: JSON.stringify({
      kind: 'single',
      root: { kind: 'root', custom: { dnaforge_default_view: true } },
    }),
  };
  const defaultReference = { ...fixture.reference, data: JSON.stringify(defaultView) };
  fixture.read.mockResolvedValue({ reference: defaultReference, view: defaultView });
  fixture.history.mockResolvedValue([defaultReference]);
  fixture.currentScene = JSON.stringify({ kind: 'single', root: { kind: 'root', native: 1 } });
  setup({ molViewSpec: undefined, molViewSpecSavedReferenceId: undefined });
  const save = screen.getByRole('button', { name: 'Save' });
  await waitFor(() => expect(fixture.nativeRead).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  vi.mocked(captureMolViewSpecView).mockClear();
  await act(async () => {
    fixture.draw?.();
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  expect(vi.mocked(captureMolViewSpecView)).toHaveBeenCalled();
  expect(save).toBeDisabled();
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  fixture.currentScene = JSON.stringify({ kind: 'single', root: { kind: 'root', native: 2 } });
  await act(async () => {
    fixture.draw?.();
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  await screen.findByText('Unsaved changes');
  expect(save).toBeEnabled();
});

it('keeps the toolbar steady while it refreshes its saved revision', async () => {
  const { rerenderAttrs } = setup();
  const history = await screen.findByRole('button', { name: 'History' });
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
  const read = fixture.nativeRead.getMockImplementation()!;
  let finishRead!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  fixture.nativeRead.mockImplementation(async (input) => {
    await pending;
    return read(input);
  });
  const revisionId = '10000000-0000-4000-8000-000000000009';
  fixture.history.mockResolvedValue([fixture.reference, { ...fixture.reference, id: revisionId }]);
  rerenderAttrs({
    molViewSpecSavedReferenceId: revisionId,
    molecularDocumentSavedReferenceId: revisionId,
    molecularDocumentRevision: 'c'.repeat(64),
  });
  expect(screen.getByRole('button', { name: 'History' })).toBe(history);
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await act(async () => finishRead());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  expect(screen.getByRole('button', { name: 'History' })).toBe(history);
  expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
});

it('saves one changed document and prevents another unchanged save', async () => {
  fixture.currentScene = 'changed native appearance';
  const changed = { ...fixture.view, scene: fixture.currentScene };
  const revisionId = '10000000-0000-4000-8000-000000000009';
  let finishSave!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  fixture.save.mockImplementation(async () => {
    await pending;
    fixture.history.mockResolvedValue([
      fixture.reference,
      { ...fixture.reference, id: revisionId, data: JSON.stringify(changed) },
    ]);
    return { ok: true, revisionId, ...documentBinding };
  });
  setup();
  const history = await screen.findByRole('button', { name: 'History' });
  const save = screen.getByRole('button', { name: 'Save' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
  expect(save).toBeDisabled();
  expect(save).toHaveTextContent('Save');
  fireEvent.click(save);
  expect(fixture.save).toHaveBeenCalledOnce();
  await act(async () => finishSave());
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
  expect(save).toBeDisabled();
  expect(screen.getByRole('button', { name: 'History' })).toBe(history);
  fireEvent.click(save);
  expect(fixture.save).toHaveBeenCalledOnce();
});

it('enables Save for retained data edits even when protein colors are unchanged', async () => {
  const { rerenderAttrs } = setup();
  await screen.findByRole('button', { name: 'History' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  rerenderAttrs({
    molecularData: {
      version: 1,
      datasets: [
        {
          id: 'new-data',
          name: 'New measurements',
          revision: 'd'.repeat(64),
          source: { label: 'Imported table' },
          records: [{ residue: 108, value: 0.5 }],
        },
      ],
      mappings: [],
      layers: [],
    },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  rerenderAttrs({ molecularData: undefined });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  expect(fixture.save).not.toHaveBeenCalled();
});

it('switches named perspectives without creating a revision', async () => {
  const { onSelect } = setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByRole('button', { name: 'Browse 2 views' }));
  fireEvent.click(screen.getByRole('option', { name: /Pocket/ }));
  expect(onSelect).toHaveBeenCalledWith(1);
  expect(fixture.save).not.toHaveBeenCalled();
});
it('groups Notebook, History and Save with unsaved text immediately after Save', async () => {
  fixture.currentScene = 'changed native appearance';
  setup();
  await screen.findByRole('button', { name: 'History' });
  const buttons = within(screen.getByTestId('molecular-presentation-controls')).getAllByRole(
    'button'
  );
  expect(buttons.map((button) => button.textContent)).toEqual(['Notebook', 'History', 'Save']);
  expect(screen.getByTestId('presentation-save').nextElementSibling).toBe(
    screen.getByTestId('presentation-save-state')
  );
});
it('saves the project document with one click and no metadata form', async () => {
  fixture.currentScene = 'changed native appearance';
  fixture.save.mockImplementation(async () => {
    fixture.history.mockResolvedValue([
      {
        ...fixture.reference,
        data: JSON.stringify({ ...fixture.view, scene: fixture.currentScene }),
      },
    ]);
    return { ok: true, revisionId: fixture.reference.id, ...documentBinding };
  });
  setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByTestId('presentation-save'));
  await waitFor(() =>
    expect(fixture.save).toHaveBeenCalledWith(
      {
        structureViewId: 'working-structure',
        title: 'Binding explanation',
        caption: 'Observed contacts',
        evidence: [],
        saveToProject: true,
      },
      { cameraPolicy: 'preserve-authored' }
    )
  );
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByText('Save as a separate presentation')).not.toBeInTheDocument();
  expect(fixture.captureNotebook).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
});

it('rejects saving a legacy snapshot without verified document ownership', async () => {
  fixture.save.mockResolvedValue({
    ok: false,
    code: 'DOCUMENT_OWNER_REQUIRED',
    userMessagePayload: userMessagePayload('molecular.documentUnlinked'),
    error:
      'Reopen this legacy result through its verified molecular document reference before editing or saving it.',
  });
  setup({
    molecularDocumentId: undefined,
    molecularDocumentPath: undefined,
    molecularDocumentRevision: undefined,
    molecularDocumentSavedReferenceId: undefined,
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    userMessage('molecular.documentUnlinked')
  );
  expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Unsaved changes'
  );
  fireEvent.click(screen.getByTestId('presentation-save'));
  await waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
  expect(await screen.findByRole('alert')).toHaveTextContent(
    userMessage('molecular.documentUnlinked')
  );
  expect(fixture.nativeRead).not.toHaveBeenCalled();
  expect(fixture.captureNotebook).not.toHaveBeenCalled();
});

it('keeps a legacy unbound result unsaved through an authored scene change', async () => {
  setup({
    molecularDocumentId: undefined,
    molecularDocumentPath: undefined,
    molecularDocumentRevision: undefined,
    molecularDocumentSavedReferenceId: undefined,
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    userMessage('molecular.documentUnlinked')
  );
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Unsaved changes'
  );
  fixture.currentScene = 'explicit authored framing change';
  fixture.draw?.();
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Unsaved changes'
    )
  );
  expect(fixture.save).not.toHaveBeenCalled();
});

it('keeps exploratory framing clean and disables redundant Save', async () => {
  fixture.authoredScene = fixture.scene;
  fixture.currentScene = 'exploratory camera position';
  setup();
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
  expect(screen.queryByTestId('presentation-save-state')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(fixture.save).not.toHaveBeenCalled();
});

it('does not ask to discard exploratory framing when restoring a saved view', async () => {
  fixture.authoredScene = fixture.scene;
  fixture.currentScene = 'exploratory camera position';
  const { onRestore } = setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByTestId('presentation-history'));
  fireEvent.click(screen.getByTestId('presentation-restore'));
  expect(onRestore).toHaveBeenCalledWith(fixture.reference, fixture.view);
  expect(screen.queryByTestId('presentation-confirm-restore')).not.toBeInTheDocument();
});

it('lists history as continuous revision rows with Restore beside each revision', async () => {
  fixture.history.mockResolvedValue([
    fixture.reference,
    { ...fixture.reference, id: '10000000-0000-4000-8000-000000000007' },
  ]);
  setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByTestId('presentation-history'));
  const history = screen.getByRole('list', { name: 'Saved revisions' });
  const rows = within(history).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row).toHaveAttribute('data-reference-id');
    expect(within(row).getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(row.className).not.toMatch(/\brounded\b|\bborder\b/);
  }
});

it('rejects an unbound copied notebook snapshot instead of promoting its cache to document authority', async () => {
  setup({
    molecularDocumentId: undefined,
    molecularDocumentPath: undefined,
    molecularDocumentRevision: undefined,
    molecularDocumentSavedReferenceId: undefined,
    molecularViewSnapshot: fixture.view as MolecularView,
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    userMessage('molecular.documentUnlinked')
  );
  expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
  expect(fixture.importSnapshot).not.toHaveBeenCalled();
  expect(fixture.read).not.toHaveBeenCalled();
  expect(fixture.nativeRead).not.toHaveBeenCalled();
});

it('shows only the bound native file history instead of another copied project branch', async () => {
  const previousId = '10000000-0000-4000-8000-000000000005';
  const previousView = { ...fixture.view, title: 'Original in this file' };
  fixture.history.mockResolvedValue([
    { ...fixture.reference, display_label: 'Other project branch' },
  ]);
  fixture.nativeRead.mockResolvedValue({
    workspaceRoot: '/copied-project',
    document: {
      history: [
        { referenceId: previousId, snapshot: previousView },
        { referenceId: fixture.reference.id, snapshot: fixture.view },
      ],
    },
  });
  setup({ molecularDocumentPath: '/copied-project/analysis.dnaforge-molecular.json' });
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  expect(await screen.findByText('Original in this file')).toBeInTheDocument();
  expect(screen.queryByText('Other project branch')).not.toBeInTheDocument();
  expect(fixture.nativeRead).toHaveBeenCalledWith({
    path: '/copied-project/analysis.dnaforge-molecular.json',
    workspaceRoot: '/copied-project',
  });
  expect(fixture.importSnapshot).not.toHaveBeenCalled();
  expect(fixture.history).not.toHaveBeenCalled();
});

it('shows a projection warning after a successful native Save and keeps the document saved', async () => {
  const warning = 'The document was saved. Its Registry entry needs to be refreshed.';
  fixture.currentScene = 'changed native appearance';
  fixture.save.mockImplementation(async () => {
    fixture.history.mockResolvedValue([
      {
        ...fixture.reference,
        data: JSON.stringify({ ...fixture.view, scene: fixture.currentScene }),
      },
    ]);
    return {
      ok: true,
      referenceId: fixture.reference.id,
      revisionId: fixture.reference.id,
      documentReference: fixture.documentReference,
      ...documentBinding,
      warning,
    };
  });
  setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByTestId('presentation-save-warning')).toHaveTextContent(warning);
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Saved'
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(fixture.save).toHaveBeenCalledOnce();
});

it('compares project save state with its head instead of a newer chat result', async () => {
  const chatReferenceId = '10000000-0000-4000-8000-000000000002';
  const changed = { ...fixture.view, scene: 'newer chat scene' };
  fixture.currentScene = changed.scene;
  fixture.history.mockResolvedValue([
    fixture.reference,
    { ...fixture.reference, id: chatReferenceId, data: JSON.stringify(changed) },
  ]);
  setup({ molViewSpecSavedReferenceId: chatReferenceId, molViewSpec: changed.scene });
  await screen.findByRole('button', { name: 'History' });
  await waitFor(() => expect(fixture.nativeRead).toHaveBeenCalled());
  expect(fixture.read).not.toHaveBeenCalled();
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Unsaved changes'
  );
});

it('keeps an unknown bound project head and an unbound legacy result unsaved', async () => {
  const chatReferenceId = '10000000-0000-4000-8000-000000000002';
  fixture.history.mockResolvedValue([{ ...fixture.reference, id: chatReferenceId }]);
  const { rerenderAttrs } = setup({ molViewSpecSavedReferenceId: chatReferenceId });
  await screen.findByRole('button', { name: 'History' });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'requested molecular document revision is unavailable'
  );
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Unsaved changes'
  );
  rerenderAttrs({
    molViewSpecSavedReferenceId: chatReferenceId,
    molecularDocumentId: undefined,
    molecularDocumentPath: undefined,
    molecularDocumentRevision: undefined,
    molecularDocumentSavedReferenceId: undefined,
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    userMessage('molecular.documentUnlinked')
  );
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Unsaved changes'
  );
});

it('captures the current unsaved view directly in a requested notebook', async () => {
  fixture.currentScene = 'changed native appearance';
  setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByTestId('presentation-notebook'));
  fireEvent.click(screen.getByRole('button', { name: 'Record and open notebook' }));
  await waitFor(() => expect(fixture.captureNotebook).toHaveBeenCalled());
  expect(fixture.save).toHaveBeenCalledWith({
    structureViewId: 'working-structure',
    title: 'Binding explanation',
    caption: 'Observed contacts',
    evidence: [],
  });
  expect(fixture.captureNotebook).toHaveBeenCalledWith(fixture.reference.id, {
    documentReference: fixture.documentReference,
    newNotebookTitle: 'Binding explanation notes',
    workspaceRoot: '/project',
  });
  expect(fixture.navigate).toHaveBeenCalledWith({ id: 'notebook-reference' });
});

it('captures a camera move before the debounced save status has updated', async () => {
  fixture.authoredScene = fixture.scene;
  setup();
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
  fireEvent.click(screen.getByRole('button', { name: 'Notebook' }));
  fixture.currentScene = 'camera moved just before capture';
  fireEvent.click(screen.getByRole('button', { name: 'Record and open notebook' }));
  await waitFor(() => expect(fixture.captureNotebook).toHaveBeenCalled());
  expect(fixture.save).toHaveBeenCalledOnce();
  expect(fixture.save.mock.calls[0]?.[0]).not.toHaveProperty('saveToProject');
  expect(fixture.save.mock.calls[0]?.[1]).toBeUndefined();
});

it('records an unchanged document in a notebook without creating another revision', async () => {
  setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByRole('button', { name: 'Notebook' }));
  fireEvent.click(screen.getByRole('button', { name: 'Record and open notebook' }));
  await waitFor(() => expect(fixture.captureNotebook).toHaveBeenCalled());
  expect(fixture.save).not.toHaveBeenCalled();
  expect(fixture.captureNotebook).toHaveBeenCalledWith(
    fixture.reference.id,
    expect.objectContaining({ documentReference: fixture.documentReference })
  );
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Saved'
  );
});

it('captures the selected named view for a notebook without treating navigation as a document edit', async () => {
  const { rerenderAttrs } = setup();
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
  fixture.currentSnapshotIndex = 1;
  rerenderAttrs({ molViewSpecSnapshotIndex: 1 });
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Saved'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Notebook' }));
  fireEvent.click(screen.getByRole('button', { name: 'Record and open notebook' }));
  await waitFor(() => expect(fixture.captureNotebook).toHaveBeenCalled());
  expect(fixture.save).toHaveBeenCalledOnce();
  expect(fixture.save.mock.calls[0]?.[0]).not.toHaveProperty('saveToProject');
});

it('keeps changed coordinate bytes unsaved even when the scene description is unchanged', async () => {
  fixture.currentCoordinates = { format: 'pdb', text: 'different coordinates' };
  setup();
  await screen.findByRole('button', { name: 'History' });
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Unsaved changes'
  );
});

it('offers Save and Notebook on an ordinary raw structure without a prior scene snapshot', async () => {
  setup({
    label: '6KX1',
    molViewSpec: undefined,
    molViewSpecSavedReferenceId: undefined,
    molecularDocumentId: undefined,
    molecularDocumentPath: undefined,
    molecularDocumentRevision: undefined,
    molecularDocumentSavedReferenceId: undefined,
  });
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Notebook' }));
  fireEvent.click(screen.getByRole('button', { name: 'Record and open notebook' }));
  await waitFor(() => expect(fixture.captureNotebook).toHaveBeenCalled());
  expect(fixture.save).toHaveBeenCalledWith({
    structureViewId: 'working-structure',
    title: '6KX1',
    caption: '',
    evidence: [],
  });
});

it('keeps unsaved state and shows the precise native project failure', async () => {
  fixture.save.mockResolvedValue({
    ok: false,
    error: 'Open a writable project before saving.',
    userMessagePayload: userMessagePayload('molecular.projectRequired'),
  });
  fixture.currentScene = 'changed native appearance';
  setup();
  await screen.findByRole('button', { name: 'History' });
  fireEvent.click(screen.getByTestId('presentation-save'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Open a writable project before saving.'
  );
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Unsaved changes'
  );
  expect(fixture.captureNotebook).not.toHaveBeenCalled();
});
it('requires an explicit restore choice before replacing unsaved working edits', async () => {
  fixture.currentScene = 'changed native appearance';
  const { onRestore } = setup();
  await screen.findByRole('button', { name: 'History' });
  await waitFor(() =>
    expect(screen.getByTestId('presentation-save-state').textContent).toBe('Unsaved changes')
  );
  fireEvent.click(screen.getByTestId('presentation-history'));
  fireEvent.click(screen.getByTestId('presentation-restore'));
  expect(onRestore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('presentation-confirm-restore'));
  expect(onRestore).toHaveBeenCalledWith(fixture.reference, fixture.view);
});

it('requires document ownership before exposing history restoration for a retained result', async () => {
  const { onRestore } = setup({
    molecularDocumentId: undefined,
    molecularDocumentPath: undefined,
    molecularDocumentRevision: undefined,
    molecularDocumentSavedReferenceId: undefined,
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    userMessage('molecular.documentUnlinked')
  );
  expect(screen.queryByTestId('presentation-history')).not.toBeInTheDocument();
  expect(onRestore).not.toHaveBeenCalled();
});

it('restores a historical version as a draft and saves it with the ordinary Save action', async () => {
  const oldReferenceId = '10000000-0000-4000-8000-000000000003';
  const savedReferenceId = '10000000-0000-4000-8000-000000000004';
  const oldView = { ...fixture.view, scene: 'historical camera' };
  const oldReference = {
    ...fixture.reference,
    id: oldReferenceId,
    locator: `entity://structure/saved-view:${oldReferenceId}`,
    data: JSON.stringify(oldView),
  };
  fixture.history.mockResolvedValue([oldReference, fixture.reference]);
  fixture.read.mockImplementation(async (id: string) => ({
    reference: id === oldReferenceId ? oldReference : { ...fixture.reference, id },
    view: id === fixture.reference.id ? fixture.view : oldView,
  }));
  const { onRestore, rerenderAttrs } = setup();
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
  fireEvent.click(screen.getByTestId('presentation-history'));
  fireEvent.click(screen.getAllByTestId('presentation-restore')[1]!);
  expect(onRestore).toHaveBeenCalledWith(oldReference, oldView);
  expect(fixture.save).not.toHaveBeenCalled();
  fixture.currentScene = oldView.scene;
  rerenderAttrs({ molViewSpec: oldView.scene, molViewSpecSavedReferenceId: oldReferenceId });
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Unsaved changes'
    )
  );
  fixture.save.mockImplementation(async () => {
    fixture.history.mockResolvedValue([
      oldReference,
      fixture.reference,
      { ...oldReference, id: savedReferenceId },
    ]);
    return {
      ok: true,
      referenceId: savedReferenceId,
      revisionId: savedReferenceId,
      documentReference: { ...fixture.documentReference, revisionId: savedReferenceId },
      ...documentBinding,
    };
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
  expect(fixture.save.mock.calls[0]?.[0]).toMatchObject({ saveToProject: true });
  expect(fixture.save.mock.calls[0]?.[0]).not.toHaveProperty('newPresentation');
  await waitFor(() =>
    expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
      'data-save-state',
      'Saved'
    )
  );
});

it('waits for the restored scene and selected view before enabling Save or Notebook capture', async () => {
  const { rerenderAttrs } = setup();
  await screen.findByRole('button', { name: 'History' });
  await waitFor(() => expect(screen.getByTestId('presentation-notebook')).toBeEnabled());
  expect(screen.getByTestId('presentation-save')).toBeDisabled();
  const restored = JSON.parse(fixture.scene);
  restored.snapshots[1].metadata.title = 'Restored detail';
  const scene = JSON.stringify(restored);
  fixture.loaded = false;
  rerenderAttrs({ molViewSpec: scene, molViewSpecSnapshotIndex: 1 });
  expect(screen.getByTestId('presentation-save')).toBeDisabled();
  expect(screen.getByTestId('presentation-notebook')).toBeDisabled();
  fireEvent.click(screen.getByTestId('presentation-save'));
  fireEvent.click(screen.getByTestId('presentation-notebook'));
  expect(fixture.save).not.toHaveBeenCalled();
  expect(fixture.captureNotebook).not.toHaveBeenCalled();
  expect(screen.queryByTestId('presentation-confirm-notebook')).not.toBeInTheDocument();

  fixture.loaded = true;
  fixture.currentScene = scene;
  fixture.currentSnapshotIndex = 0;
  const captures = vi.mocked(captureMolViewSpecView).mock.calls.length;
  fixture.draw?.();
  await waitFor(() =>
    expect(vi.mocked(captureMolViewSpecView).mock.calls.length).toBeGreaterThan(captures)
  );
  expect(screen.getByTestId('presentation-save')).toBeDisabled();
  expect(screen.getByTestId('presentation-notebook')).toBeDisabled();

  fixture.currentSnapshotIndex = 1;
  fixture.draw?.();
  await waitFor(() => expect(screen.getByTestId('presentation-save')).toBeEnabled());
  expect(screen.getByTestId('presentation-notebook')).toBeEnabled();
  fireEvent.click(screen.getByTestId('presentation-save'));
  await waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
});

it('keeps an unchanged saved document clean while native replay completes', async () => {
  fixture.loaded = false;
  setup();
  await screen.findByRole('button', { name: 'History' });
  expect(screen.queryByTestId('presentation-save-state')).not.toBeInTheDocument();
  expect(screen.getByTestId('presentation-save')).toBeDisabled();
  fixture.loaded = true;
  fixture.draw?.();
  await waitFor(() =>
    expect(screen.queryByTestId('presentation-save-state')).not.toBeInTheDocument()
  );
  expect(screen.getByTestId('molecular-presentation-controls')).toHaveAttribute(
    'data-save-state',
    'Saved'
  );
});

it('rechecks appearance when a later native frame finishes restoring the camera', async () => {
  fixture.currentScene = 'old camera still transitioning';
  setup();
  await screen.findByRole('button', { name: 'History' });
  await waitFor(() =>
    expect(screen.getByTestId('presentation-save-state').textContent).toBe('Unsaved changes')
  );
  fixture.currentScene = fixture.scene;
  fixture.draw?.();
  await waitFor(() =>
    expect(screen.queryByTestId('presentation-save-state')).not.toBeInTheDocument()
  );
});

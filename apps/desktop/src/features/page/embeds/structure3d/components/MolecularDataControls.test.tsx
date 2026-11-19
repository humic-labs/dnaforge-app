import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Structure3dAttrs } from '../types';
import { MolecularDataControls } from './MolecularDataControls';

const commands = vi.hoisted(() => ({ data: vi.fn(), save: vi.fn(), scene: vi.fn(), apply: vi.fn() }));
vi.mock('../../../../agent-bridge/structure-tools', () => ({
  handleMolData: commands.data,
  handleMolSaveView: commands.save,
  handleMolGetScene: commands.scene,
  handleMolApplyScene: commands.apply,
}));

const dataRevision = 'a'.repeat(64),
  mappingRevision = 'b'.repeat(64);
function attrs(categorical = false): Structure3dAttrs {
  return {
    source: 'file',
    sourceId: 'coordinates',
    molViewSpec: '{"kind":"single"}',
    molecularData: {
      version: 1,
      activeLayerId: 'external-view',
      datasets: [
        {
          id: 'external-data',
          name: 'Python data',
          revision: dataRevision,
          source: { label: 'Python' },
          records: [{ chain: 'A', value: 0.5, category: 'rna', condition: 'selected' }],
        },
      ],
      mappings: [
        {
          datasetId: 'external-data',
          dataRevision,
          revision: mappingRevision,
          coordinateSha256: 'c'.repeat(64),
          targets: [{ row: 0, selector: { label_asym_id: 'A' } }],
          unresolved: [],
        },
      ],
      layers: [
        {
          id: 'external-view',
          name: 'Custom agent colors',
          datasetId: 'external-data',
          dataRevision,
          mappingRevision,
          column: categorical ? 'category' : 'value',
          units: 'custom units',
          filter: { column: 'condition', equals: 'selected' },
          style: categorical
            ? { kind: 'categorical', colors: { rna: '#123456' }, missingColor: '#abcdef' }
            : {
                kind: 'continuous',
                domain: [-1, 1],
                colors: ['#0000ff', '#ffffff', '#ff0000'],
                missingColor: '#abcdef',
                transform: 'linear',
              },
        },
      ],
    },
  };
}

describe('human molecular data controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commands.data.mockResolvedValue({
      ok: true,
      coordinateSha256: 'c'.repeat(64),
      dataRevision,
      mappingRevision,
      unresolved: [],
    });
  });

  it('exports and applies the starter scene when preparing a data view', async () => {
    const scene = '{"kind":"single","root":{"kind":"root"}}';
    commands.scene.mockResolvedValue({ ok: true, scene });
    commands.apply.mockResolvedValue({ ok: true, rendered: true });
    render(
      <MolecularDataControls
        structureViewId="view"
        attrs={{ source: 'file', sourceId: 'coordinates' }}
        ready
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Prepare data view' }));
    await waitFor(() => expect(commands.apply).toHaveBeenCalledWith({ structureViewId: 'view', scene }));
    expect(commands.scene).toHaveBeenCalledWith({ structureViewId: 'view', includeScene: true });
  });

  it('keeps the working view compact and preserves custom agent colors when making a variation', async () => {
    render(<MolecularDataControls structureViewId="view" attrs={attrs()} ready />);
    expect(screen.queryByLabelText('Data column')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit view' }));
    expect(screen.getByLabelText('Data palette')).toHaveValue('custom');
    fireEvent.click(screen.getByRole('button', { name: 'New variation' }));
    await waitFor(() => expect(commands.data).toHaveBeenCalled());
    const layer = commands.data.mock.calls[0][0].layer;
    expect(layer.id).not.toBe('external-view');
    expect(layer.style).toEqual(attrs().molecularData!.layers[0].style);
    expect(layer.filter).toEqual({ column: 'condition', equals: 'selected' });
    expect(layer.units).toBe('custom units');
  });

  it('retains the saved document action after the viewer remounts with its owner binding', () => {
    const reference = {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'workspace-project',
      documentId: 'f5015cbf-97bd-4abf-a553-cc679a883c82',
      revisionId: 'f5015cbf-97bd-4abf-a553-cc679a883c83',
      revisionSha256: 'd'.repeat(64),
    };
    render(
      <MolecularDataControls
        structureViewId="saved-document"
        attrs={{
          ...attrs(),
          molecularDocumentId: reference.documentId,
          molecularDocumentPath: '/project/view.dnaforge-molecular.json',
          molecularDocumentRevision: 'e'.repeat(64),
          molecularDocumentSavedReferenceId: reference.revisionId,
          molecularDocumentProjectId: reference.projectId,
          molecularDocumentReference: reference,
        }}
        ready
      />
    );
    const action = screen.getByTestId('open-saved-data-view');
    expect(action).toBeEnabled();
    expect(action).toHaveAttribute('data-document-reference', JSON.stringify(reference));
  });

  it('saves through the owning document after an agent save changes the viewer binding', async () => {
    const reference = {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'workspace-project',
      documentId: 'f5015cbf-97bd-4abf-a553-cc679a883c82',
      revisionId: 'f5015cbf-97bd-4abf-a553-cc679a883c83',
      revisionSha256: 'd'.repeat(64),
    };
    commands.save.mockResolvedValue({ ok: true, documentReference: reference });
    render(
      <MolecularDataControls
        structureViewId="viewer-before-document-adoption"
        attrs={{ ...attrs(), molecularDocumentReference: reference }}
        ready
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save data view', exact: true }));
    fireEvent.change(screen.getByLabelText('Saved data view title'), {
      target: { value: 'Human saved Python data' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save view', exact: true }));
    await waitFor(() =>
      expect(commands.save).toHaveBeenCalledWith({
        documentReference: reference,
        title: 'Human saved Python data',
        caption: 'Custom agent colors',
        evidence: [],
      })
    );
    expect(screen.queryByLabelText('Saved data view title')).toBeNull();
    expect(screen.getByTestId('open-saved-data-view')).toBeEnabled();
  });

  it('shows categorical colors without numeric scale controls and retains the supplied dictionary', async () => {
    render(<MolecularDataControls structureViewId="view" attrs={attrs(true)} ready />);
    expect(screen.getByTestId('molecular-data-legend')).toHaveTextContent('rna');
    fireEvent.click(screen.getByRole('button', { name: 'Edit view' }));
    expect(screen.queryByLabelText('Color minimum')).toBeNull();
    expect(screen.queryByText('Log scale')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New variation' }));
    await waitFor(() => expect(commands.data).toHaveBeenCalled());
    expect(commands.data.mock.calls[0][0].layer.style).toEqual(
      attrs(true).molecularData!.layers[0].style
    );
  });

  it('imports an agent publication containing an ordinary table, retaining its bytes and explicit mapping', async () => {
    render(
      <MolecularDataControls
        structureViewId="view"
        attrs={{ source: 'file', sourceId: 'coordinates', molViewSpec: '{"kind":"single"}' }}
        ready
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import data' }));
    const publication = {
      id: 'json-table',
      name: 'Agent table',
      source: { label: 'Python' },
      table: { format: 'csv', text: 'chain,value\nA,1\n' },
      mapping: { coordinateSha256: 'c'.repeat(64), selectorColumns: { label_asym_id: 'chain' } },
    };
    const file = new File([JSON.stringify(publication)], 'results.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(publication) });
    fireEvent.change(screen.getByLabelText('Molecular data file'), { target: { files: [file] } });
    const publish = await screen.findByRole('button', { name: 'Publish data' });
    fireEvent.click(publish);
    await waitFor(() =>
      expect(commands.data).toHaveBeenCalledWith({
        operation: 'publish',
        structureViewId: 'view',
        publication,
      })
    );
  });
});

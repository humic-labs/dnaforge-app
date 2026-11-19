import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DBEntityReference } from '../../db/entity-references';
import { ReferenceChip } from './ReferenceChip';
import { FilePill } from './FilePill';
import {
  molecularDocumentReferenceLocator,
  molecularDocumentReferenceRecord,
} from '../../shared/molecular-document-reference';

vi.mock('../../features/primers/primer-references', () => ({
  getCanonicalOligoEntity: async () => ({ id: 'oligo-rna', kind: 'rna_oligo' }),
}));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});

function structureReference(
  data: Record<string, unknown> | null,
  overrides: Partial<DBEntityReference> = {}
): DBEntityReference {
  return {
    id: 'ref-structure',
    entity_type: 'structure',
    display_label: '3OAA catalytic residues',
    locator: 'entity://structure/PDB:3OAA',
    deep_link_params: null,
    data: data ? JSON.stringify(data) : null,
    source: 'ai',
    status: 'created',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const CANONICAL_DESCRIPTOR = {
  schemaVersion: 2,
  kind: 'structure',
  measured: {
    residueCount: 3,
    residueOmittedCount: 0,
    residues: [
      {
        chain: 'A',
        authSeqId: 57,
        labelCompId: 'HIS',
        oneLetterCode: 'H',
        identityStatus: 'known',
      },
      {
        chain: 'A',
        authSeqId: 102,
        labelCompId: 'ASP',
        oneLetterCode: 'D',
        identityStatus: 'known',
      },
      {
        chain: 'A',
        authSeqId: 195,
        labelCompId: null,
        oneLetterCode: null,
        identityStatus: 'unknown',
      },
    ],
  },
};

describe('ReferenceChip', () => {
  it('colors a legacy canonical RNA primer reference from its current owner', async () => {
    const reference = structureReference(null, {
      id: 'legacy-rna-ref',
      entity_type: 'primer',
      locator: 'entity://primer/oligo-rna',
      display_label: 'Saved oligo',
      data: JSON.stringify({ registryEntityId: 'oligo-rna', localOnly: true }),
    });
    const original = structuredClone(reference);
    const { container } = render(<ReferenceChip reference={reference} inline />);
    await waitFor(() =>
      expect(container.querySelector('.entity-reference-chip__icon svg')).toHaveAttribute(
        'data-entity-color-family',
        'rna'
      )
    );
    expect(reference).toEqual(original);
  });

  it('exposes the exact native named-view target independently of its presentation id', () => {
    const document = {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'project-a',
      documentId: 'b5b7a4d4-9908-4925-befd-c0198e503645',
      revisionId: 'b5b7a4d4-9908-4925-befd-c0198e503646',
      revisionSha256: 'a'.repeat(64),
      viewId: 'view:read-fractions',
    };
    const reference = molecularDocumentReferenceRecord(document, 'Read fractions');
    const onClick = vi.fn();
    const { rerender } = render(<ReferenceChip reference={reference} inline onClick={onClick} />);
    const object = screen.getByTestId(`ref-object-${reference.id}`);
    expect(object).toHaveAttribute('data-molecular-document-reference', JSON.stringify(document));
    expect(object).toHaveAttribute(
      'data-molecular-document-locator',
      molecularDocumentReferenceLocator(document)
    );
    fireEvent.click(screen.getByTestId(`ref-chip-${reference.id}`));
    expect(onClick).toHaveBeenCalledWith(reference);
    rerender(
      <ReferenceChip
        reference={{ ...reference, locator: 'entity://structure/wrong-type' }}
        inline
        onClick={onClick}
      />
    );
    expect(object).not.toHaveAttribute('data-molecular-document-reference');
    expect(object).not.toHaveAttribute('data-molecular-document-locator');
  });

  const savedViewReference = structureReference(
    {
      kind: 'molecular-view',
      version: 1,
      title: 'ABL1–imatinib binding pocket',
      caption: 'The saved ligand pocket with its original camera.',
      scene: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
      cameraSnapshot: '{}',
      coordinates: { format: 'pdb', text: 'HEADER    saved view', sha256: '0'.repeat(64) },
      source: { source: 'pdb', sourceId: '1IEP' },
      preview: 'data:image/png;base64,iVBORw0KGgo=',
      evidence: [{ title: 'Structure evidence', url: 'https://www.rcsb.org/structure/1IEP' }],
      createdAt: 1,
    },
    {
      id: 'ref-saved-view',
      display_label: 'ABL1–imatinib binding pocket',
      locator: 'entity://structure/saved-view:abl1',
    }
  );

  it('embeds one saved structure preview with an explicit click-through to its exact reference', () => {
    const onClick = vi.fn();
    render(<ReferenceChip reference={savedViewReference} onClick={onClick} phase="sent" />);

    const card = screen.getByTestId('molecular-view-ref-saved-view');
    const open = within(card).getByRole('button', {
      name: 'Open saved view: ABL1–imatinib binding pocket',
    });
    const preview = within(card).getByRole('img', {
      name: 'Saved molecular view: ABL1–imatinib binding pocket',
    });
    expect(preview).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(open).toHaveTextContent('Open in 3D');
    expect(open).not.toContainElement(preview);
    expect(screen.queryByTestId('ref-chip-ref-saved-view')).not.toBeInTheDocument();

    fireEvent.click(preview);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(savedViewReference);
    expect(within(card).getAllByRole('img')).toHaveLength(1);
  });

  it('identifies an inline visualization and omits a redundant Target action', () => {
    const onClick = vi.fn();
    const onTarget = vi.fn();
    render(
      <p>
        Inspect{' '}
        <ReferenceChip
          reference={savedViewReference}
          inline
          onClick={onClick}
          onTarget={onTarget}
        />{' '}
        here.
      </p>
    );
    expect(screen.queryByTestId('molecular-view-ref-saved-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ref-chip-ref-saved-view'));
    expect(onClick).toHaveBeenCalledWith(savedViewReference);
    expect(screen.getByText('View')).toBeVisible();
    expect(
      screen.getByTestId('ref-chip-ref-saved-view').querySelector('[data-file-type-icon]')
    ).toHaveAttribute('data-file-type-icon', 'molecular-document');
    expect(screen.queryByRole('button', { name: /Target/ })).toBeNull();
    expect(onTarget).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a pinned view from its named selection without changing their references', () => {
    const data = {
      kind: 'molecular-view-target',
      version: 1,
      viewReferenceId: '10000000-0000-4000-8000-000000000001',
      snapshotIndex: 1,
    };
    const onClick = vi.fn(),
      onTarget = vi.fn();
    const ref = structureReference(data, {
      locator: `entity://molecular-view-target/${data.viewReferenceId}/1/view`,
    });
    const { rerender } = render(
      <ReferenceChip reference={ref} inline onClick={onClick} onTarget={onTarget} />
    );
    expect(screen.getByText('View')).toBeVisible();
    expect(
      screen.getByTestId('ref-chip-ref-structure').querySelector('[data-file-type-icon]')
    ).toHaveAttribute('data-file-type-icon', 'molecular-document');
    expect(screen.queryByRole('button', { name: /Target/ })).toBeNull();
    fireEvent.click(screen.getByTestId('ref-chip-ref-structure'));
    expect(onClick).toHaveBeenCalledWith(ref);
    const selection = structureReference(
      { ...data, groupId: 'peptide' },
      {
        locator: `entity://molecular-view-target/${data.viewReferenceId}/1/peptide`,
      }
    );
    rerender(<ReferenceChip reference={selection} inline onTarget={onTarget} />);
    expect(screen.getByText('Selection')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Target 3OAA catalytic residues' }));
    expect(onTarget).toHaveBeenCalledWith(selection);
  });

  it('offers Target for an inline structure selection and disables it when unresolved', () => {
    const onTarget = vi.fn();
    const ref = structureReference({
      ...CANONICAL_DESCRIPTOR,
      measured: { ...CANONICAL_DESCRIPTOR.measured, structureRef: 'PDB:3OAA' },
    });
    const { rerender } = render(<ReferenceChip reference={ref} inline onTarget={onTarget} />);
    fireEvent.click(screen.getByRole('button', { name: 'Target 3OAA catalytic residues' }));
    expect(onTarget).toHaveBeenCalledWith(ref);
    rerender(
      <ReferenceChip reference={{ ...ref, status: 'unresolved' }} inline onTarget={onTarget} />
    );
    expect(screen.getByRole('button', { name: 'Target 3OAA catalytic residues' })).toBeDisabled();
  });

  it('keeps source links separate from structure navigation', () => {
    const onClick = vi.fn();
    render(<ReferenceChip reference={savedViewReference} onClick={onClick} />);
    const link = screen.getByRole('link', { name: 'Structure evidence' });
    expect(link).toHaveAttribute('href', 'https://www.rcsb.org/structure/1IEP');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('opens the story step selected in chat without rewriting the saved reference', () => {
    const data = JSON.parse(savedViewReference.data!);
    data.scene = JSON.stringify({
      kind: 'multiple',
      snapshots: [
        { root: { kind: 'root' }, metadata: { title: 'Overview' } },
        { root: { kind: 'root' }, metadata: { title: 'Detail' } },
      ],
    });
    data.initialSnapshotIndex = 1;
    const reference = { ...savedViewReference, data: JSON.stringify(data) };
    const onClick = vi.fn();
    render(<ReferenceChip reference={reference} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse 2 views' }));
    fireEvent.click(screen.getByRole('option', { name: /Overview/ }));
    fireEvent.click(screen.getByRole('button', { name: /Open saved view:/ }));
    expect(onClick).toHaveBeenCalledWith(reference, { snapshotIndex: 0 });
    expect(JSON.parse(reference.data!).initialSnapshotIndex).toBe(1);
  });

  it.each([
    {
      name: 'unresolved',
      reference: { ...savedViewReference, status: 'unresolved' as const },
      busy: false,
      readOnly: false,
    },
    { name: 'busy', reference: savedViewReference, busy: true, readOnly: false },
    { name: 'read-only', reference: savedViewReference, busy: false, readOnly: true },
  ])(
    'preserves the preview but disables navigation when $name',
    ({ reference, busy, readOnly }) => {
      const onClick = vi.fn();
      render(
        <ReferenceChip reference={reference} onClick={readOnly ? undefined : onClick} busy={busy} />
      );
      const open = screen.getByRole('button', {
        name: 'Open saved view: ABL1–imatinib binding pocket',
      });
      expect(open).toBeDisabled();
      expect(
        within(screen.getByTestId('molecular-view-ref-saved-view')).getByRole('img')
      ).toBeInTheDocument();
      fireEvent.click(open);
      expect(onClick).not.toHaveBeenCalled();
    }
  );

  it('keeps saved-view draft attachments compact and removable', () => {
    const onRemove = vi.fn();
    render(<ReferenceChip reference={savedViewReference} phase="draft" onRemove={onRemove} />);
    expect(screen.queryByTestId('molecular-view-ref-saved-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove ABL1–imatinib binding pocket' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('exposes a nonvisual completed-tool record without rendering a duplicate card', () => {
    const input = {
      entityType: 'structure',
      selection: {
        kind: 'structure',
        structureRef: 'PDB:3OAA',
        residues: [{ chain: 'A', authSeqId: 57 }],
      },
    };

    render(
      <ReferenceChip
        reference={structureReference(CANONICAL_DESCRIPTOR)}
        completedToolInput={input}
      />
    );

    const completed = screen.getByTestId('tool-result');
    expect(completed).toHaveAttribute('data-tool-name', 'create_reference');
    expect(completed).toHaveAttribute('data-tool-status', 'completed');
    expect(JSON.parse(completed.getAttribute('data-tool-input') ?? '{}')).toEqual(input);
    expect(screen.getByTestId('ref-object-ref-structure')).toBeInTheDocument();
  });

  it('expands an exact discontinuous residue list inline without navigating', () => {
    const onClick = vi.fn();
    render(
      <ReferenceChip reference={structureReference(CANONICAL_DESCRIPTOR)} onClick={onClick} />
    );

    const disclosure = screen.getByRole('button', { name: 'Show selected residues' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByTestId('ref-details-ref-structure');
    const rows = within(details).getAllByTestId(/^ref-residue-ref-structure-/);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('H');
    expect(rows[0]).toHaveTextContent('HIS');
    expect(rows[0]).toHaveTextContent('Chain A');
    expect(rows[0]).toHaveTextContent('57');
    expect(rows[1]).toHaveTextContent('D');
    expect(rows[1]).toHaveTextContent('102');
    expect(rows[2]).toHaveTextContent('Identity unknown');
    expect(rows[2]).toHaveTextContent('195');
    expect(details).not.toHaveTextContent('57–195');
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.click(disclosure);
    expect(screen.queryByTestId('ref-details-ref-structure')).not.toBeInTheDocument();
  });

  it('opens the reference only from an explicit navigation action', () => {
    const reference = structureReference(CANONICAL_DESCRIPTOR);
    const onClick = vi.fn();
    render(<ReferenceChip reference={reference} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show selected residues' }));
    fireEvent.click(
      within(screen.getByTestId('ref-details-ref-structure')).getByRole('button', {
        name: 'Open 3OAA catalytic residues in 3D',
      })
    );

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(reference);
  });

  it('reads legacy residueIdentities and reports omitted residues explicitly', () => {
    const legacy = structureReference({
      schemaVersion: 2,
      kind: 'structure',
      measured: {
        residueCount: 203,
        residueIdentityOmittedCount: 2,
        residueIdentityUnknownCount: 1,
        residueIdentities: [
          {
            chain: 'G',
            authSeqId: 57,
            labelCompId: 'HIS',
            oneLetterCode: 'H',
          },
        ],
      },
    });
    render(<ReferenceChip reference={legacy} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show selected residues' }));

    expect(screen.getByText('HIS')).toBeInTheDocument();
    expect(screen.getByText('3 additional residues not enumerated')).toBeInTheDocument();
  });

  it('fails closed for malformed descriptor JSON while preserving navigation', () => {
    const onClick = vi.fn();
    const reference = structureReference(null, { data: '{broken-json' });
    render(<ReferenceChip reference={reference} onClick={onClick} />);

    expect(
      screen.queryByRole('button', { name: 'Show selected residues' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ref-chip-ref-structure'));
    expect(onClick).toHaveBeenCalledWith(reference);
  });

  it('wires the shared context menu to the chat reveal adapter', () => {
    const reference = structureReference(null, {
      entity_type: 'sequence',
      display_label: 'pUC19.gb',
      locator: 'git://Research Workspace/pUC19',
    });
    const onClick = vi.fn();
    const onReveal = vi.fn();
    render(<ReferenceChip reference={reference} onClick={onClick} onReveal={onReveal} />);

    const chip = screen.getByTestId('ref-chip-ref-structure');
    fireEvent.contextMenu(chip);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open',
      'Show in Explorer',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Explorer' }));

    expect(onReveal).toHaveBeenCalledWith(reference);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByTestId('ref-label-ref-structure')).toHaveTextContent('pUC19');
  });

  it('does not offer a dead Explorer action for a pathless entity', () => {
    const reference = structureReference(null, {
      locator: 'entity://structure/PDB:3OAA',
    });
    render(<ReferenceChip reference={reference} onClick={vi.fn()} onReveal={vi.fn()} />);

    fireEvent.contextMenu(screen.getByTestId('ref-chip-ref-structure'));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open']);
  });
});

describe('ReferenceChip — protein entity type  slice 2.4)', () => {
  it('renders the registered protein SVG instead of an emoji and navigates on click', () => {
    const onClick = vi.fn();
    const reference: DBEntityReference = {
      id: 'ref-protein',
      entity_type: 'protein',
      display_label: 'GFP',
      locator: 'entity://protein/aa-uuid-1',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    render(<ReferenceChip reference={reference} onClick={onClick} />);

    const chip = screen.getByTestId('ref-chip-ref-protein');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.textContent).not.toContain('⛓');
    expect(chip.textContent).toContain('GFP');

    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledWith(reference);
  });
});

describe('shared AI chat reference formatting', () => {
  it.each([
    ['sequence', 'Sequence'],
    ['notebook', 'Notebook'],
    ['file', 'File'],
    ['protein', 'Protein'],
    ['annotation', 'Annotation'],
  ])('shows the same inline kind label and icon for %s', (entityType, kindLabel) => {
    const reference = structureReference(null, {
      id: `style-${entityType}`,
      entity_type: entityType,
      display_label: 'Example reference',
      locator: `entity://${entityType}/example`,
    });
    render(<ReferenceChip reference={reference} phase="draft" />);
    const chip = screen.getByTestId(`ref-chip-${reference.id}`);
    expect(within(chip).getByText(kindLabel, { exact: false })).toBeVisible();
    expect(chip.querySelector('.entity-reference-chip__icon svg')).not.toBeNull();
    expect(chip).toHaveClass('entity-reference-chip--draft');
  });
});

it('formats uploaded attachments through the shared chat control while retaining their filenames', () => {
  const remove = vi.fn();
  render(
    <FilePill
      file={{
        id: `attachment-${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        name: 'notes.txt',
        kind: 'text',
        mediaType: 'text/plain',
        size: 24,
      }}
      onRemove={remove}
    />
  );
  const chip = screen.getByTestId('entity-reference-chip');
  expect(chip).toHaveTextContent('File');
  expect(chip).toHaveTextContent('notes.txt');
  expect(chip.firstElementChild).toHaveClass('entity-reference-chip__icon');
  expect(chip.querySelector('svg')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
  expect(remove).toHaveBeenCalledOnce();
});

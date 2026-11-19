import { emptyWorkTaskQuery } from '../../../../test/fixtures/work-tasks';
import { userMessage } from '@waypoint/user-messages';
/** @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useState, isValidElement, type ReactElement } from 'react';
import { useWorkspaceStore } from '../../../../stores/workspaceStore';
import { peekEntityDetailsSession } from '../../../entity-details/public/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalProviderSourceRequest } from '../../../../shared/benchling-migration-raw-source';
import type { LimsEntity, LimsPendingRef, LimsRegistryPreview } from '../../../../shared/lims';
import { OriginalProviderSourceDialog } from './OriginalProviderSourceDialog';
import { LIMS_BUILTIN_ENTITY_SCHEMAS } from '../../../../shared/lims';
import {
  RegistryPreviewPane as MetadataPreviewPane,
  type RegistryPreviewPaneProps,
} from './RegistryPreviewPane';

function RegistryPreviewPane(
  props: RegistryPreviewPaneProps & {
    workspaceFolders?: Array<{ path: string; name: string; pinned?: boolean }>;
    unconnectedRefs?: readonly LimsPendingRef[];
  }
) {
  return <MetadataPreviewPane {...props} />;
}

const platformMocks = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue({}),
  previews: new Map<string, LimsRegistryPreview>(),
  refs: [] as LimsPendingRef[],
  viewExternalSource: vi.fn(),
  review: vi.fn(),
  apply: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../../../services/lims-entity-mutations', () => ({
  updateLimsEntity: platformMocks.update,
}));

vi.mock('../../../../platform', () => ({
  platform: () => ({
    workTasks: { query: emptyWorkTaskQuery },
    db: { select: async () => [] },
    fs: { readTextFile: async () => '', exists: async () => false },
    trackViews: {
      read: async () => {
        throw new Error('Open this view’s project before editing its metadata.');
      },
    },
    lims: {
      reviewClassification: platformMocks.review,
      applyClassification: platformMocks.apply,
      getRegistryPreview: async ({ entityId }: { entityId: string }) =>
        platformMocks.previews.get(entityId),
      confirmPendingRef: platformMocks.confirm,
      getEntityHistory: async () => [],
      pendingRefs: async () => platformMocks.refs,
    },
    benchlingMigration: {
      viewExternalSource: platformMocks.viewExternalSource,
    },
  }),
}));

vi.mock('../../../sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: {
    resolve: async (ref: { packageId: string; packageRoot: string }) => {
      const { buildSequencePackageDocument } = await import('../../../../db/sequence-package');
      return {
        ref,
        document: buildSequencePackageDocument({
          id: ref.packageId,
          name: 'Sequence',
          product: { file: 'product.gb', topology: 'linear' },
        }),
        productPath: `${ref.packageRoot}/product.gb`,
      };
    },
  },
}));
vi.mock('../../../../shared/parse-sequence-file', () => ({
  parseTextSequenceFileAsAnnotated: () => ({
    sequence: {
      id: 'seq',
      name: 'Sequence',
      length: 42,
      sequence: 'ACGT',
      annotations: [],
      circular: false,
    },
  }),
}));

function seed(element: unknown): void {
  if (!isValidElement<Record<string, unknown>>(element)) return;
  const preview = element.props.registryPreview as LimsRegistryPreview | undefined;
  if (preview) platformMocks.previews.set(preview.entity.id, preview);
  const folders = element.props.workspaceFolders as
    | Array<{ path: string; name: string; pinned?: boolean }>
    | undefined;
  if (folders)
    useWorkspaceStore.setState({ folders: folders.map((folder) => ({ ...folder, addedAt: 0 })) });
  const refs = element.props.unconnectedRefs as LimsPendingRef[] | undefined;
  if (refs) platformMocks.refs = refs;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) seed(child);
}
async function render(element: ReactElement) {
  seed(element);
  const result = testingRender(element);
  if (screen.queryByTestId('entity-details-panel'))
    await screen.findByTestId('lims-registry-record-fields');
  return {
    ...result,
    rerender: (next: ReactElement) => {
      seed(next);
      result.rerender(next);
    },
  };
}
afterEach(() => {
  cleanup();
  for (const id of platformMocks.previews.keys()) peekEntityDetailsSession(id)?.discard();
  platformMocks.previews.clear();
  platformMocks.refs = [];
});

describe('RegistryPreviewPane imported Benchling records', () => {
  it('labels a supplied strain genome as a hypothesis, never as predicted', async () => {
    const record = preview({
      kind: 'strain',
      fields: {},
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.summary.evidenceSummary = {
      confidenceLabel: 'WGS verified with mismatch',
      gapStatus: 'mismatch',
      gapMessage: 'Genome hypothesis disagrees with WGS: 1 base differences, length delta 0.',
      parentGenomeName: 'MG1655 parent region',
      hypothesisGenomeName: 'Supplied argF hypothesis',
      verifiedGenomeName: 'Verified argF WGS',
    };
    await renderPreview(record);
    const genomes = screen.getByRole('region', { name: 'Genome links' });
    expect(within(genomes).getByText('Genome hypothesis')).toBeInTheDocument();
    expect(within(genomes).getByText('Supplied argF hypothesis')).toBeInTheDocument();
    expect(genomes).not.toHaveTextContent(/predicted genome/i);
  });

  it('does not show strain genome status on a sequence carrying a stale evidence summary', async () => {
    const record = preview({
      kind: 'sequence',
      fields: {},
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.summary.evidenceSummary = {
      confidenceLabel: 'No genome evidence',
      gapStatus: 'missing',
      gapMessage: 'No genome',
    } as NonNullable<LimsRegistryPreview['summary']['evidenceSummary']>;
    await renderPreview(record);
    expect(screen.queryByRole('region', { name: 'Genome links' })).not.toBeInTheDocument();
    expect(screen.queryByText('No genome evidence')).not.toBeInTheDocument();
  });

  it('keeps an imported provider row read-only when a native projection exists', async () => {
    const record = preview({
      kind: 'custom_reagent',
      fields: {
        amount: 42,
        sourceMetadata: { origin: { connectorType: 'benchling', sourceId: 'bfi_RECORD01' } },
      },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.nativeRecord = { schemaSnapshot: record.schemaSnapshot };
    await renderPreview(record);
    const fields = screen.getByTestId('lims-registry-record-fields');
    expect(within(fields).getByText('42')).toBeVisible();
    const editButtons = within(fields).getAllByRole('button', { name: /^Edit / });
    for (const button of editButtons) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'View original source' })).toBeVisible();
    expect(record.entity.fields.amount).toBe(42);
  });

  beforeEach(() => platformMocks.viewExternalSource.mockReset());
  it('edits writable records directly in Details without a separate form', async () => {
    const record = preview({
      kind: 'custom_reagent',
      fields: { amount: 42 },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    await render(
      <RegistryPreviewPane
        registryPreview={record}
        openRegistrySummary={vi.fn()}
        onViewOriginalSource={vi.fn()}
      />
    );
    const fields = screen.getByTestId('lims-registry-record-fields');
    expect(screen.queryByTestId('registry-edit-metadata')).not.toBeInTheDocument();
    fireEvent.click(within(fields).getByRole('button', { name: 'Edit Name', exact: true }));
    expect(within(fields).getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(record.entity.fields).toEqual({ amount: 42 });
  });
  it('shows reference ownership before offering an edit of a managed sequence', async () => {
    const record = preview({
      kind: 'sequence',
      fields: { description: '' },
      representation: {
        kind: 'file_sequence',
        label: 'Managed DNA sequence',
        canOpen: true,
        openTarget: {
          kind: 'managed_sequence',
          entityId: 'sequence-1',
          document: {
            kind: 'managed-sequence',
            packageId: 'sequence-1',
            packageRoot: '/references/pDemo1',
          },
        },
      },
    });
    await render(
      <RegistryPreviewPane
        registryPreview={record}
        openRegistrySummary={vi.fn()}
        onViewOriginalSource={vi.fn()}
        workspaceFolders={[{ path: '/references', name: 'Dev Assets', pinned: true }]}
      />
    );
    expect(screen.getByTestId('sequence-metadata-read-only')).toHaveTextContent('Dev Assets');
    expect(screen.getByTestId('sequence-metadata-read-only')).toHaveTextContent('reference folder');
    expect(screen.queryByRole('button', { name: 'Edit Name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit description' })).not.toBeInTheDocument();
  });
  it('separates calculated sequence properties from fields and omits the tracked label', async () => {
    const record = preview({
      kind: 'sequence',
      fields: { size: 12047 },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.schemaSnapshot = { ...record.schemaSnapshot, baseKind: 'sequence', fields: [] };
    record.summary.schemaSnapshot = record.schemaSnapshot;
    record.entity.registrationStatus = 'tracked';
    record.summary.registrationStatus = 'tracked';
    await renderPreview(record);
    const properties = screen.getByRole('region', { name: 'Sequence properties' });
    expect(properties).toHaveTextContent('Size12,047');
    expect(within(properties).queryByRole('button')).not.toBeInTheDocument();
    const fields = screen.getByTestId('lims-registry-record-fields');
    expect(within(fields).queryByText('Size')).not.toBeInTheDocument();
    expect(within(fields).queryByText('Status')).not.toBeInTheDocument();
    expect(screen.queryByText('tracked')).not.toBeInTheDocument();
  });
  it('opens the catalog source of a custom record without adding provenance fields', async () => {
    const record = preview({
      kind: 'custom_reagent',
      fields: { amount: 42 },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    const request = { workspaceId: 1, entityId: record.entity.id, sourceRecordId: 'bfi_RECORD01' };
    const withSource = { ...record, originalSource: request };
    platformMocks.viewExternalSource.mockResolvedValueOnce({
      status: 'ready',
      originalPath: '/imports/records.zip',
      sourceDisplayName: 'records.zip',
      entryPath: 'records.csv',
      displayFilename: 'records.csv',
      mediaType: 'application/json',
      text: '{"amount":"0"}',
      sizeBytes: 14,
      truncated: false,
      message: 'Exported row 1, verified.',
    });
    await renderPreview(withSource);
    fireEvent.click(screen.getByRole('button', { name: 'View original source' }));
    expect(platformMocks.viewExternalSource).toHaveBeenLastCalledWith(request);
    expect(await screen.findByTestId('original-provider-source-text')).toHaveTextContent(
      '"amount":"0"'
    );
    expect(screen.getByText(userMessage('source.verified'))).toBeVisible();
    expect(record.entity.fields).toEqual({ amount: 42 });
  });

  it('keeps the source dialog open when the registry preview is replaced', async () => {
    const record = preview({
      kind: 'custom_reagent',
      fields: { amount: 42 },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    const request = { workspaceId: 1, entityId: record.entity.id, sourceRecordId: 'bfi_RECORD01' };
    platformMocks.viewExternalSource.mockResolvedValueOnce({
      status: 'ready',
      originalPath: '/imports/records.zip',
      sourceDisplayName: 'records.zip',
      entryPath: 'records.csv',
      displayFilename: 'records.csv',
      mediaType: 'application/json',
      text: '{"amount":"0"}',
      sizeBytes: 14,
      truncated: false,
      message: 'Exported row 1, verified.',
    });
    const rendered = await renderPreview({ ...record, originalSource: request });

    fireEvent.click(screen.getByRole('button', { name: 'View original source' }));
    expect(await screen.findByTestId('original-provider-source-text')).toBeVisible();

    rendered.rerender(
      previewElement(
        preview({
          kind: 'strain',
          fields: {},
          representation: { kind: 'strain_evidence', label: 'Strain evidence', canOpen: false },
        })
      )
    );

    expect(screen.getByTestId('original-provider-source-text')).toHaveTextContent('"amount":"0"');
    expect(screen.getByRole('dialog')).toHaveTextContent('Sequence awaiting bases');
  });

  it.each(['success', 'interrupted'] as const)(
    'keeps an in-flight classification visible through %s when a background preview sees the database edit',
    async (outcome) => {
      const initial = preview({
        kind: 'dna_sequence',
        fields: {},
        representation: { kind: 'none', label: 'Sequence', canOpen: false },
      });
      const onApplied = vi.fn();
      let finish: (result: unknown) => void = () => {
        throw new Error('Save was not started');
      };
      let reject: (error: Error) => void = () => {
        throw new Error('Save was not started');
      };
      platformMocks.apply.mockImplementation(
        () =>
          new Promise((resolve, rejectPromise) => {
            finish = resolve;
            reject = rejectPromise;
          })
      );
      platformMocks.review.mockResolvedValue({
        status: 'review',
        entityId: initial.entity.id,
        entityName: 'Candidate',
        currentKind: 'dna_sequence',
        targetSourceId: 'seq_OLIGO001',
        reviewToken: `sha256:${'a'.repeat(64)}`,
        evidence: [],
        evidenceLimited: false,
        sequence: { length: 24, molecule: 'dna', topology: 'linear' },
        assessment: { status: 'suggested', kind: 'oligo', use: 'primer' },
      });
      const rendered = await render(previewElement(initial, onApplied));
      fireEvent.click(screen.getByRole('button', { name: 'Review classification' }));
      await screen.findByText('Source suggests DNA oligo, used as primer.');
      fireEvent.click(screen.getByRole('radio', { name: 'Classify as DNA oligo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
      const updated = {
        ...initial,
        entity: { ...initial.entity, kind: 'oligo' },
        summary: { ...initial.summary, kind: 'oligo' },
      };
      rendered.rerender(previewElement(updated, onApplied));
      expect(screen.getByText('Saving your choice…')).toBeVisible();
      expect(onApplied).not.toHaveBeenCalled();
      const result = {
        status: 'applied',
        entityId: initial.entity.id,
        requestId: 'same-request',
        kind: 'oligo',
        use: 'primer',
      };
      if (outcome === 'interrupted') {
        const originalRequest = platformMocks.apply.mock.calls.at(-1)?.[0];
        reject(new Error('Publication confirmation interrupted'));
        await screen.findByRole('button', { name: 'Retry saved choice' });
        expect(onApplied).not.toHaveBeenCalled();
        platformMocks.apply.mockResolvedValue(result);
        fireEvent.click(screen.getByRole('button', { name: 'Retry saved choice' }));
        expect(platformMocks.apply.mock.calls.at(-1)?.[0]).toEqual(originalRequest);
      } else finish(result);
      await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.queryByTestId('registry-classification-review')).toBeNull()
      );
    }
  );
  it('shows custom schema fields without hiding zero, false, blank or saved formula status', async () => {
    const record = preview({
      kind: 'custom_reagent',
      fields: {
        amount: 0,
        verified: false,
        notes: '',
        missing: null,
        formula: {
          formula: '=UNSUPPORTED(A1)',
          sourceValue: 7,
          compatibility: 'unsupported',
          stale: true,
        },
      },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.summary.schemaDisplayName = 'Reagent';
    record.schemaSnapshot = {
      schemaId: 'reagent',
      schemaRevisionId: 'reagent-v1',
      name: 'custom_reagent',
      displayName: 'Reagent',
      version: 1,
      baseKind: 'record',
      fields: [
        { key: 'amount', label: 'Amount', type: 'number' },
        { key: 'verified', label: 'Verified', type: 'boolean' },
        { key: 'notes', label: 'Notes', type: 'long_text' },
        { key: 'missing', label: 'Missing', type: 'text' },
        { key: 'formula', label: 'Calculation', type: 'formula_result' },
      ],
    };
    record.summary.fieldValues = { ...record.entity.fields };
    await renderPreview(record);
    expect(
      within(screen.getByTestId('lims-registry-record-fields')).getByText('Reagent')
    ).toBeVisible();
    const fields = screen.getByTestId('lims-registry-record-fields');
    expect(within(fields).getByText('0')).toBeVisible();
    expect(within(fields).getByText('No')).toBeVisible();
    expect(within(fields).getAllByText('-').length).toBeGreaterThanOrEqual(2);
    expect(within(fields).getByText('7')).toBeVisible();
    expect(within(fields).getByText('Saved result · May be outdated')).toBeVisible();
  });
  it('does not add an empty Links section to an otherwise complete record', async () => {
    await renderPreview(
      preview({
        kind: 'custom_reagent',
        fields: { amount: 42 },
        representation: { kind: 'none', label: 'Record', canOpen: false },
      })
    );

    expect(screen.queryByText('Links')).not.toBeInTheDocument();
    expect(screen.queryByText('No linked records')).not.toBeInTheDocument();
  });
  it('formats a derived sequence size the same way as its Registry table cell', async () => {
    const record = preview({
      kind: 'sequence',
      fields: {},
      representation: { kind: 'none', label: 'Sequence', canOpen: false },
    });
    record.schemaSnapshot = {
      schemaId: 'schema-entity-sequence',
      schemaRevisionId: 'schema-entity-sequence-v2',
      name: 'sequence',
      displayName: 'DNA sequence',
      version: 2,
      baseKind: 'sequence',
      fields: [],
    };
    record.summary.fieldValues = { size: 8233, topology: 'circular', geneticCode: 1 };
    await renderPreview(record);
    const fields = screen.getByTestId('lims-registry-record-fields');
    expect(
      within(screen.getByRole('region', { name: 'Sequence properties' })).getByText('8,233')
    ).toBeVisible();
    expect(within(fields).queryByText('Size')).not.toBeInTheDocument();
    expect(within(fields).getByText('1 — Standard')).toBeVisible();
  });
  it('keeps every ordered source field visible, including duplicates and blanks', async () => {
    await renderPreview(
      preview({
        kind: 'strain',
        fields: {
          genotypeCanonical: 'deltaX',
          sourceMetadata: {
            schemaVersion: 1,
            origin: {
              type: 'connector',
              connectorType: 'benchling',
              sourceName: 'Benchling strain export',
              sourceId: 'bfi_STRAINAA',
            },
            values: { Tag: ['first', 'second'], Blank: '', 'Unmapped α': 'β' },
            entries: [
              { label: 'Tag', value: 'first', position: 0 },
              { label: 'Tag', value: 'second', position: 1 },
              { label: 'Blank', value: '', position: 2 },
              { label: 'Unmapped α', value: 'β', position: 3 },
            ],
          },
        },
        representation: { kind: 'strain_evidence', label: 'Strain evidence', canOpen: false },
      })
    );

    const sourceFields = screen.getByTestId('lims-registry-imported-source-fields');
    expect(sourceFields).not.toHaveAttribute('open');
    fireEvent.click(within(sourceFields).getByText('Imported source details (4)'));

    expect(within(sourceFields).getAllByText('Tag')).toHaveLength(2);
    expect(within(sourceFields).getByText('first')).toBeVisible();
    expect(within(sourceFields).getByText('second')).toBeVisible();
    expect(within(sourceFields).getByText('-')).toBeVisible();
    expect(within(sourceFields).getByText('Unmapped α')).toBeVisible();
    expect(within(sourceFields).getByText('β')).toBeVisible();
  });

  it('shows Needs sequence without an action that opens an empty canvas', async () => {
    await renderPreview(
      preview({
        kind: 'dna_sequence',
        fields: {
          sequence: { mode: 'unresolved' },
          sourceMetadata: {
            schemaVersion: 1,
            origin: {
              type: 'connector',
              connectorType: 'benchling',
              sourceName: 'Benchling GenBank export',
              sourceId: 'seq_EMPTYDNA',
            },
            values: { definition: 'Awaiting bases' },
            entries: [{ label: 'DEFINITION', value: 'Awaiting bases', position: 0 }],
          },
        },
        representation: { kind: 'unresolved', label: 'Needs sequence', canOpen: false },
      })
    );

    expect(screen.getByText('unresolved')).toBeVisible();
    expect(screen.queryByTestId('lims-registry-preview-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('lims-registry-imported-source-fields')).toBeInTheDocument();
  });

  it('does not offer projection-only undo or archive for a managed sequence package', async () => {
    await renderPreview(
      preview({
        kind: 'sequence',
        fields: {},
        representation: {
          kind: 'file_sequence',
          label: 'Managed DNA sequence',
          canOpen: true,
          openTarget: {
            kind: 'managed_sequence',
            entityId: 'sequence-1',
            document: {
              kind: 'managed-sequence',
              packageId: 'sequence-1',
              packageRoot: '/workspace/Sequence',
            },
          },
        },
      })
    );

    expect(screen.queryByTestId('lims-registry-preview-undo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-preview-archive')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-preview-actions')).not.toBeInTheDocument();
  });

  it.each([false, true])(
    'offers native lifecycle actions for a registered managed package (archived=%s)',
    async (archived) => {
      const record = Object.assign(
        preview({
          kind: 'sequence',
          fields: {},
          representation: {
            kind: 'file_sequence',
            label: 'Managed DNA sequence',
            canOpen: !archived,
            openTarget: {
              kind: 'managed_sequence',
              entityId: 'sequence-1',
              document: {
                kind: 'managed-sequence',
                packageId: 'sequence-1',
                packageRoot: '/workspace/Sequence',
              },
            },
          },
        }),
        { acceptedScientificOwner: false, savedLifecycleAuthority: 'sequence_package' as const }
      );
      record.summary.archived = archived;
      record.entity.tombstone = archived;
      record.entity.archivedAt = archived ? 1 : null;
      const folders = useWorkspaceStore.getState().folders;
      try {
        useWorkspaceStore.setState({
          folders: [{ path: '/workspace', name: 'Home project', addedAt: 0 }],
        });
        await renderPreview(record);
        expect(
          screen.getByTestId(
            archived ? 'lims-registry-preview-restore' : 'lims-registry-preview-archive'
          )
        ).toBeEnabled();
        expect(screen.queryByTestId('lims-registry-preview-undo')).not.toBeInTheDocument();
      } finally {
        cleanup();
        useWorkspaceStore.setState({ folders });
      }
    }
  );

  it('requests the exact history-bound source by identity and renders its verified text', async () => {
    platformMocks.viewExternalSource.mockResolvedValueOnce({
      status: 'ready',
      originalPath: '/imports/benchling.zip',
      sourceDisplayName: 'benchling.zip',
      message: 'Verified original source.',
      entryPath: 'registry/strain.csv',
      displayFilename: 'strain.csv',
      mediaType: 'text/csv',
      text: 'name,Strain A',
      sizeBytes: 13,
      truncated: false,
    });
    await renderPreview(
      preview({
        kind: 'strain',
        fields: {
          sourceMetadata: {
            schemaVersion: 1,
            origin: {
              type: 'connector',
              connectorType: 'benchling',
              sourceName: 'Benchling strain export',
              sourceId: 'bfi_STRAINAA',
            },
            values: {},
            entries: [],
          },
        },
        representation: { kind: 'strain_evidence', label: 'Strain evidence', canOpen: false },
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'View original source' }));

    expect(platformMocks.viewExternalSource).toHaveBeenCalledWith({
      workspaceId: 1,
      entityId: 'strain-1',
      sourceRecordId: 'bfi_STRAINAA',
    });
    await waitFor(() => {
      expect(screen.getByTestId('original-provider-source-text')).toHaveTextContent(
        'name,Strain A'
      );
    });
    expect(screen.getByText('/imports/benchling.zip')).toBeVisible();
  });

  it('keeps file-backed Track view projections read-only in Registry', async () => {
    await renderPreview(
      preview({
        kind: 'track-view',
        fields: {
          referenceAssemblyId: 'sacCer3',
          referenceName: 'S. cerevisiae',
          trackCount: 2,
          artifactFingerprint: 'track-view-fingerprint',
        },
        representation: {
          kind: 'track_view',
          label: 'Saved Track view',
          canOpen: true,
          openTarget: {
            kind: 'track_view',
            entityId: 'track-view-1',
            entityKind: 'track-view',
            label: 'Yeast detail',
          },
        },
      })
    );

    expect(screen.queryByText('Saved genome view')).not.toBeInTheDocument();
    expect(screen.getByTestId('registry-record-read-only')).toHaveTextContent(
      'Open this view’s project before editing its metadata.'
    );
    expect(screen.getByTestId('entity-details-panel')).toHaveAttribute('data-editing', 'false');
    expect(screen.getByText('S. cerevisiae')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Edit Name', exact: true })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-preview-undo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lims-registry-preview-archive')).not.toBeInTheDocument();
  });

  it('marks an imported field and lists the unconnected relationship on the entity', async () => {
    const record = preview({
      kind: 'strain',
      fields: {
        sourceMetadata: {
          entries: [
            {
              label: 'Sequence link(s)',
              value: 'GEM-ZQX-Sundew integrated Chr XI, Triple reporter integrated',
              position: 0,
            },
          ],
        },
      },
      representation: { kind: 'none', label: 'Strain', canOpen: false },
    });
    const confirm = vi.fn();
    await render(
      <RegistryPreviewPane
        registryPreview={record}
        openRegistrySummary={vi.fn()}
        onViewOriginalSource={vi.fn()}
        unconnectedRefs={[pendingRef(record.entity.id)]}
      />
    );

    expect(await screen.findByTestId('lims-registry-failed')).toBeVisible();
    expect(screen.getByTestId('lims-registry-source-field-failed-0')).toBeVisible();
    expect(screen.getByTestId('lims-registry-unconnected-link')).toHaveTextContent(
      'Triple reporter integrated'
    );
    fireEvent.click(screen.getByTestId('pending-ref-confirm'));
    await waitFor(() =>
      expect(platformMocks.confirm).toHaveBeenCalledWith({ key: 'ref-1', targetEntityId: 'seq-1' })
    );
  });
});

function pendingRef(referrerEntityId: string): LimsPendingRef {
  return {
    key: 'ref-1',
    referrerEntityId,
    referrerName: 'Imported strain',
    type: 'associated_with',
    targetKind: null,
    targetName: 'Triple reporter integrated',
    normalizedTargetName: 'triple reporter integrated',
    sourceBatchId: 'batch',
    status: 'draft',
    candidateEntityIds: ['seq-1'],
    candidates: [{ id: 'seq-1', name: 'Triple reporter integrated', kind: 'dna_sequence' }],
  };
}

async function renderPreview(registryPreview: LimsRegistryPreview) {
  return render(previewElement(registryPreview));
}

function previewElement(
  registryPreview: LimsRegistryPreview,
  onClassificationApplied?: () => Promise<void>
) {
  return (
    <PreviewHarness
      registryPreview={registryPreview}
      onClassificationApplied={onClassificationApplied}
    />
  );
}

function PreviewHarness({
  registryPreview,
  onClassificationApplied,
}: {
  registryPreview: LimsRegistryPreview;
  onClassificationApplied?: () => Promise<void>;
}) {
  const [originalSourceDialog, setOriginalSourceDialog] = useState<{
    request: ExternalProviderSourceRequest;
    label: string;
  } | null>(null);
  return (
    <>
      <RegistryPreviewPane
        registryPreview={registryPreview}
        openRegistrySummary={vi.fn()}
        onViewOriginalSource={setOriginalSourceDialog}
        onClassificationApplied={onClassificationApplied}
      />
      {originalSourceDialog ? (
        <OriginalProviderSourceDialog
          request={originalSourceDialog.request}
          label={originalSourceDialog.label}
          onClose={() => setOriginalSourceDialog(null)}
        />
      ) : null}
    </>
  );
}

function preview(input: {
  kind: string;
  fields: Record<string, unknown>;
  representation: LimsRegistryPreview['summary']['representation'];
}): LimsRegistryPreview {
  const entity: LimsEntity = {
    id: `${input.kind}-1`,
    kind: input.kind,
    schemaId: null,
    schemaRevisionId: `${input.kind}-schema-v1`,
    name: input.kind === 'strain' ? 'Imported strain' : 'Sequence awaiting bases',
    registryId: null,
    fields: input.fields,
    registrationStatus: input.kind === 'strain' ? 'registered' : 'unresolved',
    domainStatus: null,
    workspaceId: 1,
    actor: 'migration',
    eventSeq: 1,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
  const schemaFields = Object.entries(input.fields)
    .filter(([key]) => key !== 'sourceMetadata' && key !== 'sequence')
    .map(([key, value]) => ({
      key,
      label: key,
      type:
        typeof value === 'number'
          ? ('number' as const)
          : typeof value === 'boolean'
            ? ('boolean' as const)
            : ('text' as const),
    }));
  const schemaSnapshot = {
    schemaId: `${input.kind}-schema`,
    schemaRevisionId: `${input.kind}-schema-v1`,
    name: input.kind,
    displayName: input.kind,
    version: 1,
    baseKind: 'record',
    fields: schemaFields,
  };
  return {
    entity,
    schemaSnapshot,
    summary: {
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      registryId: entity.registryId,
      registrationStatus: entity.registrationStatus,
      domainStatus: entity.domainStatus,
      schemaSnapshot,
      fieldValues: { ...input.fields },
      schemaDisplayName: input.kind,
      representation: input.representation,
      summary: '',
      linkSummary: { outgoingCount: 0, incomingCount: 0, notable: [] },
      searchableText: entity.name,
      updatedAt: entity.updatedAt,
      archived: false,
    },
    outgoingLinks: [],
    incomingLinks: [],
  };
}

describe('scientific metadata in the shared pane', () => {
  it.each(LIMS_BUILTIN_ENTITY_SCHEMAS.map((schema) => [schema.name, schema] as const))(
    'presents the declared %s schema through the common metadata pane',
    async (_name, schema) => {
      const record = preview({
        kind: schema.name,
        fields: {},
        representation: { kind: 'none', label: schema.displayName, canOpen: false },
      });
      record.schemaSnapshot = {
        ...record.schemaSnapshot,
        name: schema.name,
        displayName: schema.displayName,
        fields: schema.fields,
      };
      record.nativeRecord = { schemaSnapshot: record.schemaSnapshot };
      await renderPreview(record);
      expect(screen.getByTestId('entity-details-panel')).toHaveTextContent(schema.displayName);
      expect(screen.getByTestId('lims-registry-record-fields')).toBeVisible();
    }
  );

  it('keeps the managed sequence metadata edit action in the common pane', async () => {
    const record = preview({
      kind: 'dna_sequence',
      fields: { description: 'Saved package metadata' },
      representation: {
        kind: 'file_sequence',
        label: 'DNA sequence',
        canOpen: true,
        openTarget: {
          kind: 'managed_sequence',
          entityId: 'dna_sequence-1',
          document: {
            kind: 'managed-sequence',
            packageId: 'dna_sequence-1',
            packageRoot: '/project/pUC19',
          },
        },
      },
    });
    await render(
      <RegistryPreviewPane
        registryPreview={record}
        openRegistrySummary={vi.fn()}
        onViewOriginalSource={vi.fn()}
        workspaceFolders={[{ path: '/project', name: 'Project', pinned: false }]}
      />
    );
    expect(screen.getByTestId('entity-details-panel')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit sequence name', exact: true })).toBeEnabled();
  });

  it.each(['protein_sequence', 'track_view', 'molecular_document', 'notebook'] as const)(
    'keeps undeclared %s viewer data outside the metadata editor',
    async (kind) => {
      const record = preview({
        kind: 'protein',
        fields: { viewerData: 'preserved-viewer-data' },
        representation: { kind, canOpen: true, label: kind },
      });
      record.schemaSnapshot = { ...record.schemaSnapshot, fields: [] };
      record.summary.schemaSnapshot = record.schemaSnapshot;
      await renderPreview(record);
      const additional = screen.getByRole('region', { name: 'Additional details', exact: true });
      expect(additional).toHaveTextContent('preserved-viewer-data');
      expect(within(additional).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(additional).queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    }
  );

  it('does not show strain genome status on a sequence carrying a stale evidence summary', async () => {
    const record = preview({
      kind: 'sequence',
      fields: {},
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.summary.evidenceSummary = {
      confidenceLabel: 'No genome evidence',
      gapStatus: 'missing',
      gapMessage: 'No genome',
    } as NonNullable<LimsRegistryPreview['summary']['evidenceSummary']>;
    await renderPreview(record);
    expect(screen.queryByRole('region', { name: 'Genome links' })).not.toBeInTheDocument();
    expect(screen.queryByText('No genome evidence')).not.toBeInTheDocument();
  });

  it('captures accepted strain authority and the edit version across refresh and an unchanged pending retry', async () => {
    const record = preview({
      kind: 'strain',
      fields: { amount: 12 },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.entity.eventSeq = 9;
    const authority = {
      workspaceRoot: '/workspace/strain-project',
      workspaceId: 1,
      artifactPath: '/workspace/strain-project/stock.entity.json',
      revision: {
        kind: 'accepted-object' as const,
        resourceId: record.entity.id,
        resourceRevisionId: `rr_${'a'.repeat(64)}`,
        workspaceVersionId: `wv_${'b'.repeat(64)}`,
        contentSha256: 'c'.repeat(64),
        sequenceEditParentEventId: null,
      },
    };
    record.nativeRecord = { schemaSnapshot: record.schemaSnapshot, scientificAuthority: authority };
    platformMocks.update.mockReset();
    platformMocks.update.mockRejectedValueOnce(
      new Error('Save accepted; file delivery remains pending.')
    );
    const element = (
      <RegistryPreviewPane
        registryPreview={record}
        openRegistrySummary={vi.fn()}
        onViewOriginalSource={vi.fn()}
        workspaceFolders={[{ path: authority.workspaceRoot, name: 'Strain project' }]}
      />
    );
    const view = await render(element);
    fireEvent.click(screen.getByRole('button', { name: 'Edit amount', exact: true }));
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '42' } });
    record.entity.name = 'Later projection';
    record.entity.eventSeq = 12;
    record.nativeRecord.scientificAuthority = {
      ...authority,
      revision: { ...authority.revision, resourceRevisionId: `rr_${'d'.repeat(64)}` },
    };
    view.rerender(element);
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('document.saveUnconfirmed')
    );
    expect(screen.getByRole('button', { name: 'Edit amount', exact: true })).toHaveTextContent(
      '42'
    );
    expect(platformMocks.update.mock.calls[0][0]).toMatchObject({
      id: record.entity.id,
      expectedEventSeq: 9,
      fields: { amount: 42 },
    });
    expect(platformMocks.update.mock.calls[0][1]).toEqual({ scientificAuthority: authority });
    expect(screen.getByRole('button', { name: 'Update entity' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry save', exact: true }));
    await waitFor(() => expect(platformMocks.update).toHaveBeenCalledTimes(2));
    expect(platformMocks.update.mock.calls[1]).toEqual(platformMocks.update.mock.calls[0]);
  });

  it('keeps an imported provider row read-only when a native projection exists', async () => {
    const record = preview({
      kind: 'custom_reagent',
      fields: {
        amount: 42,
        sourceMetadata: { origin: { connectorType: 'benchling', sourceId: 'bfi_RECORD01' } },
      },
      representation: { kind: 'none', label: 'Record', canOpen: false },
    });
    record.nativeRecord = { schemaSnapshot: record.schemaSnapshot };
    const metadataSaved = vi.fn(async () => {});
    await render(
      <RegistryPreviewPane
        registryPreview={record}
        openRegistrySummary={vi.fn()}
        onViewOriginalSource={vi.fn()}
        onMetadataSaved={metadataSaved}
      />
    );
    const editButtons = within(screen.getByTestId('entity-details-panel')).getAllByRole('button', {
      name: /^Edit /,
    });
    for (const button of editButtons) expect(button).toBeDisabled();
    expect(screen.getByTestId('lims-registry-record-fields')).toHaveTextContent('42');
    expect(screen.getByRole('button', { name: 'View original source' })).toBeVisible();
    expect(metadataSaved).not.toHaveBeenCalled();
    expect(record.entity.fields.amount).toBe(42);
  });
});

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  PRIMER_COLOR,
  primerIndexFromRenderId,
  primerRenderIdAt,
  type Primer as RendererPrimer,
} from '@waypoint/genome-renderer';
import { reverseComplement } from '@waypoint/sequence-utils';

import { PrimersDrawerContent } from '../../primers/public/components/PrimersDrawerContent';
import { createFileAuthoritativePrimer } from '../../primers/public/create-file-authoritative-primer';
import type { HostPrimerBinding } from '../../primers/public/primer-save-preparation';
import type { BoundPrimer, CreatePrimerInput, PrimerDirection } from '../../primers/public/types';
import type { IndexedGenomePrimerBinding } from '../../../shared/indexed-genome';
import type { IndexedChromosomeSpan } from './indexed-cut-site-window';
import { primerServices } from '../../primers/public/primer-services';
import type { IndexedPrimerFindWindow } from './indexed-primer-find-scope';
import { useIndexedPrimerFind } from './useIndexedPrimerFind';
import {
  copyPrimerRecord,
  primerArtifactLocation,
  type PrimerArtifactLocation,
} from '../primer-menu-actions';

const PRIMER_TEMPLATE_PAD_BP = 300;

interface PrimerTemplate {
  readonly chrom: string;
  readonly start0: number;
  readonly bases: string;
  readonly pending: {
    sequence: string;
    direction: PrimerDirection;
    bindingStart: number;
    bindingEnd: number;
  };
}

export interface IndexedPrimerSelection {
  readonly chrom: string;
  readonly start0: number;
  readonly end0: number;
}

export function useIndexedPrimers({
  scopeKey,
  viewport,
  selection,
  bindings,
  persistBindings,
  chromosomes,
  readSequence,
  workspaceRoot,
  onRevealRange,
  onError,
  workspaceFolders,
  openPrimerDocument,
  showPrimersDrawer,
}: {
  scopeKey: string;
  viewport: Readonly<{ start: number; end: number }> | null;
  selection: IndexedPrimerFindWindow | null;
  bindings: readonly IndexedGenomePrimerBinding[];
  persistBindings: (
    updater: (
      previous: readonly IndexedGenomePrimerBinding[]
    ) => readonly IndexedGenomePrimerBinding[]
  ) => void;
  chromosomes: ReadonlyArray<IndexedChromosomeSpan>;
  readSequence: (chrom: string, start0: number, end0: number) => Promise<string>;
  workspaceRoot: string | null;
  onRevealRange: (start: number, end: number) => void;
  onError: (message: string) => void;
  workspaceFolders: Parameters<typeof primerArtifactLocation>[1];
  openPrimerDocument: (location: PrimerArtifactLocation, name: string) => void;
  showPrimersDrawer: () => void;
}): {
  rendererPrimers: readonly RendererPrimer[];
  drawerContent: ReactNode;
  openFind: (selection: IndexedPrimerFindWindow | null) => void;
  startCreatePrimer: (selection: IndexedPrimerSelection, direction: PrimerDirection) => void;
  bindingAtHit: (
    hit: { kind: string; payload?: unknown } | null | undefined
  ) => IndexedGenomePrimerBinding | null;
  primerMenuActions: (binding: IndexedGenomePrimerBinding) => {
    onEditPrimer: () => void;
    onCopyPrimerBases: () => void;
    onDetachPrimer: () => void;
  };
} {
  const [template, setTemplate] = useState<PrimerTemplate | null>(null);

  const chromGlobalStart = useMemo(() => {
    const offsets = new Map<string, number>();
    let offset = 0;
    for (const chromosome of chromosomes) {
      offsets.set(chromosome.chrom, offset);
      offset += chromosome.length;
    }
    return offsets;
  }, [chromosomes]);
  const chromLength = useMemo(
    () => new Map(chromosomes.map((chromosome) => [chromosome.chrom, chromosome.length])),
    [chromosomes]
  );

  const find = useIndexedPrimerFind({
    scopeKey,
    bindings,
    persistBindings,
    chromosomes,
    chromGlobalStart,
    viewport,
    selection,
    readSequence,
    onRevealRange,
  });
  const { candidatePreview } = find;

  const rendererPrimers = useMemo<RendererPrimer[]>(() => {
    const attached = bindings.flatMap((binding, index): RendererPrimer[] => {
      const offset = chromGlobalStart.get(binding.chrom);
      if (offset === undefined) return [];
      return [
        {
          id: binding.id,
          sourcePrimerId: binding.primerId,
          renderId: primerRenderIdAt(index),
          name: binding.primerName,
          start: offset + binding.start0,
          end: offset + binding.end0,
          direction: binding.strand === '+' ? 'forward' : 'reverse',
          color: PRIMER_COLOR,
          bases: binding.primerBases,
        },
      ];
    });
    return candidatePreview
      ? [...attached, { ...candidatePreview, renderId: primerRenderIdAt(bindings.length) }]
      : attached;
  }, [bindings, candidatePreview, chromGlobalStart]);

  const boundPrimers = useMemo<BoundPrimer[]>(
    () => bindings.map((binding) => boundPrimerFromBinding(binding)),
    [bindings]
  );

  const revealBinding = useCallback(
    (binding: IndexedGenomePrimerBinding) => {
      const offset = chromGlobalStart.get(binding.chrom);
      if (offset !== undefined) onRevealRange(offset + binding.start0, offset + binding.end0);
    },
    [chromGlobalStart, onRevealRange]
  );

  const startCreatePrimer = useCallback(
    (selection: IndexedPrimerSelection, direction: PrimerDirection) => {
      const length = chromLength.get(selection.chrom);
      if (length === undefined) return;
      const start0 = Math.max(0, selection.start0 - PRIMER_TEMPLATE_PAD_BP);
      const end0 = Math.min(length, selection.end0 + PRIMER_TEMPLATE_PAD_BP);
      readSequence(selection.chrom, start0, end0)
        .then((raw) => {
          const bases = raw;
          const bindingStart = selection.start0 - start0;
          const bindingEnd = selection.end0 - start0;
          const selected = bases.slice(bindingStart, bindingEnd);
          setTemplate({
            chrom: selection.chrom,
            start0,
            bases,
            pending: {
              sequence: direction === 'forward' ? selected : reverseComplement(selected),
              direction,
              bindingStart,
              bindingEnd,
            },
          });
        })
        .catch((error: unknown) =>
          onError(error instanceof Error ? error.message : 'Could not read the reference.')
        );
    },
    [chromLength, onError, readSequence]
  );

  const handlePrimerCreate = useCallback(
    async (input: CreatePrimerInput, hostBinding?: HostPrimerBinding) => {
      const saved = await createFileAuthoritativePrimer({ ...input, origin: 'manual' });
      const current = template;
      setTemplate(null);
      if (!hostBinding || !current) return;
      const binding: IndexedGenomePrimerBinding = {
        id: crypto.randomUUID(),
        primerId: saved.artifact.id,
        primerName: saved.artifact.name,
        primerBases: input.sequence,
        chrom: current.chrom,
        start0: current.start0 + hostBinding.start,
        end0: current.start0 + hostBinding.end,
        strand: hostBinding.strand === 1 ? '+' : '-',
        source: 'created',
      };
      persistBindings((previous) => [...previous, binding]);
    },
    [persistBindings, template]
  );

  const handleDetach = useCallback(
    (bindingId: string) =>
      persistBindings((previous) => previous.filter((binding) => binding.id !== bindingId)),
    [persistBindings]
  );

  const handlePrimerClick = useCallback(
    (primer: BoundPrimer) => {
      const binding = bindings.find((candidate) => candidate.id === primer.binding.id);
      if (binding) revealBinding(binding);
    },
    [bindings, revealBinding]
  );

  const handleGoToTemplateRange = useCallback(
    (start: number, end: number) => {
      if (!template) return;
      const offset = chromGlobalStart.get(template.chrom);
      if (offset !== undefined)
        onRevealRange(offset + template.start0 + start, offset + template.start0 + end);
    },
    [chromGlobalStart, onRevealRange, template]
  );

  const drawerContent = useMemo(
    () => (
      <div data-testid="indexed-primers-drawer" className="flex h-full flex-col bg-bg">
        {!workspaceRoot && (
          <div className="border-b border-border px-3 py-2 text-xs text-fg-muted">
            Open a project to save new primers. Attached primers still show here.
          </div>
        )}
        <div className="min-h-0 flex-1">
          <PrimersDrawerContent
            primers={boundPrimers}
            isLoading={false}
            onPrimerClick={handlePrimerClick}
            onDetach={handleDetach}
            onPrimerCreate={handlePrimerCreate}
            hostOwnedBinding
            pendingCreation={template?.pending ?? null}
            onClearPendingCreation={() => setTemplate(null)}
            onGoToBinding={handleGoToTemplateRange}
            referenceSequence={template?.bases}
            sequenceLength={template?.bases.length}
            bindingCoordinateOffset={template?.start0}
            circular={false}
            {...find.drawerProps}
            {...(workspaceRoot ? { workspaceRoot } : {})}
          />
        </div>
      </div>
    ),
    [
      boundPrimers,
      find.drawerProps,
      handleDetach,
      handleGoToTemplateRange,
      handlePrimerClick,
      handlePrimerCreate,
      template,
      workspaceRoot,
    ]
  );

  const bindingAtHit = useCallback(
    (hit: { kind: string; payload?: unknown } | null | undefined) => {
      if (hit?.kind !== 'feature') return null;
      const id = (hit.payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'number') return null;
      const index = primerIndexFromRenderId(id);
      return index === null ? null : (bindings[index] ?? null);
    },
    [bindings]
  );

  const primerMenuActions = useCallback(
    (binding: IndexedGenomePrimerBinding) => {
      const loadRecord = () => primerServices.persistence.getPrimer(binding.primerId);
      const copy = () => {
        loadRecord()
          .then((record) =>
            copyPrimerRecord({
              bases: record?.sequence ?? binding.primerBases,
              modifications: record?.modifications,
            })
          )
          .catch((error: unknown) =>
            onError(error instanceof Error ? error.message : 'Could not copy the primer.')
          );
      };
      return {
        onEditPrimer: () => {
          loadRecord()
            .then(async (record) => {
              const location = record
                ? await primerArtifactLocation(record, workspaceFolders)
                : null;
              if (record && location) {
                openPrimerDocument(location, record.name);
                return;
              }
              showPrimersDrawer();
              revealBinding(binding);
            })
            .catch((error: unknown) =>
              onError(error instanceof Error ? error.message : 'Could not open the primer.')
            );
        },
        onCopyPrimerBases: copy,
        onDetachPrimer: () => handleDetach(binding.id),
      };
    },
    [handleDetach, onError, openPrimerDocument, revealBinding, showPrimersDrawer, workspaceFolders]
  );

  return {
    rendererPrimers,
    drawerContent,
    openFind: find.openFind,
    startCreatePrimer,
    bindingAtHit,
    primerMenuActions,
  };
}

function boundPrimerFromBinding(binding: IndexedGenomePrimerBinding): BoundPrimer {
  const bases = binding.primerBases;
  const gc = bases.length
    ? (Array.from(bases.toUpperCase()).filter((base) => base === 'G' || base === 'C').length /
        bases.length) *
      100
    : 0;
  return {
    id: binding.primerId,
    catalogNumber: '',
    name: binding.primerName,
    sequence: bases,
    length: bases.length,
    tm: null,
    gcPercent: gc,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: 0,
    updatedAt: 0,
    binding: {
      id: binding.id,
      primerId: binding.primerId,
      sequenceId: -1,
      bindingStart: binding.start0,
      bindingEnd: binding.end0,
      strand: binding.strand === '+' ? 1 : -1,
      source: binding.source,
      createdAt: 0,
      updatedAt: 0,
      locationLabel: `${binding.chrom}:${(binding.start0 + 1).toLocaleString()}–${binding.end0.toLocaleString()} (${binding.strand})`,
    },
  };
}

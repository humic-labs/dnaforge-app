import type {
  ResidueSelection,
  ResidueSelectionSource,
  ResidueSelectionTarget,
  ResidueSelectionMapping,
  ResidueInterval,
  ResidueSelectionCodingDnaMapping,
  ResidueSelectionStructureMapping,
  ResidueSelectionProteinMsaMapping,
  ResidueSelectionCodingDnaInterval,
  ResidueSelectionStructureTarget,
} from './residue-selection-types';
export type {
  ResidueSelection,
  ResidueSelectionSource,
  ResidueSelectionTarget,
  ResidueSelectionMapping,
  ResidueMoleculeKind,
  ResidueInterval,
  ResidueSelectionCodingDnaMapping,
  ResidueSelectionStructureMapping,
  ResidueSelectionProteinMsaMapping,
  ResidueSelectionCodingDnaInterval,
  ResidueSelectionStructureTarget,
} from './residue-selection-types';
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react';

export type ResidueSelectionClearScope =
  | { kind: 'all' }
  | { kind: 'molecule'; moleculeId: string; moleculeKind?: string }
  | { kind: 'source'; sourceKind: string; sourceId?: string }
  | {
      kind: 'structure-session';
      structureId: string;
      moleculeId?: string;
      moleculeKind?: string;
      referenceId?: string;
      featureId?: string;
    };

export type ResidueSelectionCommand =
  | { type: 'replace'; selections: ReadonlyArray<ResidueSelection> }
  | { type: 'add'; selection: ResidueSelection }
  | { type: 'toggle'; selection: ResidueSelection }
  | { type: 'remove'; selection: ResidueSelection }
  | { type: 'clear'; scope?: ResidueSelectionClearScope };

export interface CodingDnaSelectionRange {
  start: number;
  end: number;
  strand: 1 | -1;
}

const EMPTY_SELECTION: ReadonlyArray<ResidueSelection> = Object.freeze([]);
const EMPTY_CODING_DNA_SELECTIONS: ReadonlyArray<CodingDnaSelectionRange> = Object.freeze([]);

export function sameResidueSelections(
  a: ReadonlyArray<ResidueSelection>,
  b: ReadonlyArray<ResidueSelection>
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!sameResidueSelection(a[i], b[i])) return false;
  }
  return true;
}

export function sameResidueSelection(a: ResidueSelection, b: ResidueSelection): boolean {
  return (
    a.selectionId === b.selectionId &&
    sameSource(a.source, b.source) &&
    sameTarget(a.target, b.target) &&
    sameMappings(a.mappings, b.mappings)
  );
}

export function sameResidueSelectionTarget(a: ResidueSelection, b: ResidueSelection): boolean {
  return (
    a.target.moleculeId === b.target.moleculeId &&
    a.target.moleculeKind === b.target.moleculeKind &&
    a.target.coordinateSystem === b.target.coordinateSystem &&
    sameResidueIntervals(a.target.intervals, b.target.intervals)
  );
}

function sameSource(
  a: ResidueSelectionSource | undefined,
  b: ResidueSelectionSource | undefined
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.kind === b.kind &&
      a.id === b.id &&
      a.surface === b.surface &&
      a.label === b.label)
  );
}

function sameTarget(a: ResidueSelectionTarget, b: ResidueSelectionTarget): boolean {
  return (
    a === b ||
    (a.moleculeId === b.moleculeId &&
      a.moleculeKind === b.moleculeKind &&
      a.coordinateSystem === b.coordinateSystem &&
      a.label === b.label &&
      sameResidueIntervals(a.intervals, b.intervals))
  );
}

function sameResidueIntervals(
  a: ReadonlyArray<ResidueInterval> | undefined,
  b: ReadonlyArray<ResidueInterval> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((left, index) => left.start === b[index].start && left.end === b[index].end);
}

function sameCodingDnaIntervals(
  a: ReadonlyArray<ResidueSelectionCodingDnaInterval> | undefined,
  b: ReadonlyArray<ResidueSelectionCodingDnaInterval> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((left, index) => left.start === b[index].start && left.end === b[index].end);
}

function sameMappings(
  a: ReadonlyArray<ResidueSelectionMapping> | undefined,
  b: ReadonlyArray<ResidueSelectionMapping> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((left, index) => sameMapping(left, b[index]));
}

function sameMapping(a: ResidueSelectionMapping, b: ResidueSelectionMapping): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'coding-dna': {
      const right = b as ResidueSelectionCodingDnaMapping;
      return (
        a.referenceId === right.referenceId &&
        a.featureId === right.featureId &&
        a.strand === right.strand &&
        sameCodingDnaIntervals(a.intervals, right.intervals)
      );
    }
    case 'structure': {
      const right = b as ResidueSelectionStructureMapping;
      return (
        sameStructureTarget(a, right) &&
        a.residueStart === right.residueStart &&
        a.residueEnd === right.residueEnd
      );
    }
    case 'protein-msa': {
      const right = b as ResidueSelectionProteinMsaMapping;
      return (
        a.alignmentId === right.alignmentId &&
        a.rowId === right.rowId &&
        sameResidueIntervals(a.intervals, right.intervals)
      );
    }
    default:
      return false;
  }
}

function sameStructureTarget(
  a: ResidueSelectionStructureTarget | undefined,
  b: ResidueSelectionStructureTarget | undefined
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.structureId === b.structureId &&
      a.chain === b.chain &&
      a.position === b.position &&
      a.baseChain === b.baseChain &&
      a.labelAsymId === b.labelAsymId &&
      a.authAsymId === b.authAsymId &&
      a.entityId === b.entityId &&
      a.labelSeqId === b.labelSeqId &&
      a.operator === b.operator)
  );
}

export function residueSelectionsToCodingDnaRanges(
  selections: ReadonlyArray<ResidueSelection>,
  referenceId?: string
): ReadonlyArray<CodingDnaSelectionRange> {
  if (selections.length === 0) return EMPTY_CODING_DNA_SELECTIONS;
  const ranges: CodingDnaSelectionRange[] = [];
  for (const selection of selections) {
    for (const mapping of selection.mappings ?? []) {
      if (mapping.kind !== 'coding-dna') continue;
      if (referenceId && mapping.referenceId !== referenceId) continue;
      for (const interval of mapping.intervals) {
        ranges.push({
          start: interval.start,
          end: interval.end,
          strand: mapping.strand,
        });
      }
    }
  }
  return ranges.length === 0 ? EMPTY_CODING_DNA_SELECTIONS : ranges;
}

export function sameCodingDnaSelectionRanges(
  a: ReadonlyArray<CodingDnaSelectionRange>,
  b: ReadonlyArray<CodingDnaSelectionRange>
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left.start !== right.start || left.end !== right.end || left.strand !== right.strand) {
      return false;
    }
  }
  return true;
}

export interface ResidueSelectionsStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ReadonlyArray<ResidueSelection>;
  getRevision: () => number;
  set: (next: ReadonlyArray<ResidueSelection>) => void;
  dispatch: (command: ResidueSelectionCommand) => void;
}

export function applyResidueSelectionCommand(
  current: ReadonlyArray<ResidueSelection>,
  command: ResidueSelectionCommand
): ReadonlyArray<ResidueSelection> {
  switch (command.type) {
    case 'replace':
      return command.selections;
    case 'add':
      if (current.some((item) => sameResidueSelectionTarget(item, command.selection))) {
        return current;
      }
      return [...current, command.selection];
    case 'toggle': {
      const withoutMatchingTarget = current.filter(
        (item) => !sameResidueSelectionTarget(item, command.selection)
      );
      if (withoutMatchingTarget.length === current.length) {
        return [...current, command.selection];
      }
      return withoutMatchingTarget;
    }
    case 'remove':
      return current.filter((item) => !sameResidueSelectionTarget(item, command.selection));
    case 'clear': {
      const scope = command.scope ?? { kind: 'all' as const };
      if (scope.kind === 'all') return EMPTY_SELECTION;
      return current.filter((selection) => !selectionMatchesClearScope(selection, scope));
    }
    default:
      return current;
  }
}

export function replaceResidueSelectionForMolecule(
  current: ReadonlyArray<ResidueSelection>,
  selection: ResidueSelection
): ReadonlyArray<ResidueSelection> {
  return [
    ...current.filter(
      (item) =>
        item.target.moleculeId !== selection.target.moleculeId ||
        item.target.moleculeKind !== selection.target.moleculeKind
    ),
    selection,
  ];
}

export function findResidueSelectionForMolecule(
  current: ReadonlyArray<ResidueSelection>,
  target: Pick<ResidueSelectionTarget, 'moleculeId' | 'moleculeKind'>
): ResidueSelection | undefined {
  return current.find(
    (item) =>
      item.target.moleculeId === target.moleculeId &&
      item.target.moleculeKind === target.moleculeKind
  );
}

export function hasResidueSelectionForMolecule(
  current: ReadonlyArray<ResidueSelection>,
  target: Pick<ResidueSelectionTarget, 'moleculeId' | 'moleculeKind'>
): boolean {
  return !!findResidueSelectionForMolecule(current, target);
}

function selectionMatchesClearScope(
  selection: ResidueSelection,
  scope: Exclude<ResidueSelectionClearScope, { kind: 'all' }>
): boolean {
  switch (scope.kind) {
    case 'molecule':
      return (
        selection.target.moleculeId === scope.moleculeId &&
        (!scope.moleculeKind || selection.target.moleculeKind === scope.moleculeKind)
      );
    case 'source':
      return (
        selection.source?.kind === scope.sourceKind &&
        (scope.sourceId === undefined || selection.source.id === scope.sourceId)
      );
    case 'structure-session':
      return (
        (selection.source?.kind === 'structure' && selection.source.id === scope.structureId) ||
        Boolean(
          selection.mappings?.some(
            (mapping) =>
              (mapping.kind === 'structure' && mapping.structureId === scope.structureId) ||
              (mapping.kind === 'coding-dna' &&
                scope.referenceId !== undefined &&
                mapping.referenceId === scope.referenceId &&
                (scope.featureId === undefined || mapping.featureId === scope.featureId))
          )
        ) ||
        Boolean(
          scope.moleculeId &&
          selection.target.moleculeId === scope.moleculeId &&
          (!scope.moleculeKind || selection.target.moleculeKind === scope.moleculeKind)
        )
      );
    default:
      return false;
  }
}

export function createResidueSelectionsStore(): ResidueSelectionsStore {
  let current: ReadonlyArray<ResidueSelection> = EMPTY_SELECTION;
  let revision = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyArray<ResidueSelection>) => {
    const resolved = next.length === 0 ? EMPTY_SELECTION : next;
    if (sameResidueSelections(current, resolved)) return;
    current = resolved;
    revision += 1;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return current;
    },
    getRevision() {
      return revision;
    },
    set(next) {
      publish(next);
    },
    dispatch(command) {
      publish(applyResidueSelectionCommand(current, command));
    },
  };
}

const ResidueSelectionsContext = createContext<ResidueSelectionsStore | null>(null);

export const ResidueSelectionsProvider = ResidueSelectionsContext.Provider;

const NOOP_SUBSCRIBE = () => () => {};
const EMPTY_SNAPSHOT = (): ReadonlyArray<ResidueSelection> => EMPTY_SELECTION;

export function useResidueSelections(): ReadonlyArray<ResidueSelection> {
  const store = useContext(ResidueSelectionsContext);
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : NOOP_SUBSCRIBE()),
    [store]
  );
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? EMPTY_SELECTION, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, EMPTY_SNAPSHOT);
}

export function useResidueSelectionsStore(): ResidueSelectionsStore | null {
  return useContext(ResidueSelectionsContext);
}

export function useCreateResidueSelectionsStore(): ResidueSelectionsStore {
  const ref = useRef<ResidueSelectionsStore | null>(null);
  if (ref.current === null) ref.current = createResidueSelectionsStore();
  return ref.current;
}

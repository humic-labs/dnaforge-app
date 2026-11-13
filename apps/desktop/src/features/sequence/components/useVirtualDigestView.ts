import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { BackboneSegment } from '@waypoint/plasmid-viewer';
import type { CutSitesState } from '@waypoint/workspace-editor';
import type { TabViewState } from '../../canvas/public/types';
import { useAssemblyColorScheme } from '../../design/public/color-scheme-store';
import { getFragmentColor } from '../../assembly-panel/public/components/VirtualDigestPanel';
import {
  toDigestSourceAnnotations,
  useVirtualDigestCalculation,
  type VirtualDigestFragment,
} from '../../assembly-panel/public/hooks/useVirtualDigest';
import type { SelectionRange } from '../selection-state';
import { subscribeAnalyticsCaptureReady } from '../../../lib/analytics';
import { TELEMETRY_EPISODE_STARTED_EVENT } from '../../../lib/telemetry-correlation';
import {
  createDigestWorkflow,
  digestReceiptFor,
  safelyObserveDigest,
  type DigestUseOperation,
} from '../../assembly-panel/public/digest-workflow';

type DigestPanelSection = 'enzymes' | 'digest';

interface UseVirtualDigestViewInput {
  ownerKey: string;
  sourceIdentity: string;
  viewState: TabViewState | undefined;
  setViewState: (updates: Partial<TabViewState>) => void;
  cutSitesState: CutSitesState;
  sequence: AnnotatedSequence;
  backboneSegments?: BackboneSegment[];
  selectedRange: SelectionRange | null;
  onFragmentSelect: (range: SelectionRange, scrollPosition: number) => void;
}

export function useVirtualDigestView({
  ownerKey,
  sourceIdentity,
  viewState,
  setViewState,
  cutSitesState,
  sequence,
  backboneSegments,
  selectedRange,
  onFragmentSelect,
}: UseVirtualDigestViewInput) {
  const assemblyColorScheme = useAssemblyColorScheme();
  const currentOwner = useRef(ownerKey);
  const currentSourceIdentity = useRef(sourceIdentity);
  const currentDocumentId = useRef(sequence.id);
  const [selectionAttempt, setSelectionAttempt] = useState<object | null>(null);
  const [digestAttempt, setDigestAttempt] = useState<object | null>(null);
  const pendingSelection = useRef<{
    operation: DigestUseOperation;
    result: unknown;
    range: SelectionRange;
  } | null>(null);
  const digestWorkflow = useRef<ReturnType<typeof createDigestWorkflow> | null>(null);
  if (!digestWorkflow.current) digestWorkflow.current = createDigestWorkflow();
  const [hoveredDigestFragment, setHoveredDigestFragment] = useState<VirtualDigestFragment | null>(
    null
  );

  const activeVirtualDigestEnzyme = viewState?.virtualDigestEnzyme ?? null;
  const activeVirtualDigestEnzymeNames = useMemo(() => {
    const stored = viewState?.virtualDigestEnzymes;
    if (Array.isArray(stored)) {
      return stored.filter((name): name is string => typeof name === 'string');
    }
    return activeVirtualDigestEnzyme ? [activeVirtualDigestEnzyme] : [];
  }, [activeVirtualDigestEnzyme, viewState?.virtualDigestEnzymes]);
  const activeVirtualDigestLabel = activeVirtualDigestEnzymeNames.join(' + ');
  const expandedSection: DigestPanelSection = viewState?.digestPanelExpanded ? 'digest' : 'enzymes';

  const virtualDigestEnzymes = useMemo(() => {
    if (activeVirtualDigestEnzymeNames.length === 0) return undefined;
    const activeByName = new Map(
      cutSitesState.activeEnzymes.map((enzyme) => [enzyme.name, enzyme])
    );
    return activeVirtualDigestEnzymeNames
      .map((enzymeName) => activeByName.get(enzymeName))
      .filter((enzyme): enzyme is NonNullable<typeof enzyme> => Boolean(enzyme));
  }, [activeVirtualDigestEnzymeNames, cutSitesState.activeEnzymes]);

  const sourceAnnotations = useMemo(
    () => toDigestSourceAnnotations(sequence.annotations),
    [sequence.annotations]
  );
  const digestCalculation = useVirtualDigestCalculation(
    sequence.sequence,
    virtualDigestEnzymes?.length === activeVirtualDigestEnzymeNames.length
      ? virtualDigestEnzymes
      : undefined,
    sourceAnnotations,

    { circular: sequence.circular === true }
  );

  const calculationRevision = useMemo(() => ({}), [digestCalculation]);
  const virtualDigestResult = digestCalculation.result;
  const currentDigestResult = useRef(virtualDigestResult);
  const currentCalculationRevision = useRef<object | null>(calculationRevision);
  const virtualDigestError = digestCalculation.errorClass;
  const digestKey = activeVirtualDigestEnzymeNames.join('\u0000');
  useLayoutEffect(() => {
    if (
      currentOwner.current !== ownerKey ||
      currentSourceIdentity.current !== sourceIdentity ||
      currentDocumentId.current !== sequence.id
    ) {
      safelyObserveDigest(() => digestWorkflow.current?.retire());
      currentOwner.current = ownerKey;
      currentSourceIdentity.current = sourceIdentity;
      currentDocumentId.current = sequence.id;
    }
    currentDigestResult.current = virtualDigestResult;
    currentCalculationRevision.current = calculationRevision;
    safelyObserveDigest(() =>
      digestWorkflow.current?.commit(
        digestKey,
        virtualDigestResult,
        virtualDigestError,
        calculationRevision
      )
    );
  }, [
    digestKey,
    virtualDigestResult,
    virtualDigestError,
    calculationRevision,
    ownerKey,
    sourceIdentity,
    sequence.id,
    digestAttempt,
  ]);
  useLayoutEffect(() => {
    const retireChangedContext = () =>
      safelyObserveDigest(() => digestWorkflow.current?.retireIfContextChanged());
    const unsubscribe = safelyObserveDigest(() =>
      subscribeAnalyticsCaptureReady(retireChangedContext)
    );
    safelyObserveDigest(() => {
      if (typeof window !== 'undefined')
        window.addEventListener(TELEMETRY_EPISODE_STARTED_EVENT, retireChangedContext);
    });
    return () => {
      safelyObserveDigest(() => unsubscribe?.());
      safelyObserveDigest(() => {
        if (typeof window !== 'undefined')
          window.removeEventListener(TELEMETRY_EPISODE_STARTED_EVENT, retireChangedContext);
      });
      currentDigestResult.current = null;
      currentCalculationRevision.current = null;
      pendingSelection.current = null;
      safelyObserveDigest(() => digestWorkflow.current?.retire());
    };
  }, []);

  const digestBackboneSegments = useMemo((): BackboneSegment[] => {
    if (!virtualDigestResult?.fragments.length) return [];

    const hasHoveredFragment = hoveredDigestFragment !== null;
    const seqLength = sequence.length;
    const segments: BackboneSegment[] = [];

    for (const fragment of virtualDigestResult.fragments) {
      const color = getFragmentColor(fragment, assemblyColorScheme);
      const isHovered = hoveredDigestFragment?.index === fragment.index;
      const strokeWidth = isHovered ? 7 : 5;
      const label = `Fragment ${fragment.index + 1}`;

      if (fragment.wrapsOrigin) {
        const labelPosAbsolute = Math.round((fragment.labelPosition ?? 0.5) * seqLength);
        segments.push({
          start: fragment.startPosition,
          end: seqLength,
          color,
          label,
          labelPosition: labelPosAbsolute,
          strokeWidth,
          alpha: hasHoveredFragment && !isHovered ? 0.22 : 1,
          themeStableColor: true,
        });
        segments.push({
          start: 0,
          end: fragment.endPosition,
          color,
          label: '',
          strokeWidth,
          alpha: hasHoveredFragment && !isHovered ? 0.22 : 1,
          themeStableColor: true,
        });
      } else {
        segments.push({
          start: fragment.startPosition,
          end: fragment.endPosition,
          color,
          label,
          strokeWidth,
          alpha: hasHoveredFragment && !isHovered ? 0.22 : 1,
          themeStableColor: true,
        });
      }
    }

    return segments;
  }, [assemblyColorScheme, virtualDigestResult?.fragments, hoveredDigestFragment, sequence.length]);

  const mergedBackboneSegments = useMemo(() => {
    if (digestBackboneSegments.length > 0) return digestBackboneSegments;
    return backboneSegments;
  }, [digestBackboneSegments, backboneSegments]);

  const digestFocusRange = useMemo(() => {
    if (!hoveredDigestFragment || hoveredDigestFragment.length >= sequence.length) return null;
    return {
      start: hoveredDigestFragment.startPosition,
      end: hoveredDigestFragment.endPosition,
      wraps: hoveredDigestFragment.wrapsOrigin,
    };
  }, [hoveredDigestFragment, sequence.length]);

  const handleDigestFragmentHover = useCallback((fragment: VirtualDigestFragment | null) => {
    setHoveredDigestFragment(fragment);
  }, []);

  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (!pending) return;
    pendingSelection.current = null;
    if (pending.result !== virtualDigestResult) return;
    if (
      selectedRange &&
      selectedRange.start === pending.range.start &&
      selectedRange.end === pending.range.end &&
      Boolean(selectedRange.wraps) === Boolean(pending.range.wraps)
    ) {
      safelyObserveDigest(() =>
        pending.operation.complete({
          status: 'selected',
          selectedCount: 1,
          outcomeKind: 'digest_use_accepted',
        })
      );
    } else {
      safelyObserveDigest(() =>
        pending.operation.fail('validation', {
          status: 'blocked',
          selectedCount: 0,
          outcomeKind: 'digest_use_refused',
        })
      );
    }
  }, [selectedRange, virtualDigestResult, selectionAttempt]);

  const handleDigestFragmentClick = useCallback(
    (fragment: VirtualDigestFragment) => {
      if (
        currentOwner.current !== ownerKey ||
        currentSourceIdentity.current !== sourceIdentity ||
        currentDocumentId.current !== sequence.id ||
        currentCalculationRevision.current !== calculationRevision ||
        currentDigestResult.current !== virtualDigestResult ||
        !virtualDigestResult?.fragments.includes(fragment)
      )
        return;
      const receipt = digestReceiptFor(virtualDigestResult.fragments);
      const selection = safelyObserveDigest(() => receipt?.beginUse(fragment, 'select'));
      const seqLen = sequence.length;
      const endInclusive = (fragment.endPosition - 1 + seqLen) % seqLen;
      const range = {
        start: fragment.startPosition,
        end: endInclusive,
        wraps: fragment.wrapsOrigin || endInclusive < fragment.startPosition,
      };
      pendingSelection.current = selection
        ? { operation: selection, result: virtualDigestResult, range }
        : null;
      try {
        onFragmentSelect(range, fragment.startPosition + 1);
        if (selection) safelyObserveDigest(() => setSelectionAttempt({}));
      } catch (error) {
        pendingSelection.current = null;
        safelyObserveDigest(() =>
          selection?.fail('unknown', { outcomeKind: 'digest_use_refused' })
        );
        throw error;
      }
    },
    [
      onFragmentSelect,
      sequence.length,
      virtualDigestResult,
      ownerKey,
      sourceIdentity,
      sequence.id,
      calculationRevision,
    ]
  );

  const handleVirtualDigest = useCallback(
    (enzymeNamesInput: string | string[]) => {
      const enzymeNames = Array.isArray(enzymeNamesInput) ? enzymeNamesInput : [enzymeNamesInput];
      const currentKey = activeVirtualDigestEnzymeNames.join('\u0000');
      const nextKey = enzymeNames.join('\u0000');
      const nextNames = currentKey === nextKey ? [] : enzymeNames;
      safelyObserveDigest(() => digestWorkflow.current?.request(nextNames.join('\u0000')));
      try {
        setViewState({
          virtualDigestEnzymes: nextNames.length > 0 ? nextNames : null,
          virtualDigestEnzyme:
            nextNames.length === 0
              ? null
              : nextNames.length === 1
                ? nextNames[0]
                : nextNames.join(' + '),
          digestPanelExpanded: nextNames.length > 0,
        });
        safelyObserveDigest(() => setDigestAttempt({}));
      } catch (error) {
        safelyObserveDigest(() => digestWorkflow.current?.retire());
        throw error;
      }
    },
    [activeVirtualDigestEnzymeNames, setViewState]
  );

  const handleClearVirtualDigest = useCallback(() => {
    safelyObserveDigest(() => digestWorkflow.current?.request(''));
    try {
      setViewState({ virtualDigestEnzyme: null, virtualDigestEnzymes: null });
      safelyObserveDigest(() => setDigestAttempt({}));
    } catch (error) {
      safelyObserveDigest(() => digestWorkflow.current?.retire());
      throw error;
    }
  }, [setViewState]);

  const handleEnzymesCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (!collapsed) setViewState({ digestPanelExpanded: false });
    },
    [setViewState]
  );

  const handleDigestCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (!collapsed) setViewState({ digestPanelExpanded: true });
    },
    [setViewState]
  );

  useEffect(() => {
    if (activeVirtualDigestEnzymeNames.length === 0) return;
    const activeNames = new Set(cutSitesState.activeEnzymes.map((enzyme) => enzyme.name));
    const stillActive = activeVirtualDigestEnzymeNames.every((enzymeName) =>
      activeNames.has(enzymeName)
    );
    if (!stillActive) {
      safelyObserveDigest(() => digestWorkflow.current?.request('', 'system'));
      setViewState({ virtualDigestEnzyme: null, virtualDigestEnzymes: null });
    }
  }, [activeVirtualDigestEnzymeNames, cutSitesState.activeEnzymes, setViewState]);

  return {
    activeVirtualDigestEnzyme,
    activeVirtualDigestEnzymeNames,
    activeVirtualDigestLabel,
    expandedSection,
    virtualDigestResult,
    virtualDigestError,
    hoveredDigestFragment,
    mergedBackboneSegments,
    digestFocusRange,
    handleVirtualDigest,
    handleClearVirtualDigest,
    handleDigestFragmentHover,
    handleDigestFragmentClick,
    handleEnzymesCollapsedChange,
    handleDigestCollapsedChange,
  };
}

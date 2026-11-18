'use client';

import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { IUPAC_EXPANSION, type AnnotatedSequence, type Annotation } from '@waypoint/sequence-utils';
import { DesignSaveStatus } from './DesignSaveStatus';
import { useDesignSaveOwner } from './useDesignSaveOwner';
import { useEmbeddedAssemblyWorkingCopyOwner } from './useEmbeddedAssemblyWorkingCopyOwner';
import type { ParsedPlasmid, PlasmidFeature, Primer } from '@waypoint/plasmid-viewer';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import {
  recordWebGLSelectionDebug,
  type BackbonePartHitPayload,
  type BackbonePartReorderPreview,
} from '@waypoint/genome-renderer';
import { WorkspaceViewer } from '../../sequence/public/components/WorkspaceViewer';
import { DOCUMENT_TAB_UNDERBAR_MIN_CLASS } from '../../sequence/public/document-tab-underbar';
import type { CopySelection } from '../../sequence/public/components/useSequenceClipboardActions';
import { useDesignStore } from '../store';
import {
  placeDigestTransfer,
  refuseDigestTransfer,
} from '../../assembly-panel/public/digest-workflow';
import { copiedRegionContext } from '../copied-region-presentation';
import { buildCopiedRegionFromDesignRegion } from '../annotation-transfer';
import { getComposedSequence, ENZYME_SPECS, type SequenceDesign } from '../types';
import { useRichSequenceClipboardStore } from '../../sequence-clipboard/public/store';
import {
  resolveSequenceClipboardText,
  writeRichSequenceClipboard,
} from '../../sequence-clipboard/public/clipboard-service';
import {
  getEffectiveDesignRegions,
  getVisibleRestrictionDigestScarSegments,
  isRestrictionDigestRegion,
  selectPhysicalDesignPrimerPairs,
} from '../restriction-digest';
import { calculateGcContent } from '../algorithms/draft-assembly';
import { getFragmentHexForRegion } from '../colors';
import { useAssemblyColorScheme } from '../color-scheme-store';
import { rdFragmentAssemblyBlockReason } from '../rd-fragment-policy';
import { useBackboneSegments, type JunctionPosition } from '../hooks/useBackboneSegments';
import { selectAssemblyBoundaryMap } from '../assembly-boundaries';
import { selectGoldenGateScarPreviews } from '../golden-gate-scar-preview';
import { deriveAssemblyIssues } from '../../assembly/public/issues/assembly-issues';
import {
  collectInternalCutSiteMarkers,
  internalCutSiteMarkersToColoredCutSites,
  type InternalCutSiteMarker,
} from '../internal-cut-sites';
import { useCanvasStore } from '../../canvas/public/store';
import type { Tab } from '../../canvas/public/types';
import { useSequenceStore } from '../../sequence/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { EditIcon } from '../../../components/icons';
import { DesignDrawer } from './DesignDrawer';
import { MocloAssemblyWorkspace } from '../../assembly-panel/public/components';
import {
  createMocloWorkspaceModel,
  isMocloMapSchemaStripEnabled,
} from '../../assembly-panel/public/moclo-workspace-model';
import { mocloCatalogCandidateToRegion, type MocloCatalogCandidate } from '../moclo-part-catalog';
import { useResizableDrawer } from '../hooks/useResizableDrawer';
import {
  artifactStemFromFileName,
  renameDesignArtifactFile,
} from '../../../db/workspace-artifacts';
import { isApplePlatform } from '../../../components/menuShortcuts';
import { resolveMocloFactoryWorkspaceRoot } from '../materialize-design-artifact';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/public/AssemblyWorkbenchReducer';
import { createAssemblyWorkbenchSession } from '../../junction-workbench/public/AssemblyWorkbenchSession';
import {
  SourceContextRegistry,
  createAssemblyWorkbenchSourceContext,
  createJunctionSourceWindowRequests,
} from '../../junction-workbench/public/SourceContextRegistry';
import type {
  WebglMapCrossoverBoundaryCommit,
  WebglMapCrossoverEditRange,
  WebglPrimerRange,
} from '../../sequence/public/components/useWebglMapInteractions';
import { projectWebglPrimerPbsBoundary } from '../../sequence/public/components/useWebglMapInteractions';
import type { WebglMapCursorNavigation } from '../../sequence/public/components/useWebglMapKeyboardNavigation';
import {
  adjustSpacersForReorder,
  detectSingleRegionMove,
  isGoldenGateFixedRegionOrderCompatible,
  reorderByInsertionSlot,
  resolveAssemblyMapInsertionSlot,
} from '../assembly-rail-reorder';

interface DesignTabProps {
  designId: string;
  tab?: Tab;
  panelId?: string;
  onExitToSequence?: () => void;
}

const ASSEMBLY_MAP_PART_REORDER_ENABLED = false;

type AssemblyMapSelection =
  | { kind: 'part'; regionId: string }
  | {
      kind: 'junction';
      junctionIndex: number;
      caretOffset: number;
    };

type AssemblyMapPrimerRange = WebglPrimerRange;
type AssemblyMapPrimerPreview = AssemblyMapPrimerRange & Pick<Primer, 'bases' | 'tm' | 'gc'>;

interface AssemblyMapPrimerPbsProjection {
  status: 'applied' | 'noop' | 'rejected';
  nextDesign: SequenceDesign;
  primer: AssemblyMapPrimerPreview;
  requestedLength: number;
}

function DesignEyebrowActions(props: {
  isAssemblyDrawerOpen: boolean;
  toggleAssemblyDrawer: () => void;
  onExitToSequence?: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      {props.onExitToSequence && (
        <button
          type="button"
          data-testid="assembly-return-to-sequence"
          onClick={props.onExitToSequence}
          className="rounded border border-border bg-bg-muted px-2 py-1 text-xs wp-interactive"
        >
          Back to sequence
        </button>
      )}
      <button
        type="button"
        data-testid="assembly-drawer-toggle"
        aria-pressed={props.isAssemblyDrawerOpen}
        onClick={props.toggleAssemblyDrawer}
        className={`flex h-7 flex-shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs transition-colors ${
          props.isAssemblyDrawerOpen
            ? 'border-accent bg-accent text-accent-fg'
            : 'border-border bg-bg-muted wp-interactive'
        }`}
        title={props.isAssemblyDrawerOpen ? 'Hide assembly details' : 'Show assembly details'}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        <span>{props.isAssemblyDrawerOpen ? 'Hide Details' : 'Assembly Details'}</span>
      </button>
    </div>
  );
}

export function DesignTab({ designId, tab, panelId, onExitToSequence }: DesignTabProps) {
  const saveCommandScope = useDesignSaveOwner({ designId, tab, panelId });
  const { exitToSequence } = useEmbeddedAssemblyWorkingCopyOwner({
    designId,
    tab,
    panelId,
    onExitToSequence,
  });
  const assemblyColorScheme = useAssemblyColorScheme();
  const design = useDesignStore((state) => state.designs[designId]);
  const addRegion = useDesignStore((state) => state.addRegion);
  const insertRegionAt = useDesignStore((state) => state.insertRegionAt);
  const updateRegion = useDesignStore((state) => state.updateRegion);
  const setGoldenGateSchema = useDesignStore((state) => state.setGoldenGateSchema);
  const reorderRegions = useDesignStore((state) => state.reorderRegions);
  const reverseComplementRegion = useDesignStore((state) => state.reverseComplementRegion);
  const setActiveDesign = useDesignStore((state) => state.setActiveDesign);
  const clearScrollPosition = useDesignStore((state) => state.clearScrollPosition);
  const clearHighlightRange = useDesignStore((state) => state.clearHighlightRange);
  const setAssemblyMethod = useDesignStore((state) => state.setAssemblyMethod);
  const setJunctionSpacer = useDesignStore((state) => state.setJunctionSpacer);
  const commitWorkbenchDesign = useDesignStore((state) => state.commitWorkbenchDesign);
  const updateDesign = useDesignStore((state) => state.updateDesign);
  const lastCopied = useRichSequenceClipboardStore((state) => state.copiedRegion);
  const mapPasteTarget = lastCopied ? copiedRegionContext(lastCopied) : undefined;
  const sourceSequences = useSequenceStore((state) => state.sequences);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const [owningWorkspaceRoot, setOwningWorkspaceRoot] = useState<string | null>(null);

  const updateTabByEntityId = useCanvasStore((state) => state.updateTabByEntityId);
  const draftContext =
    tab?.artifactDocument?.kind === 'assembly' && tab.artifactDocument.persistence === 'draft'
      ? tab.artifactDocument
      : null;

  const cursorPositionRef = useRef<number | null>(null);
  const [assemblyMapSelection, setAssemblyMapSelection] = useState<AssemblyMapSelection | null>(
    null
  );

  const [hoveredSegmentIndex] = useState<number | null>(null);

  const {
    open: isAssemblyDrawerOpen,
    setOpen: setAssemblyDrawerOpen,
    toggleOpen: toggleAssemblyDrawer,
    width: assemblyDrawerWidth,
    setWidth: setAssemblyDrawerWidth,
  } = useResizableDrawer({
    persistKey: `assembly-wide:${designId}`,
    defaultWidth: 800,
    minWidth: 480,
    maxWidth: 1100,
    defaultOpen: true,
  });

  const mocloWorkspaceModel = useMemo(
    () => (design ? createMocloWorkspaceModel(design, assemblyColorScheme) : null),
    [assemblyColorScheme, design]
  );

  useEffect(() => {
    let active = true;
    setOwningWorkspaceRoot(null);
    void (async () => {
      const workspaceRoot =
        draftContext?.workspaceRoot ??
        (design
          ? await resolveMocloFactoryWorkspaceRoot(
              design,
              Object.values(useDesignStore.getState().designs),
              workspaceFolders
            )
          : null);
      if (active) setOwningWorkspaceRoot(workspaceRoot);
    })().catch((error: unknown) => {
      if (!active) return;
      console.warn('[DesignTab] Failed to resolve assembly workspace:', error);
      setOwningWorkspaceRoot(null);
    });
    return () => {
      active = false;
    };
  }, [design, designId, draftContext?.workspaceRoot, workspaceFolders]);

  const changeMocloSchema = useCallback(
    (schema: NonNullable<SequenceDesign['goldenGateSchema']>) => {
      if (!mocloWorkspaceModel) return { ok: false, message: 'Golden Gate schema is unavailable.' };
      const result = setGoldenGateSchema(designId, schema, mocloWorkspaceModel.designVersion);
      return result.status === 'applied' || result.status === 'no-op'
        ? { ok: true }
        : { ok: false, message: toUserMessage(result, 'operation.failed') };
    },
    [designId, mocloWorkspaceModel, setGoldenGateSchema]
  );

  const replaceMocloPart = useCallback(
    (slotIndex: number, candidate: MocloCatalogCandidate) => {
      if (!mocloWorkspaceModel) return;
      const part = mocloWorkspaceModel.parts[slotIndex];
      if (!part || part.input.kind === 'stage-output') return;
      const replacement = mocloCatalogCandidateToRegion(candidate, mocloWorkspaceModel.enzyme);
      updateRegion(designId, part.regionId, {
        ...replacement,
        sourceSequenceName: candidate.source.name,
        isPlaceholder: false,
        rdSiblingOverhangs: replacement.rdSiblingOverhangs,
      });
      setAssemblyMapSelection({ kind: 'part', regionId: part.regionId });
    },
    [designId, mocloWorkspaceModel, updateRegion]
  );

  const [isEditingName, setIsEditingName] = useState(false);
  const [editingNameValue, setEditingNameValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const handleNameEditStart = useCallback(() => {
    setEditingNameValue(design?.name ?? 'Untitled');
    setIsEditingName(true);

    setTimeout(() => nameInputRef.current?.select(), 0);
  }, [design?.name]);

  const handleNameSave = useCallback(() => {
    if (!design) return;
    const newName = editingNameValue.trim() || 'Untitled';

    updateDesign(designId, { name: newName });
    updateTabByEntityId(designId, { label: newName });
    setIsEditingName(false);
    if (draftContext) return;

    void (async () => {
      try {
        const artifact = await renameDesignArtifactFile({
          designId,
          name: newName,
        });
        if (!artifact) return;
        if (useDesignStore.getState().designs[designId]?.name !== newName) return;
        const stem = artifactStemFromFileName(artifact.name, 'design');
        if (stem !== newName) {
          updateDesign(designId, { name: stem });
          updateTabByEntityId(designId, { label: stem });
        }
        window.dispatchEvent(
          new CustomEvent('waypoint:workspace-files-changed', {
            detail: { path: artifact.path },
          })
        );
      } catch (err) {
        console.warn('[DesignTab] Failed to rename backing design artifact:', err);
      }
    })();
  }, [design, designId, draftContext, editingNameValue, updateDesign, updateTabByEntityId]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        void handleNameSave();
      } else if (e.key === 'Escape') {
        setIsEditingName(false);
      }
    },
    [handleNameSave]
  );

  useEffect(() => {
    setActiveDesign(designId);
    return () => {
      const openDesignTabs: Array<{ entityId: string; isPanelActive: boolean }> = [];
      for (const panel of Object.values(useCanvasStore.getState().panels)) {
        for (const tab of panel.tabs) {
          const openDesignId =
            tab.type === 'design'
              ? tab.entityId
              : tab.type === 'sequence'
                ? tab.assemblyEditDesignId
                : null;
          if (!openDesignId) continue;
          openDesignTabs.push({
            entityId: openDesignId,
            isPanelActive: panel.activeTabId === tab.id,
          });
        }
      }

      const pointer = useDesignStore.getState().activeDesignId;
      if (pointer && openDesignTabs.some((tab) => tab.entityId === pointer)) return;

      const next = openDesignTabs.find((tab) => tab.isPanelActive) ?? openDesignTabs[0];
      setActiveDesign(next?.entityId ?? null);
    };
  }, [designId, setActiveDesign]);

  const { backboneSegments, junctionIndicators, junctionPositions, partRanges } =
    useBackboneSegments({
      design,
      hoveredSegmentIndex,
    });

  const assemblyMapEditCursorPosition = useMemo(() => {
    if (assemblyMapSelection?.kind !== 'junction') return undefined;
    const range = partRanges[assemblyMapSelection.junctionIndex];
    const sequenceLength = design
      ? getComposedSequence(getEffectiveDesignRegions(design), design.spacers).length
      : 0;
    if (!range || sequenceLength === 0) return undefined;
    const spacerLength =
      design &&
      (selectAssemblyBoundaryMap(design).get(assemblyMapSelection.junctionIndex)?.spacer?.sequence
        .length ??
        0);
    const caretOffset = Math.min(assemblyMapSelection.caretOffset, spacerLength || 0);
    const absolutePosition = range.end + caretOffset;
    return design?.topology === 'circular' ? absolutePosition % sequenceLength : absolutePosition;
  }, [assemblyMapSelection, design, partRanges]);

  const mapCrossoverEditRange = useMemo<WebglMapCrossoverEditRange | null>(() => {
    if (!design || assemblyMapSelection?.kind !== 'part') return null;
    const range = assemblyMapPartRangeForRegion(design, assemblyMapSelection.regionId);
    if (!range) return null;
    const selectedIndex = design.regions.findIndex(
      (region) => region.id === assemblyMapSelection.regionId
    );
    if (selectedIndex < 0) return null;
    const sourceRegistry = new SourceContextRegistry(sourceSequences);
    const sourceContext = createAssemblyWorkbenchSourceContext(
      sourceRegistry.resolveWindows(createJunctionSourceWindowRequests(design))
    );
    const editableFields = createAssemblyWorkbenchSession(
      design,
      createAssemblyWorkbenchViewState(design),
      { sourceContext }
    ).editableFields;
    const editableSides = assemblyMapEditableCrossoverSides(design, selectedIndex, editableFields);
    return editableSides.length > 0 ? { ...range, editableSides } : null;
  }, [assemblyMapSelection, design, sourceSequences]);

  const annotatedSequence = useMemo((): AnnotatedSequence | null => {
    if (!design) return null;

    const displayRegions = getEffectiveDesignRegions(design);
    const composedSequence = getComposedSequence(displayRegions, design.spacers);
    if (composedSequence.length === 0 && !design.goldenGateSchema?.slots.length) return null;

    const annotations: Annotation[] = [];
    const boundariesByJunction = selectAssemblyBoundaryMap(design);
    let position = 0;

    displayRegions.forEach((region, regionIndex) => {
      const regionStart = position;

      if (region.annotations) {
        region.annotations.forEach((ann) => {
          annotations.push({
            name: ann.name,
            type: ann.type,
            start: regionStart + ann.start + 1,
            end: regionStart + ann.end,
            direction: ann.strand === 'forward' ? 1 : ann.strand === 'reverse' ? -1 : 0,
            color: ann.color,
          });
        });
      }

      const rawRegion = design.regions[regionIndex] ?? region;
      for (const scar of getVisibleRestrictionDigestScarSegments(
        rawRegion,
        design.assemblyMethod
      )) {
        annotations.push({
          name: `${rawRegion.rdSourceEnzymeName ?? rawRegion.rdSourceEnzyme ?? 'RD'} ${scar.end} RD scar`,
          type: 'restriction_scar',
          start: regionStart + scar.effectiveStart + 1,
          end: regionStart + scar.effectiveEnd,
          direction: 0,
          color: '#F59E0B',
          qualifiers: {
            source: ['restriction-digest'],
            rd_end: [scar.end],
            retained_sequence: [scar.retainedSequence],
            visible_sequence: [scar.sequence],
            trimmed_bases: [String(scar.trimmedBases)],
          },
        });
      }

      position += region.sequence.length;

      const spacerAfter = boundariesByJunction.get(regionIndex)?.spacer ?? null;
      if (spacerAfter) {
        position += spacerAfter.sequence.length;
      }
    });

    return {
      id: design.id,
      name: design.name,
      sequence: composedSequence,
      length: composedSequence.length,
      annotations,
      circular: design.topology === 'circular',
    };
  }, [design]);

  const internalCutSiteMarkers = useMemo((): InternalCutSiteMarker[] => {
    if (!design) return [];
    return collectInternalCutSiteMarkers(design, deriveAssemblyIssues({ design }));
  }, [design]);

  const internalCutSiteOverlay = useMemo(() => {
    const enzyme = design?.goldenGateConfig?.enzyme;
    if (!enzyme || internalCutSiteMarkers.length === 0) return [];
    const spec = ENZYME_SPECS[enzyme];
    if (!spec) return [];

    const cutPositionTop = spec.site.length + spec.cutOffset;
    const cutPositionBottom = cutPositionTop + spec.overhangLength;
    return internalCutSiteMarkersToColoredCutSites(internalCutSiteMarkers, enzyme, spec.site, {
      cutPositionTop,
      cutPositionBottom,
    });
  }, [internalCutSiteMarkers, design?.goldenGateConfig?.enzyme]);

  const displayedDesignPrimers = useMemo(
    () => (design ? selectPhysicalDesignPrimerPairs(design) : []),
    [design?.regions, design?.designPrimers]
  );

  const sequenceViewerPrimers = useMemo((): PrimerDisplay[] => {
    if (!design) return [];

    const displayRegions = getEffectiveDesignRegions(design);
    const composedSequence = getComposedSequence(displayRegions, design.spacers);
    const composedLength = composedSequence.length;
    const isCircular = design.topology === 'circular';
    const numFragments = design.regions.length;
    const isGoldenGate = design.assemblyMethod === 'goldengate';
    const ggJunctions = design.goldenGateJunctions ?? [];
    const result: PrimerDisplay[] = [];
    const fragmentColor = (fragmentIndex: number) =>
      getFragmentHexForRegion(design.regions[fragmentIndex], fragmentIndex, assemblyColorScheme);

    for (const pair of displayedDesignPrimers ?? []) {
      const fwdOverhangLen = isGoldenGate
        ? (pair.forward.goldenGateOverhang?.fullSequence.length ?? 0)
        : (pair.forward.overhang.tailLength ?? pair.forward.overhang.sequence.length);
      const revOverhangLen = isGoldenGate
        ? (pair.reverse.goldenGateOverhang?.fullSequence.length ?? 0)
        : (pair.reverse.overhang.tailLength ?? pair.reverse.overhang.sequence.length);

      const fwdGgOh = pair.forward.goldenGateOverhang;
      const revGgOh = pair.reverse.goldenGateOverhang;
      const fwdCutPos =
        isGoldenGate && fwdGgOh
          ? fwdGgOh.padding5prime.length + fwdGgOh.enzymeSite.length + fwdGgOh.spacer.length
          : undefined;
      const revCutPos =
        isGoldenGate && revGgOh
          ? revGgOh.padding5prime.length + revGgOh.enzymeSite.length + revGgOh.spacer.length
          : undefined;

      const fwdRecogStart = isGoldenGate && fwdGgOh ? fwdGgOh.padding5prime.length : undefined;
      const fwdRecogEnd =
        isGoldenGate && fwdGgOh
          ? fwdGgOh.padding5prime.length + fwdGgOh.enzymeSite.length
          : undefined;
      const revRecogStart = isGoldenGate && revGgOh ? revGgOh.padding5prime.length : undefined;
      const revRecogEnd =
        isGoldenGate && revGgOh
          ? revGgOh.padding5prime.length + revGgOh.enzymeSite.length
          : undefined;

      const fwdJunctionData = isGoldenGate
        ? ggJunctions.find((j) => j.junctionIndex === pair.forward.junctionIndex)
        : undefined;
      const revJunctionData = isGoldenGate
        ? ggJunctions.find((j) => j.junctionIndex === pair.reverse.junctionIndex)
        : undefined;
      const fwdScarAbsPos = fwdJunctionData?.overhangStart;
      const revScarAbsPos = revJunctionData?.overhangStart;

      const fwdFragmentIdx = pair.forward.fragmentIndex;
      const fwdJunctionIdx = pair.forward.junctionIndex ?? 0;
      const fwdLeftFrag = fwdJunctionIdx;
      const fwdRightFrag = (fwdJunctionIdx + 1) % numFragments;
      const fwdHomologousFrag = fwdFragmentIdx === fwdLeftFrag ? fwdRightFrag : fwdLeftFrag;

      const rawFwdStart = pair.forward.pbs.start - fwdOverhangLen;
      const fwdStart =
        isCircular && rawFwdStart < 0 ? composedLength + rawFwdStart : Math.max(0, rawFwdStart);

      if (pair.forward.sequence !== '') {
        result.push({
          id: pair.forward.id,
          name: pair.forward.name,
          start: fwdStart,
          end: pair.forward.pbs.end,
          direction: 'forward',

          bases: pair.forward.sequence,
          tm: pair.forward.tm ?? 0,
          gc: calculateGcContent(pair.forward.pbs.sequence),
          mismatches: [],
          overhangLength: fwdOverhangLen,
          pbsColor: fragmentColor(fwdFragmentIdx),
          overhangColor: fragmentColor(fwdHomologousFrag),
          cutPositionInOverhang: fwdCutPos,
          enzymeName: isGoldenGate ? design.goldenGateConfig?.enzyme : undefined,
          recognitionStart: fwdRecogStart,
          recognitionEnd: fwdRecogEnd,
          scarAbsolutePosition: fwdScarAbsPos,
          cognate4bpLength: pair.forward.cognate4bpLength,
          synthetic4bpSpacerLength: pair.forward.synthetic4bpSpacerLength,

          spacerLength: isGoldenGate
            ? pair.forward.goldenGateOverhang?.literalSpacerLength
            : pair.forward.overhang.spacerSequence?.length,
          junctionIndex: pair.forward.junctionIndex ?? undefined,
        });
      }

      const revFragmentIdx = pair.reverse.fragmentIndex;
      const revJunctionIdx = pair.reverse.junctionIndex ?? 0;
      const revLeftFrag = revJunctionIdx;
      const revRightFrag = (revJunctionIdx + 1) % numFragments;
      const revHomologousFrag = revFragmentIdx === revLeftFrag ? revRightFrag : revLeftFrag;

      const rawRevEnd = pair.reverse.pbs.end + revOverhangLen;
      const revEnd =
        isCircular && rawRevEnd > composedLength
          ? rawRevEnd - composedLength
          : Math.min(composedLength, rawRevEnd);

      if (pair.reverse.sequence !== '') {
        result.push({
          id: pair.reverse.id,
          name: pair.reverse.name,
          start: pair.reverse.pbs.start,
          end: revEnd,
          direction: 'reverse',

          bases: pair.reverse.sequence,
          tm: pair.reverse.tm ?? 0,
          gc: calculateGcContent(pair.reverse.pbs.sequence),
          mismatches: [],
          overhangLength: revOverhangLen,
          pbsColor: fragmentColor(revFragmentIdx),
          overhangColor: fragmentColor(revHomologousFrag),
          cutPositionInOverhang: revCutPos,
          enzymeName: isGoldenGate ? design.goldenGateConfig?.enzyme : undefined,
          recognitionStart: revRecogStart,
          recognitionEnd: revRecogEnd,
          scarAbsolutePosition: revScarAbsPos,
          cognate4bpLength: pair.reverse.cognate4bpLength,
          synthetic4bpSpacerLength: pair.reverse.synthetic4bpSpacerLength,

          spacerLength: isGoldenGate
            ? pair.reverse.goldenGateOverhang?.literalSpacerLength
            : pair.reverse.overhang.spacerSequence?.length,
          junctionIndex: pair.reverse.junctionIndex ?? undefined,
        });
      }
    }

    if (isGoldenGate && composedLength > 0) {
      const junctionsWithPrimerScars = new Set<number>();
      for (const pair of displayedDesignPrimers ?? []) {
        if (pair.forward.sequence !== '' && pair.forward.junctionIndex !== null) {
          junctionsWithPrimerScars.add(pair.forward.junctionIndex);
        }
      }

      for (const junction of selectGoldenGateScarPreviews(design)) {
        if (
          junction.junctionIndex !== undefined &&
          junctionsWithPrimerScars.has(junction.junctionIndex)
        )
          continue;
        const scarStart =
          ((junction.overhangStart % composedLength) + composedLength) % composedLength;
        const rawScarEnd = scarStart + junction.overhang.length;
        const scarEnd =
          isCircular && rawScarEnd > composedLength ? rawScarEnd - composedLength : rawScarEnd;
        result.push({
          id: `scar-marker-${junction.junctionIndex ?? 'start'}`,
          name:
            junction.junctionIndex === undefined
              ? 'Digest end'
              : `Scar ${junction.junctionIndex + 1}`,
          start: scarStart,
          end: scarEnd,
          direction: 'forward',
          bases: junction.overhang,
          tm: 0,
          gc: 0,
          mismatches: [],
          overhangLength: junction.overhang.length,
          pbsColor: 'transparent',
          overhangColor: 'transparent',
          cutPositionInOverhang: 1,
          enzymeName: junction.enzyme,
          scarAbsolutePosition: scarStart,
          junctionIndex: junction.junctionIndex,
          isScarMarkerOnly: true,
        });
      }
    }

    return result;
  }, [
    displayedDesignPrimers,
    design?.regions,
    design?.spacers,
    design?.topology,
    design?.assemblyMethod,
    design?.goldenGateConfig?.enzyme,
    design?.goldenGateJunctions,
    assemblyColorScheme,
  ]);

  const primers = useMemo((): Primer[] => {
    if (!design?.designPrimers) return [];

    const result: Primer[] = [];
    for (const pair of displayedDesignPrimers) {
      if (pair.forward.sequence !== '') {
        result.push({
          id: pair.forward.id,
          name: pair.forward.name,
          start: pair.forward.pbs.start,
          end: pair.forward.pbs.end,
          direction: 'forward',
          bases: pair.forward.sequence,
          tm: pair.forward.tm ?? 0,
          gc: calculateGcContent(pair.forward.pbs.sequence),
          mismatches: [],
          hasExplicitSequence: true,
        });
      }

      if (pair.reverse.sequence !== '') {
        result.push({
          id: pair.reverse.id,
          name: pair.reverse.name,
          start: pair.reverse.pbs.start,
          end: pair.reverse.pbs.end,
          direction: 'reverse',
          bases: pair.reverse.sequence,
          tm: pair.reverse.tm ?? 0,
          gc: calculateGcContent(pair.reverse.pbs.sequence),
          mismatches: [],
          hasExplicitSequence: true,
        });
      }
    }
    return result;
  }, [displayedDesignPrimers]);

  const parsedPlasmid = useMemo((): ParsedPlasmid | null => {
    if (!annotatedSequence) return null;

    const features: PlasmidFeature[] = annotatedSequence.annotations.map((ann) => ({
      type: ann.type,
      displayName: ann.name,
      start: ann.start,
      end: ann.end,
      direction: ann.direction === 1 ? 'forward' : ann.direction === -1 ? 'reverse' : 'none',
      color: ann.color ?? '#cccccc',
      qualifiers: {},
    }));

    return {
      name: annotatedSequence.name,
      sequence: annotatedSequence.sequence,
      length: annotatedSequence.length,
      circular: annotatedSequence.circular ?? false,
      features,
      primers,
    };
  }, [annotatedSequence, primers]);

  const findJunctionAtCursor = useCallback(
    (cursorPos: number | null): JunctionPosition | null => {
      if (cursorPos === null) return null;
      const sequenceLength = annotatedSequence?.length ?? 0;
      const tolerance = Math.max(1, Math.min(12, Math.ceil(sequenceLength / 500)));
      return (
        junctionPositions.find((junction) => {
          const directDistance = Math.abs(junction.position - cursorPos);
          if (design?.topology !== 'circular' || sequenceLength === 0) {
            return directDistance <= tolerance;
          }
          const wrappedDistance = sequenceLength - directDistance;
          return Math.min(directDistance, wrappedDistance) <= tolerance;
        }) ?? null
      );
    },
    [annotatedSequence?.length, design?.topology, junctionPositions]
  );

  const insertRegionAtJunction = useCallback(
    (
      junction: JunctionPosition | null,
      regionData: Omit<import('../types').DesignRegion, 'id'>
    ) => {
      if (junction) {
        insertRegionAt(designId, junction.insertIndex, regionData);
        return;
      }

      const latestDesign = useDesignStore.getState().designs[designId];
      const placeholder = latestDesign?.regions.find((r) => r.isPlaceholder);
      if (placeholder) {
        updateRegion(designId, placeholder.id, { ...regionData, isPlaceholder: false });
        return;
      }

      addRegion(designId, regionData);
    },
    [designId, insertRegionAt, updateRegion, addRegion]
  );

  const processPasteText = useCallback(
    (text: string, cursorPosition: number | null, currentDesign: typeof design) => {
      if (!currentDesign) return;

      const junction = findJunctionAtCursor(cursorPosition);

      const hasPlaceholder = currentDesign.regions.some((r) => r.isPlaceholder);
      if (currentDesign.regions.length > 0 && !junction && !hasPlaceholder) {
        console.log('Paste rejected: cursor not at a junction position');
        return;
      }

      const resolvedClipboard = resolveSequenceClipboardText(text);
      if (!resolvedClipboard) return;
      const pasted = resolvedClipboard.fragment;

      if (pasted.sourceType === 'rd') {
        const blockReason = rdFragmentAssemblyBlockReason(
          currentDesign.assemblyMethod,
          pasted.ggType
        );
        if (blockReason) {
          refuseDigestTransfer(pasted);
          console.log(blockReason);
          return;
        }
      }

      if (
        pasted.sourceType === 'rd' &&
        pasted.rdSourceEnzyme &&
        currentDesign.assemblyMethod === 'goldengate'
      ) {
        const existingRdFragments = currentDesign.regions.filter(
          (region) => (region.sourceType === 'rd' || region.rdOverhangs) && region.rdSourceEnzyme
        );
        if (existingRdFragments.length > 0) {
          const existingEnzyme = existingRdFragments[0].rdSourceEnzyme;
          if (existingEnzyme !== pasted.rdSourceEnzyme) {
            refuseDigestTransfer(pasted);
            alert(
              `Cannot add this fragment.\n\nThis fragment uses ${pasted.rdSourceEnzyme} but your assembly already has fragments from ${existingEnzyme}.\n\nRemove existing RD fragments to switch enzymes.`
            );
            return;
          }
        }
      }

      if (
        pasted.sourceType === 'rd' &&
        pasted.rdSourceEnzyme &&
        currentDesign.assemblyMethod === 'goldengate'
      ) {
        const existingRdFragments = currentDesign.regions.filter(
          (region) => (region.sourceType === 'rd' || region.rdOverhangs) && region.rdSourceEnzyme
        );
        if (
          existingRdFragments.length === 0 &&
          currentDesign.goldenGateConfig?.enzyme !== pasted.rdSourceEnzyme
        ) {
          setAssemblyMethod(designId, 'goldengate', pasted.rdSourceEnzyme);
        }
      }

      placeDigestTransfer(
        pasted,
        () => useDesignStore.getState().designs[designId]?.regions,
        () =>
          insertRegionAtJunction(junction, {
            sourceSequenceId: pasted.sourceId,
            sourceSequenceName: pasted.sourceName,
            sourceStart: pasted.start,
            sourceEnd: pasted.end,
            sequence: pasted.sequence,
            annotations: pasted.annotations,
            sourceSequence: pasted.sourceSequence,
            sourceAnnotations: pasted.sourceAnnotations,
            sourceIsCircular: pasted.sourceIsCircular,
            ...(pasted.sourceType === 'rd' && {
              sourceType: 'rd' as const,
              ggType: pasted.ggType,
              rdOverhangs: pasted.rdOverhangs,
              rdSourceEnzyme: pasted.rdSourceEnzyme,
              rdSourceEnzymeName: pasted.rdSourceEnzymeName,
              rdEnds: pasted.rdEnds,
              rdSiblingOverhangs: pasted.rdSiblingOverhangs,
            }),
          })
      );
    },
    [designId, findJunctionAtCursor, insertRegionAtJunction, setAssemblyMethod]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (!design) return;
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (!text) return;
      processPasteText(text, cursorPositionRef.current, design);
    },
    [design, processPasteText]
  );

  const handleContextMenuPaste = useCallback(
    async (cursorPosition: number | null) => {
      if (!design) return;
      try {
        const text = await navigator.clipboard.readText();
        if (!text?.trim()) return;

        const currentDesign = useDesignStore.getState().designs[designId];
        if (!currentDesign) return;
        processPasteText(text.trim(), cursorPosition, currentDesign);
      } catch (err) {
        console.error('Failed to read clipboard:', err);
      }
    },
    [design, designId, processPasteText]
  );

  const handleCursorChange = useCallback((position: number | null) => {
    cursorPositionRef.current = position;
  }, []);

  const handleAssemblyMapPositionClick = useCallback(
    (position: number) => {
      const boundaries = design ? selectAssemblyBoundaryMap(design) : null;
      const spacerHit = partRanges.find((range, junctionIndex) => {
        const spacerLength = boundaries?.get(junctionIndex)?.spacer?.sequence.length ?? 0;
        return spacerLength > 0 && position >= range.end && position <= range.end + spacerLength;
      });
      if (spacerHit) {
        const junctionIndex = partRanges.indexOf(spacerHit);
        const spacerLength = boundaries?.get(junctionIndex)?.spacer?.sequence.length ?? 0;
        setAssemblyMapSelection({
          kind: 'junction',
          junctionIndex,
          caretOffset: Math.min(spacerLength, Math.max(0, Math.round(position - spacerHit.end))),
        });
        return;
      }
      const junction = findJunctionAtCursor(position);
      if (junction?.kind === 'junction') {
        const spacerLength =
          design &&
          (selectAssemblyBoundaryMap(design).get(junction.junctionIndex)?.spacer?.sequence.length ??
            0);
        setAssemblyMapSelection({
          kind: 'junction',
          junctionIndex: junction.junctionIndex,
          caretOffset: spacerLength || 0,
        });
        return;
      }
      if (junction) {
        setAssemblyMapSelection(null);
        return;
      }
      const part = partRanges.find((range) => position >= range.start && position < range.end);
      setAssemblyMapSelection(part ? { kind: 'part', regionId: part.regionId } : null);
    },
    [design, findJunctionAtCursor, partRanges]
  );

  const handleAssemblyMapCursorNavigate = useCallback(
    ({ position, selecting }: WebglMapCursorNavigation) => {
      if (selecting || !design) {
        setAssemblyMapSelection(null);
        return;
      }

      const sequenceLength = annotatedSequence?.length ?? 0;
      const boundaries = selectAssemblyBoundaryMap(design);
      const junctionIndex = partRanges.findIndex((range, index) => {
        const spacerLength = boundaries.get(index)?.spacer?.sequence.length ?? 0;
        const offset =
          design.topology === 'circular' && sequenceLength > 0
            ? (((position - range.end) % sequenceLength) + sequenceLength) % sequenceLength
            : position - range.end;
        return offset >= 0 && offset <= spacerLength;
      });
      if (junctionIndex < 0) {
        setAssemblyMapSelection(null);
        return;
      }

      const range = partRanges[junctionIndex];
      const spacerLength = boundaries.get(junctionIndex)?.spacer?.sequence.length ?? 0;
      const caretOffset =
        design.topology === 'circular' && sequenceLength > 0
          ? (((position - range.end) % sequenceLength) + sequenceLength) % sequenceLength
          : position - range.end;
      setAssemblyMapSelection({
        kind: 'junction',
        junctionIndex,
        caretOffset: Math.min(spacerLength, caretOffset),
      });
    },
    [annotatedSequence?.length, design, partRanges]
  );

  const handleAssemblyMapPartSelect = useCallback((part: BackbonePartHitPayload) => {
    setAssemblyMapSelection({ kind: 'part', regionId: part.regionId });
  }, []);

  const handleAssemblyMapCopy = useCallback(
    async (selection: CopySelection) => {
      try {
        const selectedPart = design
          ? partRanges.find(
              (range) => range.start === selection.start && range.end === selection.end
            )
          : undefined;
        const selectedRegion =
          design && selectedPart
            ? getEffectiveDesignRegions(design).find(
                (region) => region.id === selectedPart.regionId
              )
            : undefined;

        if (selectedRegion?.sequence === selection.sequence) {
          await writeRichSequenceClipboard(buildCopiedRegionFromDesignRegion(selectedRegion));
          return;
        }

        await navigator.clipboard.writeText(selection.sequence);
        useRichSequenceClipboardStore.getState().clear();
      } catch (err) {
        console.error('Failed to copy assembly part to clipboard:', err);
      }
    },
    [design, partRanges]
  );

  const previewAssemblyMapPartReorder = useCallback(
    (part: BackbonePartHitPayload, targetBp: number): BackbonePartReorderPreview | null => {
      const currentDesign = useDesignStore.getState().designs[designId];
      return currentDesign
        ? (projectAssemblyMapPartReorder(currentDesign, part.regionId, targetBp)?.preview ?? null)
        : null;
    },
    [designId]
  );

  const commitAssemblyMapPartReorder = useCallback(
    (part: BackbonePartHitPayload, targetBp: number) => {
      const currentDesign = useDesignStore.getState().designs[designId];
      if (!currentDesign) return;
      const projection = projectAssemblyMapPartReorder(currentDesign, part.regionId, targetBp);
      if (!projection) return;
      reorderRegions(designId, projection.orderedRegionIds);
      setAssemblyMapSelection({ kind: 'part', regionId: part.regionId });
      recordWebGLSelectionDebug('DesignTab.partReorderCommit', {
        regionId: part.regionId,
        sourceIndex: projection.sourceIndex,
        insertionSlot: projection.insertionSlot,
        targetBp,
        reorderedIds: projection.orderedRegionIds,
      });
    },
    [designId, reorderRegions]
  );

  const commitAssemblyMapPartReverseComplement = useCallback(
    (part: BackbonePartHitPayload) => {
      const currentDesign = useDesignStore.getState().designs[designId];
      const region = currentDesign?.regions.find((candidate) => candidate.id === part.regionId);
      if (!region) return;
      const source = sourceSequences[region.sourceSequenceId];
      const applied = reverseComplementRegion(
        designId,
        region.id,
        !region.sourceSequence && source?.sequence ? { sourceSequence: source.sequence } : undefined
      );
      if (!applied) return;
      setAssemblyMapSelection({ kind: 'part', regionId: region.id });
      recordWebGLSelectionDebug('DesignTab.partReverseComplementCommit', {
        regionId: region.id,
      });
    },
    [designId, reverseComplementRegion, sourceSequences]
  );

  const handleAssemblyMapKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (assemblyMapSelection?.kind !== 'junction') return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setAssemblyMapSelection(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const currentDesign = useDesignStore.getState().designs[designId];
      if (!currentDesign) return;
      const currentSequence =
        selectAssemblyBoundaryMap(currentDesign).get(assemblyMapSelection.junctionIndex)?.spacer
          ?.sequence ?? '';
      const caretOffset = Math.min(assemblyMapSelection.caretOffset, currentSequence.length);

      const isIupacBase =
        event.key.length === 1 && IUPAC_EXPANSION[event.key.toUpperCase()] !== undefined;
      if (event.key !== 'Backspace' && !isIupacBase) return;

      const removesBase = event.key === 'Backspace' && caretOffset > 0;
      const nextSequence =
        event.key === 'Backspace'
          ? removesBase
            ? `${currentSequence.slice(0, caretOffset - 1)}${currentSequence.slice(caretOffset)}`
            : currentSequence
          : `${currentSequence.slice(0, caretOffset)}${event.key}${currentSequence.slice(caretOffset)}`;
      const nextCaretOffset =
        event.key === 'Backspace'
          ? Math.max(0, caretOffset - (removesBase ? 1 : 0))
          : caretOffset + 1;

      event.preventDefault();
      event.stopPropagation();
      if (nextSequence === currentSequence) return;
      const applied = setJunctionSpacer(designId, assemblyMapSelection.junctionIndex, nextSequence);
      if (applied) {
        setAssemblyMapSelection({ ...assemblyMapSelection, caretOffset: nextCaretOffset });
      }
    },
    [assemblyMapSelection, designId, setJunctionSpacer]
  );

  const previewAssemblyMapPrimerPbsLength = useCallback(
    (
      mapPrimer: AssemblyMapPrimerRange,
      requestedLength: number
    ): AssemblyMapPrimerPreview | null => {
      const currentDesign = useDesignStore.getState().designs[designId];
      if (!currentDesign) return null;
      const projection = projectAssemblyMapPrimerPbsEdit(
        currentDesign,
        mapPrimer,
        requestedLength,
        annotatedSequence?.length ?? 0
      );
      return projection?.primer ?? null;
    },
    [annotatedSequence?.length, designId]
  );

  const commitAssemblyMapPrimerPbsLength = useCallback(
    (mapPrimer: AssemblyMapPrimerRange, requestedLength: number): AssemblyMapPrimerRange | null => {
      const currentDesign = useDesignStore.getState().designs[designId];
      if (!currentDesign) return null;
      const projection = projectAssemblyMapPrimerPbsEdit(
        currentDesign,
        mapPrimer,
        requestedLength,
        annotatedSequence?.length ?? 0
      );
      if (!projection) return null;
      recordWebGLSelectionDebug('DesignTab.primerPbsCommandResult', {
        primerId: mapPrimer.id,
        length: projection.requestedLength,
        status: projection.status,
      });
      if (projection.status === 'applied') {
        const committed = commitWorkbenchDesign(
          designId,
          projection.nextDesign,
          currentDesign.version
        );
        recordWebGLSelectionDebug('DesignTab.primerPbsCommit', {
          primerId: mapPrimer.id,
          committed,
          previousVersion: currentDesign.version,
          nextVersion: projection.nextDesign.version,
        });
        if (!committed) return null;
      }
      return projection.primer;
    },
    [annotatedSequence?.length, commitWorkbenchDesign, designId]
  );

  const commitAssemblyMapCrossoverBoundary = useCallback<WebglMapCrossoverBoundaryCommit>(
    (mapRange, side, deltaBp) => {
      const currentDesign = useDesignStore.getState().designs[designId];
      if (!currentDesign || deltaBp === 0 || currentDesign.regions.length < 2) return mapRange;
      const selectedIndex = currentDesign.regions.findIndex(
        (candidate) => candidate.id === mapRange.regionId
      );
      if (selectedIndex < 0) return mapRange;
      const lastIndex = currentDesign.regions.length - 1;
      if (
        (side === 'upstream' && selectedIndex === 0) ||
        (side === 'downstream' && selectedIndex === lastIndex)
      ) {
        return mapRange;
      }
      const leftIndex = side === 'upstream' ? selectedIndex - 1 : selectedIndex;
      const rightIndex = leftIndex + 1;
      const leftRegion = currentDesign.regions[leftIndex];
      const rightRegion = currentDesign.regions[rightIndex];
      if (
        !leftRegion ||
        !rightRegion ||
        isRestrictionDigestRegion(leftRegion) ||
        isRestrictionDigestRegion(rightRegion)
      ) {
        return mapRange;
      }

      const sourceRegistry = new SourceContextRegistry(useSequenceStore.getState().sequences);
      const sourceWindows = sourceRegistry.resolveWindows(
        createJunctionSourceWindowRequests(currentDesign)
      );
      const sourceContext = createAssemblyWorkbenchSourceContext(sourceWindows);
      const viewState = createAssemblyWorkbenchViewState(currentDesign);
      const editableFields = createAssemblyWorkbenchSession(currentDesign, viewState, {
        sourceContext,
      }).editableFields;
      const leftField = editableFields.find(
        (field) =>
          field.kind === 'sourceContributionBoundary' &&
          field.target.regionId === leftRegion.id &&
          field.target.side === 'downstream'
      );
      const rightField = editableFields.find(
        (field) =>
          field.kind === 'sourceContributionBoundary' &&
          field.target.regionId === rightRegion.id &&
          field.target.side === 'upstream'
      );
      if (!leftField?.range || leftField.disabled || !rightField?.range || rightField.disabled) {
        return mapRange;
      }

      const minimumDelta = Math.max(
        leftField.range.min - leftRegion.sourceEnd,
        rightField.range.min - rightRegion.sourceStart
      );
      const maximumDelta = Math.min(
        leftField.range.max - leftRegion.sourceEnd,
        rightField.range.max - rightRegion.sourceStart
      );
      const currentSequence = getComposedSequence(
        getEffectiveDesignRegions(currentDesign),
        currentDesign.spacers
      );
      const requestedDelta = Math.max(minimumDelta, Math.min(maximumDelta, deltaBp));
      if (requestedDelta === 0) return mapRange;

      const attemptDelta = (candidateDelta: number) => {
        const leftResult = applyAssemblyWorkbenchCommand({
          design: currentDesign,
          viewState,
          sourceContext,
          command: {
            type: 'setSourceContributionBoundary',
            regionId: leftRegion.id,
            side: 'downstream',
            sourcePosition: leftRegion.sourceEnd + candidateDelta,
            expectedDesignVersion: currentDesign.version,
          },
        });
        if (leftResult.status !== 'applied') return null;
        const rightResult = applyAssemblyWorkbenchCommand({
          design: leftResult.nextDesign,
          viewState: leftResult.nextViewState,
          sourceContext,
          command: {
            type: 'setSourceContributionBoundary',
            regionId: rightRegion.id,
            side: 'upstream',
            sourcePosition: rightRegion.sourceStart + candidateDelta,
            expectedDesignVersion: leftResult.nextDesign.version,
          },
        });
        if (rightResult.status !== 'applied') return null;
        const candidateSequence = getComposedSequence(
          getEffectiveDesignRegions(rightResult.nextDesign),
          rightResult.nextDesign.spacers
        );
        if (candidateSequence !== currentSequence) return null;
        return { candidateDelta, leftResult, rightResult };
      };

      let acceptedAttempt: Exclude<ReturnType<typeof attemptDelta>, null> | null = null;
      const direction = Math.sign(requestedDelta);
      for (
        let magnitude = Math.abs(requestedDelta);
        magnitude > 0 && !acceptedAttempt;
        magnitude -= 1
      ) {
        acceptedAttempt = attemptDelta(direction * magnitude);
      }
      if (!acceptedAttempt) {
        recordWebGLSelectionDebug('DesignTab.crossoverInvariantRejected', {
          selectedRegionId: mapRange.regionId,
          side,
          deltaBp,
          requestedDelta,
          currentLength: currentSequence.length,
        });
        return mapRange;
      }
      recordWebGLSelectionDebug('DesignTab.crossoverCommandResult', {
        selectedRegionId: mapRange.regionId,
        leftRegionId: leftRegion.id,
        rightRegionId: rightRegion.id,
        side,
        deltaBp,
        requestedDelta,
        appliedDelta: acceptedAttempt.candidateDelta,
        leftStatus: acceptedAttempt.leftResult.status,
        rightStatus: acceptedAttempt.rightResult.status,
      });

      const committed = commitWorkbenchDesign(
        designId,
        acceptedAttempt.rightResult.nextDesign,
        currentDesign.version
      );
      if (!committed) return null;
      return (
        assemblyMapPartRangeForRegion(acceptedAttempt.rightResult.nextDesign, mapRange.regionId) ??
        mapRange
      );
    },
    [commitWorkbenchDesign, designId]
  );

  const handleGGLabelClick = useCallback(
    (_junctionIndex: number) => {
      setAssemblyDrawerOpen(true);
    },
    [setAssemblyDrawerOpen]
  );

  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  if (!design) {
    return (
      <div className="h-full flex items-center justify-center text-fg-muted">Design not found</div>
    );
  }

  const wrapMocloWorkspace = (mapContent: ReactNode): ReactNode =>
    isMocloMapSchemaStripEnabled() && mocloWorkspaceModel ? (
      <MocloAssemblyWorkspace
        model={mocloWorkspaceModel}
        selectedRegionId={
          assemblyMapSelection?.kind === 'part' ? assemblyMapSelection.regionId : null
        }
        onSelectRegion={(regionId) => setAssemblyMapSelection({ kind: 'part', regionId })}
        onChangeSchema={changeMocloSchema}
        onReplacePart={replaceMocloPart}
        workspaceRoot={owningWorkspaceRoot}
        mapContent={mapContent}
      />
    ) : (
      mapContent
    );

  const hasPartBreakdown = design.regions.length > 0;
  const platformCommandLabel = isApplePlatform() ? 'Command' : 'Ctrl';
  const copyShortcutLabel = `${platformCommandLabel}+C`;
  const pasteShortcutLabel = `${platformCommandLabel}+V`;

  if (!annotatedSequence || !parsedPlasmid) {
    return (
      <div
        className="h-full flex flex-col ring-2 ring-inset ring-blue-400 dark:ring-blue-500"
        {...saveCommandScope}
      >
        {}
        <div
          className={`flex items-center justify-between border-b border-border bg-bg px-3 py-1 ${DOCUMENT_TAB_UNDERBAR_MIN_CLASS}`}
        >
          <div className="flex min-w-0 items-center gap-2">
            {isEditingName ? (
              <input
                ref={nameInputRef}
                type="text"
                value={editingNameValue}
                onChange={(e) => setEditingNameValue(e.target.value)}
                onBlur={() => void handleNameSave()}
                onKeyDown={handleNameKeyDown}
                data-testid="design-name-input"
                className="min-w-[120px] rounded border border-accent bg-bg-base px-2 py-0.5 text-sm font-medium outline-none"
                autoFocus
              />
            ) : (
              <div className="group flex min-w-0 items-center gap-1">
                <span
                  className="cursor-pointer text-sm font-medium transition-colors hover:text-accent"
                  onDoubleClick={handleNameEditStart}
                  title="Double-click to rename"
                >
                  {design.name}
                </span>
                <button
                  type="button"
                  data-testid="design-rename-button"
                  aria-label="Rename assembly design"
                  onClick={handleNameEditStart}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle wp-interactive "
                  title="Rename assembly design"
                >
                  <EditIcon size={12} />
                </button>
              </div>
            )}
            <span className="text-xs text-fg-muted">Assembly design</span>
            <DesignSaveStatus designId={designId} />
          </div>
          <DesignEyebrowActions
            isAssemblyDrawerOpen={isAssemblyDrawerOpen}
            toggleAssemblyDrawer={toggleAssemblyDrawer}
            onExitToSequence={exitToSequence}
          />
        </div>
        {}
        {wrapMocloWorkspace(
          <div className="flex min-h-0 flex-1">
            <div className="flex flex-1 items-center justify-center">
              <div className="max-w-md p-8 text-center">
                <h2 className="mb-2 text-lg font-semibold">
                  {hasPartBreakdown ? 'No sequence yet' : 'Empty Design'}
                </h2>
                <p className="mb-4 text-fg-muted">
                  {lastCopied
                    ? `Ready to paste ${lastCopied.sourceName} (${lastCopied.sequence.length.toLocaleString()} bp).`
                    : hasPartBreakdown
                      ? 'Paste a sequence into the empty parts in the assembly panel, or add more parts to build your design.'
                      : 'Copy a region from a sequence tab and paste it here to start building your design.'}
                </p>
                <p className="text-sm text-fg-muted">
                  <kbd className="rounded bg-bg-muted px-2 py-1">{copyShortcutLabel}</kbd> in
                  sequence tab
                  {' → '}
                  <kbd className="rounded bg-bg-muted px-2 py-1">{pasteShortcutLabel}</kbd> here
                </p>
              </div>
            </div>
            {isAssemblyDrawerOpen && (
              <DesignDrawer
                designId={designId}
                projectRoot={owningWorkspaceRoot}
                width={assemblyDrawerWidth}
                onWidthChange={setAssemblyDrawerWidth}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  const drawerSlot = isAssemblyDrawerOpen ? (
    <DesignDrawer
      designId={designId}
      projectRoot={owningWorkspaceRoot}
      width={assemblyDrawerWidth}
      onWidthChange={setAssemblyDrawerWidth}
    />
  ) : undefined;

  const workspaceViewer = (
    <WorkspaceViewer
      entityId={designId}
      sequence={annotatedSequence}
      plasmid={parsedPlasmid}
      circular={design.topology === 'circular'}
      onCopy={handleAssemblyMapCopy}
      surface="assembly"
      backboneSegments={backboneSegments}
      junctionIndicators={junctionIndicators}
      onPaste={handleContextMenuPaste}
      pasteTargetLabel={mapPasteTarget}
      mapPasteHint={
        mapPasteTarget
          ? `Right-click to paste ${mapPasteTarget} at this position`
          : 'Right-click to paste sequence at this position'
      }
      onCursorChange={handleCursorChange}
      onMapPositionClick={handleAssemblyMapPositionClick}
      mapEditCursorPosition={assemblyMapEditCursorPosition}
      mapEditCursorBlinking={assemblyMapEditCursorPosition !== undefined}
      onMapPrimerPbsLengthPreview={previewAssemblyMapPrimerPbsLength}
      onMapPrimerPbsLengthCommit={commitAssemblyMapPrimerPbsLength}
      onMapKeyDown={handleAssemblyMapKeyDown}
      onMapCursorNavigate={handleAssemblyMapCursorNavigate}
      mapCrossoverEditRange={mapCrossoverEditRange}
      onMapCrossoverBoundaryCommit={commitAssemblyMapCrossoverBoundary}
      mapSelectedPartRegionId={
        assemblyMapSelection?.kind === 'part' ? assemblyMapSelection.regionId : null
      }
      onMapPartSelect={handleAssemblyMapPartSelect}
      onMapPartReorderPreview={
        ASSEMBLY_MAP_PART_REORDER_ENABLED ? previewAssemblyMapPartReorder : undefined
      }
      onMapPartReorderCommit={
        ASSEMBLY_MAP_PART_REORDER_ENABLED ? commitAssemblyMapPartReorder : undefined
      }
      onMapPartReverseComplement={commitAssemblyMapPartReverseComplement}
      primers={sequenceViewerPrimers}
      scrollToPosition={design.scrollToPosition}
      onScrollComplete={() => clearScrollPosition(designId)}
      highlightRange={design.highlightRange}
      onHighlightComplete={() => clearHighlightRange(designId)}
      onGGLabelClick={handleGGLabelClick}
      internalCutSiteMarkers={internalCutSiteOverlay}
      drawerSlot={drawerSlot}
    />
  );

  return (
    <div
      className="h-full flex flex-col ring-2 ring-inset ring-blue-400 dark:ring-blue-500"
      {...saveCommandScope}
    >
      {}
      <div
        className={`flex items-center justify-between px-3 py-1 border-b border-border bg-bg whitespace-nowrap overflow-x-auto ${DOCUMENT_TAB_UNDERBAR_MIN_CLASS}`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
          {}
          {isEditingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={editingNameValue}
              onChange={(e) => setEditingNameValue(e.target.value)}
              onBlur={() => void handleNameSave()}
              onKeyDown={handleNameKeyDown}
              data-testid="design-name-input"
              className="text-sm font-medium px-2 py-0.5 bg-bg-base border border-accent rounded outline-none min-w-[120px]"
              autoFocus
            />
          ) : (
            <div className="group flex min-w-0 items-center gap-1">
              <span
                className="text-sm font-medium cursor-pointer hover:text-accent transition-colors truncate max-w-[200px]"
                onDoubleClick={handleNameEditStart}
                title="Double-click to rename"
              >
                {design.name}
              </span>
              <button
                type="button"
                data-testid="design-rename-button"
                aria-label="Rename assembly design"
                onClick={handleNameEditStart}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle wp-interactive "
                title="Rename assembly design"
              >
                <EditIcon size={12} />
              </button>
            </div>
          )}

          <span className="flex-shrink-0 text-xs text-fg-muted">Assembly design</span>
          <DesignSaveStatus designId={designId} />
        </div>
        <DesignEyebrowActions
          isAssemblyDrawerOpen={isAssemblyDrawerOpen}
          toggleAssemblyDrawer={toggleAssemblyDrawer}
          onExitToSequence={exitToSequence}
        />
      </div>

      {}
      <div className="flex-1 min-h-0 relative">{wrapMocloWorkspace(workspaceViewer)}</div>
    </div>
  );
}

function projectAssemblyMapPrimerPbsEdit(
  design: SequenceDesign,
  mapPrimer: AssemblyMapPrimerRange,
  requestedLength: number,
  mapLength: number
): AssemblyMapPrimerPbsProjection | null {
  const currentPair = design.designPrimers.find(
    (pair) => pair.forward.id === mapPrimer.id || pair.reverse.id === mapPrimer.id
  );
  if (!currentPair) return null;
  const currentPrimer =
    currentPair.forward.id === mapPrimer.id ? currentPair.forward : currentPair.reverse;
  const currentMapPrimer: AssemblyMapPrimerPreview = {
    ...mapPrimer,
    bases: currentPrimer.sequence,
    tm: currentPrimer.tm ?? 0,
    gc: calculateGcContent(currentPrimer.pbs.sequence),
  };

  const viewState = createAssemblyWorkbenchViewState(design);
  const editableField = createAssemblyWorkbenchSession(design, viewState).editableFields.find(
    (field) =>
      field.kind === 'primerPbs' &&
      field.target.fragmentIndex === currentPrimer.fragmentIndex &&
      field.target.direction === currentPrimer.direction
  );
  if (!editableField?.range || editableField.disabled) {
    return {
      status: 'noop',
      nextDesign: design,
      primer: currentMapPrimer,
      requestedLength: currentPrimer.pbs.sequence.length,
    };
  }

  const length = Math.max(
    editableField.range.min,
    Math.min(editableField.range.max, Math.round(requestedLength))
  );
  const result = applyAssemblyWorkbenchCommand({
    design,
    viewState,
    command: {
      type: 'setPrimerPbsLength',
      primerId: editableField.target.primerId,
      length,
      expectedDesignVersion: design.version,
    },
  });
  const projectedPair = result.nextDesign.designPrimers.find(
    (pair) => pair.fragmentIndex === currentPrimer.fragmentIndex
  );
  const projectedPrimer =
    currentPrimer.direction === 'forward' ? projectedPair?.forward : projectedPair?.reverse;
  if (!projectedPrimer) return null;
  const projectedBoundary = projectWebglPrimerPbsBoundary({
    primer: mapPrimer,
    nextPbsLength: projectedPrimer.pbs.sequence.length,
    genomeLength: mapLength,
    circular: design.topology === 'circular',
  });
  if (projectedBoundary === null) return null;

  return {
    status: result.status,
    nextDesign: result.nextDesign,
    primer: {
      ...mapPrimer,
      start: projectedPrimer.direction === 'reverse' ? projectedBoundary : mapPrimer.start,
      end: projectedPrimer.direction === 'forward' ? projectedBoundary : mapPrimer.end,
      bases: projectedPrimer.sequence,
      tm: projectedPrimer.tm ?? 0,
      gc: calculateGcContent(projectedPrimer.pbs.sequence),
    },
    requestedLength: length,
  };
}

function assemblyMapPartRangeForRegion(
  design: SequenceDesign,
  regionId: string
): { regionId: string; start: number; end: number } | null {
  return assemblyMapPartRanges(design).find((range) => range.regionId === regionId) ?? null;
}

function assemblyMapPartRanges(
  design: SequenceDesign
): Array<{ regionId: string; start: number; end: number }> {
  const displayRegions = getEffectiveDesignRegions(design);
  const boundaries = selectAssemblyBoundaryMap(design);
  const ranges: Array<{ regionId: string; start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < displayRegions.length; index += 1) {
    const region = displayRegions[index];
    const end = start + region.sequence.length;
    ranges.push({ regionId: region.id, start, end });
    start = end + (boundaries.get(index)?.spacer?.sequence.length ?? 0);
  }
  return ranges;
}

function projectAssemblyMapPartReorder(
  design: SequenceDesign,
  regionId: string,
  targetBp: number
): {
  sourceIndex: number;
  insertionSlot: number;
  orderedRegionIds: string[];
  preview: BackbonePartReorderPreview;
} | null {
  const currentRanges = assemblyMapPartRanges(design);
  const sourceIndex = design.regions.findIndex((region) => region.id === regionId);
  const insertionSlot = resolveAssemblyMapInsertionSlot(currentRanges, targetBp);
  if (sourceIndex < 0 || insertionSlot === null) return null;

  const currentRegionIds = design.regions.map((region) => region.id);
  const orderedRegionIds = reorderByInsertionSlot(currentRegionIds, sourceIndex, insertionSlot);
  if (orderedRegionIds.every((candidate, index) => candidate === currentRegionIds[index])) {
    return null;
  }

  const regionById = new Map(design.regions.map((region) => [region.id, region]));
  const reorderedRegions = orderedRegionIds.flatMap((candidate) => {
    const region = regionById.get(candidate);
    return region ? [region] : [];
  });
  if (reorderedRegions.length !== design.regions.length) return null;
  if (!isGoldenGateFixedRegionOrderCompatible(design, reorderedRegions)) return null;
  const move = detectSingleRegionMove(currentRegionIds, orderedRegionIds);
  const projectedDesign: SequenceDesign = {
    ...design,
    regions: reorderedRegions,
    spacers: adjustSpacersForReorder(design.spacers, reorderedRegions, move, design.topology),
  };

  return {
    sourceIndex,
    insertionSlot,
    orderedRegionIds,
    preview: {
      ranges: assemblyMapPartRanges(projectedDesign).map((range) => ({
        regionId: range.regionId,
        rangeStart: range.start,
        rangeEnd: range.end,
      })),
    },
  };
}

function assemblyMapEditableCrossoverSides(
  design: SequenceDesign,
  selectedIndex: number,
  editableFields: ReturnType<typeof createAssemblyWorkbenchSession>['editableFields']
): Array<'upstream' | 'downstream'> {
  const pairIsEditable = (leftIndex: number): boolean => {
    const leftRegion = design.regions[leftIndex];
    const rightRegion = design.regions[leftIndex + 1];
    if (
      !leftRegion ||
      !rightRegion ||
      isRestrictionDigestRegion(leftRegion) ||
      isRestrictionDigestRegion(rightRegion)
    ) {
      return false;
    }
    const leftField = editableFields.find(
      (field) =>
        field.kind === 'sourceContributionBoundary' &&
        field.target.regionId === leftRegion.id &&
        field.target.side === 'downstream'
    );
    const rightField = editableFields.find(
      (field) =>
        field.kind === 'sourceContributionBoundary' &&
        field.target.regionId === rightRegion.id &&
        field.target.side === 'upstream'
    );
    return Boolean(
      leftField?.range && !leftField.disabled && rightField?.range && !rightField.disabled
    );
  };

  const editableSides: Array<'upstream' | 'downstream'> = [];
  if (selectedIndex > 0 && pairIsEditable(selectedIndex - 1)) editableSides.push('upstream');
  if (selectedIndex < design.regions.length - 1 && pairIsEditable(selectedIndex)) {
    editableSides.push('downstream');
  }
  return editableSides;
}

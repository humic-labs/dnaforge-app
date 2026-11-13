'use client';

import { rememberViewerOverview } from '../molstar/viewerSelection';

import { useEffect, useRef, useCallback, useMemo } from 'react';
import type {
  ResidueLocation,
  ResidueInteractionState,
  HighlightGroup,
  ChainSelection,
} from '../types';
import { AGENT_HIGHLIGHT_GROUP_ID_PREFIX, HIGHLIGHT_COLORS } from '../types';
import { parseEffectiveChainId } from '../utils/molstarChainUtils';
import { nativeStructureSources } from '../utils/structureIds';
import { resolveHighlightGroupColor } from '../utils/highlightUtils';

import { Script } from 'molstar/lib/mol-script/script';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { StructureSelection } from 'molstar/lib/mol-model/structure';
import { Loci } from 'molstar/lib/mol-model/loci';
import { setSubtreeVisibility } from 'molstar/lib/mol-plugin/behavior/static/state';
import type { MolstarPlugin } from '../molstar/cache';
import { onStructureSceneReplaced } from '../molstar/sceneReplacement';

const WATER_RESIDUES = ['HOH', 'WAT', 'H2O', 'DOD', 'D2O'];
const SELECTION_SIDE_CHAIN_COMPONENT_LABEL = 'Active Selection Side Chains';
const SELECTION_SIDE_CHAIN_COMPONENT_ID = 'waypoint-active-selection-side-chains';
const SELECTION_SIDE_CHAIN_REPRESENTATION_TAG = 'waypoint.structure3d.selection-side-chains.detail';
const SAVED_SELECTION_COMPONENT_LABEL_PREFIX = 'Saved Selection:';
const SAVED_SELECTION_COMPONENT_ID_PREFIX = 'waypoint-saved-selection';
const SAVED_SELECTION_REPRESENTATION_TAG = 'waypoint.structure3d.saved-selection';
let selectionSideChainComponentSerial = 0;
let savedSelectionComponentSerial = 0;

interface SelectionSideChainOverlayState {
  selectionKey: string;
  componentRef: string;
  hidden: boolean;
}

const selectionSideChainOverlayByPlugin = new WeakMap<object, SelectionSideChainOverlayState>();
const selectionSideChainRequestGenerationByPlugin = new WeakMap<object, number>();

const IDENTITY_OPERATOR = '1_555';
const IDENTITY_ASSEMBLY_OPERATOR = 'ASM_1';

function nextSelectionSideChainComponentId(): string {
  selectionSideChainComponentSerial += 1;
  return `${SELECTION_SIDE_CHAIN_COMPONENT_ID}-${selectionSideChainComponentSerial}`;
}

function nextSavedSelectionComponentId(): string {
  savedSelectionComponentSerial += 1;
  return `${SAVED_SELECTION_COMPONENT_ID_PREFIX}-${savedSelectionComponentSerial}`;
}

function usesNativeSelectionChannel(group: HighlightGroup): boolean {
  return group.renderMode === 'selection' || group.id.startsWith(AGENT_HIGHLIGHT_GROUP_ID_PREFIX);
}

function isSameResidueLocation(
  a: ResidueLocation | null | undefined,
  b: ResidueLocation | null | undefined
): boolean {
  if (!a || !b) return a === b;
  return (
    a.chain === b.chain &&
    a.position === b.position &&
    a.compId === b.compId &&
    a.baseChain === b.baseChain &&
    a.labelAsymId === b.labelAsymId &&
    a.authAsymId === b.authAsymId &&
    a.entityId === b.entityId &&
    a.labelSeqId === b.labelSeqId &&
    a.operator === b.operator &&
    a.structureRef === b.structureRef &&
    a.instanceId === b.instanceId
  );
}

function recordHoverHighlightDiagnostic(
  residue: ResidueLocation | null,
  startedAt: number,
  endedAt: number
) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_STRUCTURE_HOVER_HIGHLIGHT__?: {
      last: {
        residue: ResidueLocation | null;
        startedAt: number;
        endedAt: number;
        durationMs: number;
      };
      events: Array<{
        residue: ResidueLocation | null;
        startedAt: number;
        endedAt: number;
        durationMs: number;
      }>;
    };
  };
  const event = {
    residue,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
  };
  const current = testWindow.__WAYPOINT_STRUCTURE_HOVER_HIGHLIGHT__;
  const events = [...(current?.events ?? []), event].slice(-50);
  testWindow.__WAYPOINT_STRUCTURE_HOVER_HIGHLIGHT__ = {
    last: event,
    events,
  };
}

function recordSelectionHighlightDiagnostic(
  selectedResidues: ReadonlyArray<ResidueLocation>,
  savedGroupCount: number,
  applied: { saved: boolean; selected: boolean },
  readback: {
    elementCount: number | null;
    statsLabel: string | null;
    hasInteractiveSelection: boolean | null;
  },
  startedAt: number,
  endedAt: number
) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__?: {
      last: {
        selectedResidues: ReadonlyArray<ResidueLocation>;
        selectedCount: number;
        savedGroupCount: number;
        applied: { saved: boolean; selected: boolean };
        readback: {
          elementCount: number | null;
          statsLabel: string | null;
          hasInteractiveSelection: boolean | null;
        };
        startedAt: number;
        endedAt: number;
        durationMs: number;
      };
      events: Array<{
        selectedResidues: ReadonlyArray<ResidueLocation>;
        selectedCount: number;
        savedGroupCount: number;
        applied: { saved: boolean; selected: boolean };
        readback: {
          elementCount: number | null;
          statsLabel: string | null;
          hasInteractiveSelection: boolean | null;
        };
        startedAt: number;
        endedAt: number;
        durationMs: number;
      }>;
    };
  };
  const event = {
    selectedResidues,
    selectedCount: selectedResidues.length,
    savedGroupCount,
    applied,
    readback,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
  };
  const current = testWindow.__WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__;
  const events = [...(current?.events ?? []), event].slice(-50);
  testWindow.__WAYPOINT_STRUCTURE_SELECTION_HIGHLIGHT__ = {
    last: event,
    events,
  };
}

function isIdentityOperator(operator: string | undefined): boolean {
  return operator === IDENTITY_OPERATOR || operator === IDENTITY_ASSEMBLY_OPERATOR;
}

function buildChainRangesExpression(selection: ChainSelection) {
  const rangeExpressions = selection.ranges.map(([start, end]) => {
    if (start === end) {
      return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.auth_seq_id(), start]);
    } else {
      return MS.core.logic.and([
        MS.core.rel.gre([MS.struct.atomProperty.macromolecular.auth_seq_id(), start]),
        MS.core.rel.lte([MS.struct.atomProperty.macromolecular.auth_seq_id(), end]),
      ]);
    }
  });

  const positionTest =
    rangeExpressions.length === 1 ? rangeExpressions[0] : MS.core.logic.or(rangeExpressions);
  const residueTest = selection.compId
    ? MS.core.logic.and([
        positionTest,
        MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_comp_id(), selection.compId]),
      ])
    : positionTest;

  const chainTest = buildChainSelectionTest(selection);
  return MS.struct.generator.atomGroups({
    'chain-test': chainTest,
    'residue-test': residueTest,
  });
}

function buildChainSelectionTest(selection: ChainSelection) {
  const baseChain =
    selection.labelAsymId ||
    selection.baseChain ||
    parseEffectiveChainId(selection.chain).baseChain;

  if (selection.operator) {
    return MS.core.logic.and([
      MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]),
      MS.core.rel.eq([MS.struct.atomProperty.core.operatorName(), selection.operator]),
    ]);
  }
  if (selection.labelAsymId || selection.baseChain) {
    return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]);
  }
  if (selection.authAsymId) {
    return MS.core.rel.eq([
      MS.struct.atomProperty.macromolecular.auth_asym_id(),
      selection.authAsymId,
    ]);
  }
  return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]);
}

function buildHighlightGroupExpression(group: HighlightGroup) {
  const chainExpressions = group.selections.map((sel) => buildChainRangesExpression(sel));

  if (chainExpressions.length === 1) {
    return chainExpressions[0];
  }
  return MS.struct.combinator.merge(chainExpressions);
}

function buildChainTest(r: ResidueLocation) {
  const baseChain = r.labelAsymId || r.baseChain || parseEffectiveChainId(r.chain).baseChain;
  if (r.instanceId) {
    return MS.core.logic.and([
      MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]),
      MS.core.rel.eq([MS.struct.atomProperty.core.instanceId(), r.instanceId]),
    ]);
  }

  if (r.operator && !isIdentityOperator(r.operator)) {
    return MS.core.logic.and([
      MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]),
      MS.core.rel.eq([MS.struct.atomProperty.core.operatorName(), r.operator]),
    ]);
  }

  if (r.operator && isIdentityOperator(r.operator)) {
    return MS.core.logic.and([
      MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]),
      MS.core.rel.eq([MS.struct.atomProperty.core.operatorName(), r.operator]),
    ]);
  }

  if (r.labelAsymId || r.baseChain) {
    return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]);
  }
  if (r.authAsymId) {
    return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.auth_asym_id(), r.authAsymId]);
  }

  return MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_asym_id(), baseChain]);
}

function buildResiduePositionTest(r: ResidueLocation) {
  const authSeqTest = MS.core.rel.eq([
    MS.struct.atomProperty.macromolecular.auth_seq_id(),
    r.position,
  ]);
  if (r.labelSeqId === undefined) return authSeqTest;
  return MS.core.logic.and([
    authSeqTest,
    MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_seq_id(), r.labelSeqId]),
  ]);
}

function buildResidueExpression(residues: ResidueLocation[]) {
  if (residues.length === 0) return null;

  const expressions = [];

  for (const r of residues) {
    const chainTest = buildChainTest(r);

    if (r.compId) {
      const expr = MS.struct.generator.atomGroups({
        'chain-test': chainTest,
        'residue-test': MS.core.logic.and([
          buildResiduePositionTest(r),
          MS.core.rel.eq([MS.struct.atomProperty.macromolecular.label_comp_id(), r.compId]),
        ]),
      });
      expressions.push(expr);
    } else {
      const expr = MS.struct.generator.atomGroups({
        'chain-test': chainTest,
        'residue-test': MS.core.logic.and([
          buildResiduePositionTest(r),
          MS.core.logic.not([
            MS.core.set.has([
              MS.set(...WATER_RESIDUES),
              MS.struct.atomProperty.macromolecular.label_comp_id(),
            ]),
          ]),
        ]),
      });
      expressions.push(expr);
    }
  }

  if (expressions.length === 1) {
    return expressions[0];
  }
  return MS.struct.combinator.merge(expressions);
}

export const getResiduesLoci = (
  plugin: MolstarPlugin | null,
  residues: ResidueLocation[]
): Loci[] => residueLociBySource(plugin, residues, true);

export function residueLociBySource(
  plugin: MolstarPlugin | null,
  residues: ResidueLocation[],
  includeUnscopedSources = false
): Loci[] {
  if (!plugin || !residues.length) return [];
  return nativeStructureSources(plugin).flatMap((source) => {
    const scoped = residues.filter((residue) =>
      residue.structureRef
        ? residue.structureRef === source.structureRef
        : includeUnscopedSources || source.isPrimarySource !== false
    );
    const expression = buildResidueExpression(scoped);
    if (!expression) return [];
    try {
      const selection = Script.getStructureSelection(expression, source.structure);
      const loci = StructureSelection.toLociWithSourceUnits(selection);
      return Loci.isEmpty(loci) ? [] : [loci];
    } catch (error) {
      console.warn('[useResidueHighlight] Failed to build source-qualified loci:', error);
      return [];
    }
  });
}

export function useResidueHighlight(
  plugin: MolstarPlugin | null,
  interactionState: ResidueInteractionState | undefined,
  enabled: boolean = true,
  highlightGroups?: HighlightGroup[]
) {
  const lastHoveredRef = useRef<ResidueLocation | null>(null);
  const lastSelectedRef = useRef<ResidueLocation[]>([]);
  const lastHighlightGroupsRef = useRef<string>('');
  const lastPluginRef = useRef<unknown>(null);
  const scheduledHoverRef = useRef<{
    frame: number | null;
    pending: ResidueLocation | null;
  }>({ frame: null, pending: null });

  const applyHoverHighlight = useCallback(
    (residue: ResidueLocation | null) => {
      const lociHighlights = plugin?.managers?.interactivity?.lociHighlights;
      if (!lociHighlights) return;
      const startedAt = performance.now();

      try {
        lociHighlights.clearHighlights();

        if (residue) {
          for (const loci of residueLociBySource(plugin, [residue])) {
            lociHighlights.highlight({ loci }, false);
          }
        }
      } catch (e) {
      } finally {
        recordHoverHighlightDiagnostic(residue, startedAt, performance.now());
      }
    },
    [plugin]
  );

  const cancelScheduledHoverHighlight = useCallback(() => {
    const scheduled = scheduledHoverRef.current;
    if (scheduled.frame !== null) {
      window.cancelAnimationFrame(scheduled.frame);
      scheduled.frame = null;
    }
  }, []);

  const scheduleHoverHighlight = useCallback(
    (residue: ResidueLocation | null) => {
      const scheduled = scheduledHoverRef.current;
      scheduled.pending = residue;
      if (scheduled.frame !== null) {
        return;
      }
      scheduled.frame = window.requestAnimationFrame(() => {
        scheduled.frame = null;
        applyHoverHighlight(scheduled.pending);
      });
    },
    [applyHoverHighlight]
  );

  const getAgentHighlightLoci = useCallback(
    (groups: HighlightGroup[]): Loci | null => {
      if (!plugin?.managers?.structure?.hierarchy || groups.length === 0) return null;
      try {
        const structures = plugin.managers.structure.hierarchy.current.structures;
        const structureData = structures?.[0]?.cell?.obj?.data;
        if (!structureData) return null;
        const expressions = groups.map((group) => buildHighlightGroupExpression(group));
        const expression =
          expressions.length === 1 ? expressions[0] : MS.struct.combinator.merge(expressions);
        const selection = Script.getStructureSelection(expression, structureData);
        return StructureSelection.toLociWithSourceUnits(selection);
      } catch (error) {
        console.warn('[useResidueHighlight] Failed to resolve agent highlight loci:', error);
        return null;
      }
    },
    [plugin]
  );

  const applyHighlightGroups = useCallback(
    (
      agentGroups: HighlightGroup[],
      currentSelection: ResidueLocation[],
      visibleGroupCount: number
    ) => {
      const lociSelects = plugin?.managers?.interactivity?.lociSelects;
      if (!lociSelects) return;
      const startedAt = performance.now();
      const applied = { saved: false, selected: false };
      let selectionLoci: Loci[] = [];

      try {
        lociSelects.deselectAll();

        const agentLoci = getAgentHighlightLoci(agentGroups);

        if (agentLoci && !Loci.isEmpty(agentLoci)) {
          lociSelects.select({ loci: agentLoci });
          applied.saved = true;
        }

        selectionLoci = residueLociBySource(plugin, currentSelection);
        for (const loci of selectionLoci) {
          lociSelects.select({ loci });
          applied.selected = true;
        }
      } catch (e) {
        console.warn('[useResidueHighlight] Failed to apply highlights:', e);
      } finally {
        const selectionManager = plugin?.managers?.structure?.selection;
        const readback = {
          elementCount:
            typeof selectionManager?.elementCount === 'function'
              ? selectionManager.elementCount()
              : null,
          statsLabel: selectionManager?.stats?.label ?? null,
          hasInteractiveSelection:
            selectionLoci.length > 0 && typeof selectionManager?.has === 'function'
              ? selectionLoci.every((loci) => selectionManager.has(loci))
              : currentSelection.length === 0
                ? false
                : null,
        };
        recordSelectionHighlightDiagnostic(
          currentSelection,
          visibleGroupCount,
          applied,
          readback,
          startedAt,
          performance.now()
        );
      }
    },
    [plugin, getAgentHighlightLoci]
  );

  const { visibleGroups, savedVisibleGroups, agentVisibleGroups, groupsHash } = useMemo(() => {
    const visible = highlightGroups?.filter((g) => g.visible !== false) || [];
    const agent = visible.filter(usesNativeSelectionChannel);
    const saved = visible.filter((group) => !usesNativeSelectionChannel(group));
    const hash = visible
      .map(
        (g) =>
          `${g.id}:${g.renderMode ?? 'legacy-annotation'}:${resolveHighlightGroupColor(g)}:${JSON.stringify(g.selections)}`
      )
      .join('|');
    return {
      visibleGroups: visible,
      savedVisibleGroups: saved,
      agentVisibleGroups: agent,
      groupsHash: hash,
    };
  }, [highlightGroups]);

  useEffect(() => {
    if (!enabled || !plugin) return;
    return onStructureSceneReplaced(plugin, () => {
      cancelScheduledHoverHighlight();
      applyHighlightGroups(
        agentVisibleGroups,
        interactionState?.selected ?? [],
        visibleGroups.length
      );
      applyHoverHighlight(interactionState?.hovered ?? null);
    });
  }, [
    plugin,
    enabled,
    interactionState,
    agentVisibleGroups,
    visibleGroups.length,
    applyHighlightGroups,
    applyHoverHighlight,
    cancelScheduledHoverHighlight,
  ]);

  useEffect(() => {
    if (plugin === lastPluginRef.current) return;
    lastPluginRef.current = plugin;
    lastHoveredRef.current = null;
    lastSelectedRef.current = [];
    lastHighlightGroupsRef.current = '';
  }, [plugin]);

  useEffect(() => {
    if (!plugin) return;
    let cancelled = false;
    if (enabled) {
      void applySavedHighlightOverlays(plugin, savedVisibleGroups, () => cancelled);
    } else {
      void clearSavedHighlightOverlays(plugin);
    }
    return () => {
      cancelled = true;
    };
  }, [plugin, enabled, groupsHash, savedVisibleGroups]);

  useEffect(() => {
    if (!enabled || !plugin) return;

    if (groupsHash !== lastHighlightGroupsRef.current) {
      applyHighlightGroups(
        agentVisibleGroups,
        interactionState?.selected ?? [],
        visibleGroups.length
      );
      lastHighlightGroupsRef.current = groupsHash;
    }
  }, [
    enabled,
    plugin,
    groupsHash,
    visibleGroups,
    agentVisibleGroups,
    interactionState?.selected,
    applyHighlightGroups,
  ]);

  useEffect(() => {
    if (!enabled || !plugin) return;

    const hovered = interactionState?.hovered ?? null;
    const selected = interactionState?.selected ?? [];

    if (hovered !== lastHoveredRef.current) {
      const changed = !isSameResidueLocation(hovered, lastHoveredRef.current);

      if (changed) {
        scheduleHoverHighlight(hovered);
        lastHoveredRef.current = hovered;
      }
    }

    const selectedChanged =
      selected.length !== lastSelectedRef.current.length ||
      selected.some((r, i) => !isSameResidueLocation(r, lastSelectedRef.current[i]));

    if (selectedChanged) {
      applyHighlightGroups(agentVisibleGroups, selected, visibleGroups.length);
      lastSelectedRef.current = [...selected];
    }
  }, [
    enabled,
    plugin,
    interactionState,
    agentVisibleGroups,
    visibleGroups,
    scheduleHoverHighlight,
    applyHighlightGroups,
  ]);

  useEffect(() => {
    return () => {
      cancelScheduledHoverHighlight();
      void clearSavedHighlightOverlays(plugin);
    };
  }, [cancelScheduledHoverHighlight, plugin]);

  useEffect(() => {
    if (!enabled && plugin) {
      cancelScheduledHoverHighlight();
      plugin.managers?.interactivity?.lociHighlights?.clearHighlights();
      plugin.managers?.interactivity?.lociSelects?.deselectAll();
    }

    return () => {
      cancelScheduledHoverHighlight();
      if (plugin) {
        plugin.managers?.interactivity?.lociHighlights?.clearHighlights();
        plugin.managers?.interactivity?.lociSelects?.deselectAll();
      }
    };
  }, [enabled, plugin, cancelScheduledHoverHighlight]);
}

export async function applySavedHighlightOverlays(
  plugin: MolstarPlugin | null,
  groups: ReadonlyArray<HighlightGroup>,
  isCancelled: () => boolean = () => false
): Promise<void> {
  if (!plugin?.managers?.structure?.hierarchy) return;
  await clearSavedHighlightOverlays(plugin);
  if (isCancelled()) return;

  const visibleGroups = groups.filter(
    (group) => group.visible !== false && group.selections.length > 0
  );
  if (visibleGroups.length === 0) return;

  const structures = plugin.managers.structure.hierarchy.current.structures ?? [];
  const structureRef = structures[0]?.cell ?? structures[0];
  if (!structureRef || !plugin.builders?.structure?.tryCreateComponentFromExpression) return;
  if (!plugin.builders?.structure?.representation?.addRepresentation) return;

  for (const group of visibleGroups) {
    if (isCancelled()) return;
    const expression = buildHighlightGroupExpression(group);
    const component = await plugin.builders.structure.tryCreateComponentFromExpression(
      structureRef,
      expression,
      nextSavedSelectionComponentId(),
      { label: `${SAVED_SELECTION_COMPONENT_LABEL_PREFIX} ${group.id}` }
    );
    const componentRef = componentRepresentationRef(component);
    if (isCancelled()) {
      if (componentRef) await deleteMolstarStateRef(plugin, componentRef);
      return;
    }
    if (!componentRef) continue;

    await plugin.builders.structure.representation.addRepresentation(
      componentRef,
      {
        type: 'ball-and-stick',
        typeParams: {
          quality: 'auto',
          sizeFactor: 0.12,
          sizeAspectRatio: 2 / 3,
          alpha: 0.92,
        },
        color: 'uniform',
        colorParams: { value: cssHexToMolstarColor(resolveHighlightGroupColor(group)) },
      },
      { tag: SAVED_SELECTION_REPRESENTATION_TAG }
    );
    if (isCancelled()) {
      await deleteMolstarStateRef(plugin, componentRef);
      return;
    }
  }
}

export async function clearSavedHighlightOverlays(plugin: MolstarPlugin | null): Promise<void> {
  const structures = plugin?.managers?.structure?.hierarchy?.current?.structures ?? [];
  const builder = plugin?.state?.data?.build?.();
  if (!builder) return;
  let deleted = false;
  for (const structure of structures) {
    for (const component of structure.components ?? []) {
      const label = component?.cell?.obj?.label;
      if (typeof label !== 'string' || !label.startsWith(SAVED_SELECTION_COMPONENT_LABEL_PREFIX)) {
        continue;
      }
      const ref = component.cell?.transform?.ref;
      if (!ref) continue;
      builder.delete(ref);
      deleted = true;
    }
  }
  if (deleted) await builder.commit();
}

function cssHexToMolstarColor(value: string): number {
  const normalized = value.replace(/^#/, '');
  return Number.parseInt(normalized, 16);
}

export function useSelectionSideChainOverlay(
  plugin: MolstarPlugin | null,
  selectedResidues: ReadonlyArray<ResidueLocation>,
  enabled: boolean
) {
  const selectionKey = useMemo(
    () => selectionSideChainSelectionKey(selectedResidues),
    [selectedResidues]
  );
  const selectedResiduesRef = useRef(selectedResidues);
  const selectionKeyRef = useRef(selectionKey);
  if (selectionKeyRef.current !== selectionKey) {
    selectionKeyRef.current = selectionKey;
    selectedResiduesRef.current = selectedResidues;
  }

  useEffect(() => {
    let cancelled = false;
    void applySelectionSideChainOverlay(
      plugin,
      selectedResiduesRef.current,
      enabled,
      () => cancelled
    );
    return () => {
      cancelled = true;
    };
  }, [plugin, selectionKey, enabled]);

  useEffect(() => {
    return () => {
      void clearSelectionSideChainOverlay(plugin);
    };
  }, [plugin]);
}

export async function applySelectionSideChainOverlay(
  plugin: MolstarPlugin | null,
  selectedResidues: ReadonlyArray<ResidueLocation>,
  enabled: boolean,
  isCancelled: () => boolean = () => false
): Promise<void> {
  if (!plugin?.managers?.structure?.hierarchy) return;
  const startedAt = performance.now();
  const pluginKey = plugin as object;
  const requestGeneration = (selectionSideChainRequestGenerationByPlugin.get(pluginKey) ?? 0) + 1;
  selectionSideChainRequestGenerationByPlugin.set(pluginKey, requestGeneration);
  const isCurrent = () =>
    !isCancelled() &&
    selectionSideChainRequestGenerationByPlugin.get(pluginKey) === requestGeneration;
  const existing = selectionSideChainOverlayByPlugin.get(pluginKey);
  const selectionKey = selectionSideChainSelectionKey(selectedResidues);

  if (!isCurrent()) return;

  if (!enabled || selectedResidues.length === 0) {
    if (existing && !existing.hidden) {
      setSubtreeVisibility(plugin.state.data, existing.componentRef, true);
      selectionSideChainOverlayByPlugin.set(pluginKey, { ...existing, hidden: true });
      recordSelectionSideChainOverlayDiagnostic({
        enabled,
        selectedCount: selectedResidues.length,
        created: false,
        reused: true,
        operation: 'hide',
        componentRef: existing.componentRef,
        reason: enabled ? 'empty-selection-hidden' : 'disabled-hidden',
        startedAt,
        endedAt: performance.now(),
      });
      return;
    }
    recordSelectionSideChainOverlayDiagnostic({
      enabled,
      selectedCount: selectedResidues.length,
      created: false,
      reused: !!existing,
      operation: 'noop',
      componentRef: existing?.componentRef,
      reason: enabled ? 'empty-selection' : 'disabled',
      startedAt,
      endedAt: performance.now(),
    });
    return;
  }

  if (existing?.selectionKey === selectionKey) {
    if (existing.hidden) {
      setSubtreeVisibility(plugin.state.data, existing.componentRef, false);
      selectionSideChainOverlayByPlugin.set(pluginKey, { ...existing, hidden: false });
      recordSelectionSideChainOverlayDiagnostic({
        enabled,
        selectedCount: selectedResidues.length,
        created: false,
        reused: true,
        operation: 'show',
        componentRef: existing.componentRef,
        reason: 'restored',
        startedAt,
        endedAt: performance.now(),
      });
      return;
    }
    recordSelectionSideChainOverlayDiagnostic({
      enabled,
      selectedCount: selectedResidues.length,
      created: false,
      reused: true,
      operation: 'reuse',
      componentRef: existing.componentRef,
      reason: 'unchanged-selection',
      startedAt,
      endedAt: performance.now(),
    });
    return;
  }

  const expression = buildResidueExpression([...selectedResidues]);
  if (!expression) {
    recordSelectionSideChainOverlayDiagnostic({
      enabled,
      selectedCount: selectedResidues.length,
      created: false,
      reused: false,
      operation: 'noop',
      reason: 'no-expression',
      startedAt,
      endedAt: performance.now(),
    });
    return;
  }

  const structures = plugin.managers.structure.hierarchy.current.structures ?? [];
  const structureRef = structures[0]?.cell ?? structures[0];
  if (!structureRef || !plugin.builders?.structure?.tryCreateComponentFromExpression) {
    recordSelectionSideChainOverlayDiagnostic({
      enabled,
      selectedCount: selectedResidues.length,
      created: false,
      reused: false,
      operation: 'noop',
      reason: 'structure-not-ready',
      startedAt,
      endedAt: performance.now(),
    });
    return;
  }

  const component = await plugin.builders.structure.tryCreateComponentFromExpression(
    structureRef,
    expression,
    nextSelectionSideChainComponentId(),
    { label: SELECTION_SIDE_CHAIN_COMPONENT_LABEL }
  );
  const componentRef = componentRepresentationRef(component);
  if (!isCurrent()) {
    if (componentRef) await deleteMolstarStateRef(plugin, componentRef);
    recordSelectionSideChainOverlayDiagnostic({
      enabled,
      selectedCount: selectedResidues.length,
      created: false,
      reused: false,
      operation: 'cancel',
      componentRef,
      reason: 'cancelled-after-component-create',
      startedAt,
      endedAt: performance.now(),
    });
    return;
  }
  if (!componentRef || !plugin.builders?.structure?.representation?.addRepresentation) {
    recordSelectionSideChainOverlayDiagnostic({
      enabled,
      selectedCount: selectedResidues.length,
      created: false,
      reused: false,
      operation: 'noop',
      reason: component ? 'component-missing-ref' : 'component-not-created',
      startedAt,
      endedAt: performance.now(),
    });
    return;
  }

  await plugin.builders.structure.representation.addRepresentation(
    componentRef,
    {
      type: 'ball-and-stick',
      typeParams: {
        quality: 'auto',
        sizeFactor: 0.14,
        sizeAspectRatio: 2 / 3,
        alpha: 1,
      },
      color: 'element-symbol',
    },
    { tag: SELECTION_SIDE_CHAIN_REPRESENTATION_TAG }
  );
  if (!isCurrent()) {
    await deleteMolstarStateRef(plugin, componentRef);
    recordSelectionSideChainOverlayDiagnostic({
      enabled,
      selectedCount: selectedResidues.length,
      created: false,
      reused: false,
      operation: 'cancel',
      componentRef,
      reason: 'cancelled-after-representation-create',
      startedAt,
      endedAt: performance.now(),
    });
    return;
  }

  selectionSideChainOverlayByPlugin.set(pluginKey, {
    selectionKey,
    componentRef,
    hidden: false,
  });
  if (existing?.componentRef && existing.componentRef !== componentRef) {
    await deleteMolstarStateRef(plugin, existing.componentRef);
  }
  recordSelectionSideChainOverlayDiagnostic({
    enabled,
    selectedCount: selectedResidues.length,
    created: true,
    reused: false,
    operation: existing ? 'replace' : 'create',
    componentRef,
    reason: 'created',
    startedAt,
    endedAt: performance.now(),
  });
}

export async function clearSelectionSideChainOverlay(plugin: MolstarPlugin | null): Promise<void> {
  if (!plugin || (typeof plugin !== 'object' && typeof plugin !== 'function')) return;
  const pluginKey = plugin as object;
  selectionSideChainRequestGenerationByPlugin.set(
    pluginKey,
    (selectionSideChainRequestGenerationByPlugin.get(pluginKey) ?? 0) + 1
  );
  const cached = selectionSideChainOverlayByPlugin.get(pluginKey);
  selectionSideChainOverlayByPlugin.delete(pluginKey);

  const structures = plugin?.managers?.structure?.hierarchy?.current?.structures ?? [];
  const builder = plugin?.state?.data?.build?.();
  if (!builder) return;
  const refsToDelete = new Set<string>();
  if (cached?.componentRef) refsToDelete.add(cached.componentRef);
  for (const structure of structures) {
    for (const component of structure.components ?? []) {
      if (component?.cell?.obj?.label !== SELECTION_SIDE_CHAIN_COMPONENT_LABEL) continue;
      const ref = component.cell?.transform?.ref;
      if (!ref) continue;
      refsToDelete.add(ref);
    }
  }
  for (const ref of refsToDelete) builder.delete(ref);
  if (refsToDelete.size > 0) await builder.commit();
}

function selectionSideChainSelectionKey(selectedResidues: ReadonlyArray<ResidueLocation>): string {
  return selectedResidues
    .map((residue) =>
      [
        residue.chain,
        residue.position,
        residue.compId ?? '',
        residue.baseChain ?? '',
        residue.labelAsymId ?? '',
        residue.authAsymId ?? '',
        residue.entityId ?? '',
        residue.labelSeqId ?? '',
        residue.operator ?? '',
      ].join(':')
    )
    .sort()
    .join('|');
}

async function deleteMolstarStateRef(plugin: MolstarPlugin | null, ref: string): Promise<void> {
  const builder = plugin?.state?.data?.build?.();
  if (!builder) return;
  builder.delete(ref);
  await builder.commit();
}

export function focusOnResidues(
  plugin: MolstarPlugin | null,
  residues: ResidueLocation[]
): boolean {
  if (!plugin?.managers?.camera) return false;
  if (residues.length === 0) return false;

  try {
    const loci = residueLociBySource(plugin, residues);
    if (loci.length) {
      rememberViewerOverview(plugin);
      plugin.managers.camera.focusLoci(loci.length === 1 ? loci[0] : loci, {
        minRadius: 8,
        extraRadius: 4,
        durationMs: 250,
      });
      return true;
    }
  } catch (e) {
    console.warn('[focusOnResidues] Failed to focus:', e);
  }
  return false;
}

export { HIGHLIGHT_COLORS };

function componentRepresentationRef(component: unknown): string | undefined {
  if (typeof component === 'string' && component.length > 0) return component;
  if (!component || typeof component !== 'object') return undefined;
  const candidate = component as {
    ref?: unknown;
    cell?: { transform?: { ref?: unknown } };
  };
  if (typeof candidate.ref === 'string' && candidate.ref.length > 0) return candidate.ref;
  const cellRef = candidate.cell?.transform?.ref;
  return typeof cellRef === 'string' && cellRef.length > 0 ? cellRef : undefined;
}

function recordSelectionSideChainOverlayDiagnostic(event: {
  enabled: boolean;
  selectedCount: number;
  created: boolean;
  reused: boolean;
  operation: 'create' | 'replace' | 'hide' | 'show' | 'reuse' | 'noop' | 'cancel';
  componentRef?: string;
  reason: string;
  startedAt: number;
  endedAt: number;
}) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__?: {
      last: typeof event;
      events: Array<typeof event>;
    };
  };
  const enrichedEvent = {
    ...event,
    durationMs: event.endedAt - event.startedAt,
  };
  const current = testWindow.__WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__;
  testWindow.__WAYPOINT_STRUCTURE_SIDE_CHAIN_VISUALIZATION__ = {
    last: enrichedEvent,
    events: [...(current?.events ?? []), enrichedEvent].slice(-50),
  };
}

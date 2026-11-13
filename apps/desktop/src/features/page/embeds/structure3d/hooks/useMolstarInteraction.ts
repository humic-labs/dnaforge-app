'use client';

import { useEffect, useRef } from 'react';
import type { ResidueLocation, StructureSelectionGesture } from '../types';
import {
  extractEffectiveChainInfo,
  isValidCompId,
  WATER_RESIDUES,
  STANDARD_RESIDUES,
} from '../utils/molstarChainUtils';

import { Bond, StructureElement } from 'molstar/lib/mol-model/structure';
import { Loci } from 'molstar/lib/mol-model/loci';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Vec2 } from 'molstar/lib/mol-math/linear-algebra/3d';
import type { MolstarPlugin } from '../molstar/cache';
import { nativeStructureSourceScope } from '../utils/structureIds';

type MolstarHoverDiagnosticEvent = {
  eventAt: number;
  frameAt: number;
  extractedAt: number;
  callbackStartedAt: number;
  callbackEndedAt: number;
  residue: ResidueLocation | null;
  changed: boolean;
  coalescedEvents: number;
  extractDurationMs: number;
  callbackDurationMs: number;
};

type MolstarClickDiagnosticEvent = {
  stage: string;
  at: number;
  buttons?: number;
  button?: number;
  hasLoci: boolean;
  isEmptyLoci: boolean;
  hasResidue: boolean;
  hasSelectionModifier: boolean;
  isMacContextClick: boolean;
  calledBlankPrimaryClick: boolean;
  residue: ResidueLocation | null;
};

export type MolstarCanvasPointClassification = 'empty' | 'non-empty' | 'unknown';

function lociAtMolstarCanvasPoint(
  plugin: MolstarPlugin | null,
  target: EventTarget | null,
  clientX: number,
  clientY: number
): Loci | null | undefined {
  const canvas3d = plugin?.canvas3d;
  if (!canvas3d?.identify || !canvas3d?.getLoci) return undefined;
  if (!(target instanceof HTMLCanvasElement)) return undefined;

  const rect = target.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return undefined;

  try {
    const pick = canvas3d.identify(Vec2.create(x, y));
    return canvas3d.getLoci(pick?.id)?.loci ?? null;
  } catch {
    return undefined;
  }
}

export function residueAtMolstarCanvasPoint(
  plugin: MolstarPlugin | null,
  target: EventTarget | null,
  clientX: number,
  clientY: number
): ResidueLocation | null {
  const loci = lociAtMolstarCanvasPoint(plugin, target, clientX, clientY);
  if (!loci || Loci.isEmpty(loci)) return null;
  return extractResidueFromLoci(loci, plugin);
}

function recordMolstarHoverDiagnostic(event: MolstarHoverDiagnosticEvent) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_MOLSTAR_INTERACTION_HOVER__?: {
      last: MolstarHoverDiagnosticEvent;
      events: MolstarHoverDiagnosticEvent[];
    };
  };
  const current = testWindow.__WAYPOINT_MOLSTAR_INTERACTION_HOVER__;
  testWindow.__WAYPOINT_MOLSTAR_INTERACTION_HOVER__ = {
    last: event,
    events: [...(current?.events ?? []), event].slice(-100),
  };
}

function recordMolstarClickDiagnostic(event: MolstarClickDiagnosticEvent) {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test') return;
  const testWindow = window as typeof window & {
    __WAYPOINT_MOLSTAR_INTERACTION_CLICK__?: {
      last: MolstarClickDiagnosticEvent;
      events: MolstarClickDiagnosticEvent[];
    };
  };
  const current = testWindow.__WAYPOINT_MOLSTAR_INTERACTION_CLICK__;
  testWindow.__WAYPOINT_MOLSTAR_INTERACTION_CLICK__ = {
    last: event,
    events: [...(current?.events ?? []), event].slice(-50),
  };
}

export function classifyMolstarCanvasPoint(
  plugin: MolstarPlugin | null,
  target: EventTarget | null,
  clientX: number,
  clientY: number
): MolstarCanvasPointClassification {
  const loci = lociAtMolstarCanvasPoint(plugin, target, clientX, clientY);
  if (loci === undefined) return 'unknown';
  if (!loci || Loci.isEmpty(loci)) return 'empty';
  return 'non-empty';
}

export function extractResidueFromLoci(
  loci: Loci,
  plugin?: MolstarPlugin | null
): ResidueLocation | null {
  try {
    if (Bond.isLoci(loci)) {
      const picked = loci.bonds[0];
      if (!picked) return null;

      loci = StructureElement.Loci(loci.structure, [
        {
          unit: picked.aUnit,
          indices: OrderedSet.ofSingleton(picked.aIndex),
        },
      ]);
    }
    if (!StructureElement.Loci.is(loci) || loci.elements.length === 0) return null;
    const { unit, indices } = loci.elements[0];
    if (OrderedSet.size(indices) === 0) return null;

    const elementIdx = OrderedSet.getAt(indices, 0);
    const atomIndex = unit.elements[elementIdx];
    const indexedUnit = unit as {
      residueIndex: ArrayLike<number>;
      chainIndex: ArrayLike<number>;
    };
    const residueIndex = indexedUnit.residueIndex[atomIndex];
    const chainIndex = indexedUnit.chainIndex[atomIndex];

    const hierarchy = unit.model.atomicHierarchy;
    const chainInfo = extractEffectiveChainInfo(unit, hierarchy.chains, chainIndex);
    if (!chainInfo) {
      return null;
    }

    const position = hierarchy.residues.auth_seq_id.value(residueIndex);
    const labelSeqValue = hierarchy.residues.label_seq_id?.value(residueIndex);
    const labelSeqId =
      typeof labelSeqValue === 'number' && Number.isFinite(labelSeqValue)
        ? labelSeqValue
        : undefined;

    if (typeof position !== 'number' || isNaN(position)) {
      return null;
    }

    const rawCompId = hierarchy.atoms.label_comp_id.value(atomIndex);

    if (!isValidCompId(rawCompId)) {
      return null;
    }
    const compId = rawCompId;

    if (WATER_RESIDUES.has(compId)) {
      return null;
    }

    const isLigand = !STANDARD_RESIDUES.has(compId);

    const result: ResidueLocation = {
      chain: chainInfo.effectiveChainId,
      position,
      labelCompId: compId,

      baseChain: chainInfo.baseChain,
      labelAsymId: chainInfo.labelAsymId,
      authAsymId: chainInfo.authAsymId,
      entityId: chainInfo.entityId,
      ...(labelSeqId !== undefined ? { labelSeqId } : {}),
      operator: chainInfo.operator,
      ...(chainInfo.instanceId ? { instanceId: chainInfo.instanceId } : {}),
      ...(plugin ? nativeStructureSourceScope(plugin, loci.structure) : {}),
    };

    if (isLigand) {
      result.compId = compId;
    }

    return result;
  } catch {
    return null;
  }
}

interface MolstarInteractionOptions {
  onHover?: (residue: ResidueLocation | null) => void;

  onClick?: (residue: ResidueLocation, gesture: StructureSelectionGesture) => void;

  onFocusClick?: (loci: Loci) => void;

  onBlankPrimaryClick?: () => void;

  shouldHandleResidue?: (residue: ResidueLocation) => boolean;

  hoverDebounce?: number;
}

export function useMolstarInteraction(
  plugin: MolstarPlugin | null,
  options: MolstarInteractionOptions,
  enabled: boolean = true
) {
  const {
    onHover,
    onClick,
    onFocusClick,
    onBlankPrimaryClick,
    shouldHandleResidue,
    hoverDebounce = 16,
  } = options;

  const onHoverRef = useRef(onHover);
  const onClickRef = useRef(onClick);
  const onFocusClickRef = useRef(onFocusClick);
  const onBlankPrimaryClickRef = useRef(onBlankPrimaryClick);
  const shouldHandleResidueRef = useRef(shouldHandleResidue);
  onHoverRef.current = onHover;
  onClickRef.current = onClick;
  onFocusClickRef.current = onFocusClick;
  onBlankPrimaryClickRef.current = onBlankPrimaryClick;
  shouldHandleResidueRef.current = shouldHandleResidue;

  const lastHoveredRef = useRef<ResidueLocation | null>(null);
  const primaryPointerDownRef = useRef(false);

  useEffect(() => {
    if (!enabled || !plugin?.behaviors?.interaction) return;

    const subscriptions: (() => void)[] = [];
    const canvas = plugin.canvas3d?.webgl?.gl?.canvas as HTMLCanvasElement | undefined;
    const clearPrimaryPointerDown = () => {
      primaryPointerDownRef.current = false;
    };
    if (canvas) {
      const handlePointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        primaryPointerDownRef.current = true;
        if (lastHoveredRef.current) {
          lastHoveredRef.current = null;
          onHoverRef.current?.(null);
        }
      };
      canvas.addEventListener('pointerdown', handlePointerDown);
      window.addEventListener('pointerup', clearPrimaryPointerDown, true);
      window.addEventListener('pointercancel', clearPrimaryPointerDown, true);
      window.addEventListener('blur', clearPrimaryPointerDown);
      subscriptions.push(() => {
        canvas.removeEventListener('pointerdown', handlePointerDown);
        window.removeEventListener('pointerup', clearPrimaryPointerDown, true);
        window.removeEventListener('pointercancel', clearPrimaryPointerDown, true);
        window.removeEventListener('blur', clearPrimaryPointerDown);
        clearPrimaryPointerDown();
      });
    }

    if (onHoverRef.current) {
      try {
        let pendingFrame: number | null = null;
        let pendingLoci: Loci | null = null;
        let pendingEventAt = 0;
        let pendingEventCount = 0;

        const hoverSub = plugin.behaviors.interaction.hover.subscribe(
          (event: { current: { loci: Loci }; buttons?: number }) => {
            if (typeof event.buttons === 'number') {
              primaryPointerDownRef.current = (event.buttons & 1) !== 0;
            }
            if (primaryPointerDownRef.current) return;
            pendingEventAt = performance.now();
            pendingEventCount += 1;
            pendingLoci = event?.current?.loci ?? null;

            if (pendingFrame === null) {
              pendingFrame = requestAnimationFrame(() => {
                const coalescedEvents = pendingEventCount;
                pendingEventCount = 0;
                pendingFrame = null;
                if (primaryPointerDownRef.current) return;
                const frameAt = performance.now();
                const extractedResidue = pendingLoci
                  ? extractResidueFromLoci(pendingLoci, plugin as MolstarPlugin)
                  : null;
                const extractedAt = performance.now();
                const residue =
                  extractedResidue && shouldHandleResidueRef.current?.(extractedResidue) === false
                    ? null
                    : extractedResidue;

                const last = lastHoveredRef.current;
                const changed = !sameResidueLocationForInteraction(residue, last);

                if (changed) {
                  lastHoveredRef.current = residue;
                  const callbackStartedAt = performance.now();
                  onHoverRef.current?.(residue);
                  const callbackEndedAt = performance.now();
                  recordMolstarHoverDiagnostic({
                    eventAt: pendingEventAt,
                    frameAt,
                    extractedAt,
                    callbackStartedAt,
                    callbackEndedAt,
                    residue,
                    changed,
                    coalescedEvents,
                    extractDurationMs: extractedAt - frameAt,
                    callbackDurationMs: callbackEndedAt - callbackStartedAt,
                  });
                } else {
                  const callbackAt = performance.now();
                  recordMolstarHoverDiagnostic({
                    eventAt: pendingEventAt,
                    frameAt,
                    extractedAt,
                    callbackStartedAt: callbackAt,
                    callbackEndedAt: callbackAt,
                    residue,
                    changed,
                    coalescedEvents,
                    extractDurationMs: extractedAt - frameAt,
                    callbackDurationMs: 0,
                  });
                }
              });
            }
          }
        );
        subscriptions.push(() => {
          hoverSub.unsubscribe();
          if (pendingFrame !== null) {
            cancelAnimationFrame(pendingFrame);
          }
        });
      } catch {}
    }

    if (onClickRef.current || onFocusClickRef.current || onBlankPrimaryClickRef.current) {
      try {
        const clickSub = plugin.behaviors.interaction.click.subscribe(
          (event: {
            current: { loci: Loci };
            button?: number;
            buttons?: number;
            modifiers?: { shift?: boolean; meta?: boolean; control?: boolean };
          }) => {
            const loci = event?.current?.loci;
            const hasLoci = Boolean(loci);
            const isEmptyLoci = !loci || Loci.isEmpty(loci);
            const residue = loci ? extractResidueFromLoci(loci, plugin as MolstarPlugin) : null;
            if (residue && shouldHandleResidueRef.current?.(residue) === false) {
              return;
            }

            const rawButtons = event?.buttons;
            const rawButton = event?.button;
            const buttons = rawButtons ?? rawButton ?? 1;
            const modifiers = event?.modifiers;
            const platform =
              typeof navigator !== 'undefined'
                ? `${navigator.platform} ${navigator.userAgent}`
                : '';
            const isMacLike = /\b(Mac|iPhone|iPad|iPod)\b/i.test(platform);
            const isMacContextClick = isMacLike && !!modifiers?.control && !modifiers?.meta;
            const hasSelectionModifier =
              !!modifiers?.meta || !!modifiers?.shift || (!isMacLike && !!modifiers?.control);
            const isSecondaryClick =
              (typeof rawButtons === 'number' && (rawButtons & 2) === 2) || rawButton === 2;
            const isAuxiliaryClick =
              (typeof rawButtons === 'number' && (rawButtons & 4) === 4) || rawButton === 4;
            if (isSecondaryClick || isAuxiliaryClick || isMacContextClick) {
              recordMolstarClickDiagnostic({
                stage: 'non-primary-click-ignored',
                at: performance.now(),
                buttons,
                button: rawButton,
                hasLoci,
                isEmptyLoci,
                hasResidue: !!residue,
                hasSelectionModifier,
                isMacContextClick,
                calledBlankPrimaryClick: false,
                residue,
              });
              return;
            }
            const shouldResetCameraForBlankPrimaryClick =
              buttons === 1 &&
              isEmptyLoci &&
              !hasSelectionModifier &&
              !isMacContextClick &&
              !!onBlankPrimaryClickRef.current;

            if (residue && hasSelectionModifier && !isMacContextClick) {
              const gesture: StructureSelectionGesture = modifiers?.shift ? 'range' : 'toggle';
              onClickRef.current?.(residue, gesture);
            } else if (loci && !Loci.isEmpty(loci)) {
              onFocusClickRef.current?.(loci);
            } else if (shouldResetCameraForBlankPrimaryClick) {
              onBlankPrimaryClickRef.current?.();
            }
            recordMolstarClickDiagnostic({
              stage: shouldResetCameraForBlankPrimaryClick
                ? 'blank-primary-click-reset-camera'
                : 'click-classified',
              at: performance.now(),
              buttons,
              button: event?.button,
              hasLoci,
              isEmptyLoci,
              hasResidue: !!residue,
              hasSelectionModifier,
              isMacContextClick,
              calledBlankPrimaryClick: shouldResetCameraForBlankPrimaryClick,
              residue,
            });
          }
        );
        subscriptions.push(() => clickSub.unsubscribe());
      } catch {}
    }

    return () => {
      subscriptions.forEach((unsub) => unsub());
    };
  }, [enabled, plugin, hoverDebounce]);
}

function sameResidueLocationForInteraction(
  left: ResidueLocation | null,
  right: ResidueLocation | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.chain === right.chain &&
    left.position === right.position &&
    left.compId === right.compId &&
    left.labelCompId === right.labelCompId &&
    left.baseChain === right.baseChain &&
    left.labelAsymId === right.labelAsymId &&
    left.authAsymId === right.authAsymId &&
    left.entityId === right.entityId &&
    left.labelSeqId === right.labelSeqId &&
    left.operator === right.operator
  );
}

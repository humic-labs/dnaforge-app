import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import type { AnnotationStateIdentity, PrimerDisplay } from '@waypoint/workspace-editor';
import type { WebGLMap } from '@waypoint/plasmid-viewer';
import type { BackbonePartHitPayload } from '@waypoint/genome-renderer';
import {
  findCDSAtPosition,
  findStructureAnnotationAtPosition,
  isStructureAnnotationType,
} from '../adapters';
import { resolveContextMenuHighlightRange } from '../context-menu-selection';
import type { SelectionRange } from '../selection-state';

type WebGLContextMenuContext = Parameters<
  NonNullable<ComponentProps<typeof WebGLMap>['onContextMenu']>
>[1];

type ContextMenuTriggerEvent = {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
};

type OrfContext = {
  start: number;
  end: number;
  strand: '+' | '-';
  frame: number;
  length: number;
};

export interface SequenceContextMenuState {
  x: number;
  y: number;
  isOpen: boolean;
  isOnNucleotideRow: boolean;
  position: number | null;
  annotation: Annotation | null;
  clickedCDS: Annotation | null;
  clickedStructureFeature: Annotation | null;
  orf: OrfContext | null;
  primer: PrimerDisplay | null;
  assemblyPart: BackbonePartHitPayload | null;
}

interface ContextMenuInfo {
  isOnNucleotideRow: boolean;
  position: number | null;
  annotation: Annotation | null;
  structureAnnotation?: Annotation | null;
  orf?: OrfContext | null;
  translatedCDS?: Annotation | null;
  primer?: PrimerDisplay | null;
  assemblyPart?: BackbonePartHitPayload | null;
}

interface UseSequenceContextMenuStateInput {
  annotations: Annotation[];
  sequenceLength: number;
  primers?: PrimerDisplay[];
  highlightedRange: SelectionRange | null;
  setHighlightedRange: (range: SelectionRange | null) => void;
  setViewCursor: (position: number | null) => void;
  setSelectedAnnotation: (annotation: AnnotationStateIdentity | null) => void;
}

const CLOSED_CONTEXT_MENU: SequenceContextMenuState = {
  x: 0,
  y: 0,
  isOpen: false,
  isOnNucleotideRow: false,
  position: null,
  annotation: null,
  clickedCDS: null,
  clickedStructureFeature: null,
  orf: null,
  primer: null,
  assemblyPart: null,
};

export function useSequenceContextMenuState({
  annotations,
  sequenceLength,
  primers,
  highlightedRange,
  setHighlightedRange,
  setViewCursor,
  setSelectedAnnotation,
}: UseSequenceContextMenuStateInput) {
  const [contextMenu, setContextMenu] = useState<SequenceContextMenuState>(CLOSED_CONTEXT_MENU);
  const [previewCDS, setPreviewCDS] = useState<Annotation | null>(null);

  const handleContextMenu = useCallback(
    (
      event: ContextMenuTriggerEvent,
      selectionAtTrigger: { start: number; end: number } | null,
      contextInfo: ContextMenuInfo
    ) => {
      const currentRange = selectionAtTrigger ?? highlightedRange;
      const menuSelection = resolveContextMenuHighlightRange({
        currentRange,
        position: contextInfo.position,
        annotation: contextInfo.annotation,
        primer: contextInfo.primer ?? null,
        sequenceLength,
      });

      if (menuSelection !== highlightedRange) {
        setHighlightedRange(menuSelection);
        if (menuSelection) setViewCursor(null);
      }

      const clickedCDS = findCDSAtPosition(
        annotations,
        contextInfo.position,
        contextInfo.annotation,
        menuSelection
      );
      const clickedStructureFeature =
        contextInfo.primer || contextInfo.assemblyPart
          ? null
          : contextInfo.structureAnnotation !== undefined
            ? contextInfo.structureAnnotation
            : contextInfo.annotation
              ? isStructureAnnotationType(contextInfo.annotation.type)
                ? contextInfo.annotation
                : null
              : (contextInfo.translatedCDS ??
                (contextInfo.isOnNucleotideRow
                  ? findStructureAnnotationAtPosition(annotations, contextInfo.position, null)
                  : null));

      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        isOpen: true,
        isOnNucleotideRow: contextInfo.isOnNucleotideRow,
        position: contextInfo.position,
        annotation: contextInfo.annotation,
        clickedCDS,
        clickedStructureFeature,
        orf: contextInfo.orf ?? null,
        primer: contextInfo.primer ?? null,
        assemblyPart: contextInfo.assemblyPart ?? null,
      });
    },
    [annotations, highlightedRange, sequenceLength, setHighlightedRange, setViewCursor]
  );

  const handleWebglMapContextMenu = useCallback(
    (event: MouseEvent, contextInfo: WebGLContextMenuContext) => {
      const annotation =
        contextInfo.featureIndex != null ? (annotations[contextInfo.featureIndex] ?? null) : null;
      setSelectedAnnotation(
        annotation
          ? {
              type: annotation.type,
              name: annotation.name,
              start: annotation.start,
              end: annotation.end,
              direction: annotation.direction,
            }
          : null
      );
      const primerId = contextInfo.primer?.id;
      const primer =
        primerId != null ? (primers?.find((candidate) => candidate.id === primerId) ?? null) : null;
      const selectionAtTrigger = contextInfo.highlightRange
        ? { start: contextInfo.highlightRange[0], end: contextInfo.highlightRange[1] }
        : null;

      handleContextMenu(event, selectionAtTrigger, {
        isOnNucleotideRow: contextInfo.hitResult?.kind === 'cut-site',
        position: contextInfo.cutSite?.position ?? contextInfo.position,
        annotation,
        structureAnnotation:
          annotation && isStructureAnnotationType(annotation.type) ? annotation : null,
        orf: contextInfo.orf,
        primer,
        assemblyPart:
          contextInfo.hitResult?.kind === 'backbone-part' ? contextInfo.hitResult.payload : null,
      });
    },
    [annotations, handleContextMenu, primers, setSelectedAnnotation]
  );

  const effectiveCDS = useMemo(
    () =>
      contextMenu.clickedCDS ??
      (contextMenu.annotation?.type === 'CDS' ? contextMenu.annotation : null),
    [contextMenu.annotation, contextMenu.clickedCDS]
  );

  const effectiveStructureFeature = contextMenu.clickedStructureFeature;

  const handlePreviewCDS = useCallback(
    (previewing: boolean) => setPreviewCDS(previewing ? (effectiveCDS ?? null) : null),
    [effectiveCDS]
  );

  const handleContextMenuClose = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, isOpen: false }));
    setPreviewCDS(null);
  }, []);

  return {
    contextMenu,
    effectiveCDS,
    effectiveStructureFeature,
    previewCDS,
    handleContextMenu,
    handleWebglMapContextMenu,
    handlePreviewCDS,
    handleContextMenuClose,
  };
}

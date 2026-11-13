import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import type { BaseConfig } from '../zoom-math';

export const DEFAULT_SEQ_LENGTH = 500;
export const CONTAINER_WIDTH = 1000;
export const CONTAINER_RECT = { left: 100, top: 50, height: 800 };

export const BASE: BaseConfig = {
  baseCharWidth: DEFAULT_EDITOR_CONFIG.charWidth,
  baseRowHeight: DEFAULT_EDITOR_CONFIG.rowHeight,
  marginLeft: DEFAULT_EDITOR_CONFIG.marginLeft,
};

export function mockContainer(scrollTop = 0): HTMLElement {
  return {
    scrollTop,
    getBoundingClientRect: () => ({
      left: CONTAINER_RECT.left,
      top: CONTAINER_RECT.top,
      width: CONTAINER_WIDTH,
      height: CONTAINER_RECT.height,
      right: CONTAINER_RECT.left + CONTAINER_WIDTH,
      bottom: CONTAINER_RECT.top + CONTAINER_RECT.height,
      x: CONTAINER_RECT.left,
      y: CONTAINER_RECT.top,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;
}

export function buildLayoutAt(
  zoomLevel: number,
  opts: {
    seqLen?: number;
    circular?: boolean;
    virtualRowCount?: number;
    bpOffset?: number;
  } = {}
): {
  seq: AnnotatedSequence;
  config: WorkspaceEditorConfig;
  layout: ReturnType<typeof computeSequenceLayoutImpl>;
} {
  const seqLen = opts.seqLen ?? DEFAULT_SEQ_LENGTH;
  const circular = opts.circular ?? false;
  const virtualRowCount = opts.virtualRowCount ?? 0;
  const bpOffset = opts.bpOffset ?? 0;

  const seq: AnnotatedSequence = {
    id: 'test',
    name: 'test',
    sequence: 'ACGTACGTAC'.repeat(Math.ceil(seqLen / 10)).slice(0, seqLen),
    length: seqLen,
    annotations: [
      { name: 'feat1', type: 'misc_feature', start: 50, end: 150, direction: 1 },
      { name: 'cds1', type: 'CDS', start: 200, end: 350, direction: 1 },
    ],
    circular,
  };

  const scale = zoomLevel / 100;
  const charWidth = DEFAULT_EDITOR_CONFIG.charWidth * scale;
  const rowHeight = DEFAULT_EDITOR_CONFIG.rowHeight * scale;
  const config: WorkspaceEditorConfig = {
    ...DEFAULT_EDITOR_CONFIG,
    charWidth,
    rowHeight,
    charsPerLine: Math.max(
      10,
      Math.floor((CONTAINER_WIDTH - DEFAULT_EDITOR_CONFIG.marginLeft) / charWidth)
    ),
  };

  const layout = computeSequenceLayoutImpl(
    seq,
    config,
    0,
    virtualRowCount,
    [],
    false,
    [],
    bpOffset
  );
  return { seq, config, layout };
}

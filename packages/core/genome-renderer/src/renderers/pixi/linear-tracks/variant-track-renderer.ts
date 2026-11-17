import { VARIANT_CLASS_COLORS } from '@waypoint/sequence-utils';
import type { Container } from 'pixi.js';

import type { AnnotationRecord, VariantRecord } from '@waypoint/genome-data';

import {
  PixiAnnotationTrackRenderer,
  type AnnotationTrackDiagnostics,
} from './annotation-track-renderer';
import type {
  PixiLinearTrackRenderer,
  TrackMeasureContentArgs,
  TrackMountArgs,
  TrackPaintArgs,
} from './types';

export interface VariantTrackData {
  readonly records: ReadonlyArray<VariantRecord>;
}

export interface VariantTrackDiagnostics extends AnnotationTrackDiagnostics {
  readonly rendererKind: 'variant-marker';
}

export interface PixiVariantTrackRendererOptions {
  readonly type: string;
}

export class PixiVariantTrackRenderer implements PixiLinearTrackRenderer<VariantTrackData> {
  readonly type: string;
  private readonly delegate: PixiAnnotationTrackRenderer;
  private readonly adapted = new WeakMap<
    ReadonlyArray<VariantRecord>,
    ReadonlyArray<AnnotationRecord>
  >();

  constructor(options: PixiVariantTrackRendererOptions) {
    this.type = options.type;
    this.delegate = new PixiAnnotationTrackRenderer({ type: options.type, maxLabels: 0 });
  }

  mount(args: TrackMountArgs): Container {
    return this.delegate.mount(args);
  }

  measureContentHeight(args: TrackMeasureContentArgs<VariantTrackData>): number {
    return this.delegate.measureContentHeight({
      ...args,
      data: args.data ? { records: this.adapt(args.data.records) } : null,
    });
  }

  paint(args: TrackPaintArgs<VariantTrackData>): void {
    this.delegate.paint({
      ...args,
      data: args.data ? { records: this.adapt(args.data.records) } : null,
    });
  }

  getDiagnostics(container: Container): VariantTrackDiagnostics | null {
    const diagnostics = this.delegate.getDiagnostics(container);
    return diagnostics ? { rendererKind: 'variant-marker', ...diagnostics } : null;
  }

  unmount(container: Container): void {
    this.delegate.unmount(container);
  }

  private adapt(records: ReadonlyArray<VariantRecord>): ReadonlyArray<AnnotationRecord> {
    const cached = this.adapted.get(records);
    if (cached) return cached;
    const converted = records.map(
      (record): AnnotationRecord => ({
        chrom: record.chrom,
        start: record.start,
        end: Math.max(record.start + 1, record.end),
        name: record.recordId ?? `${record.ref}>${record.alts.join(',')}`,
        color: VARIANT_CLASS_COLORS[record.variantClass],
        extra: { variant: record },
      })
    );
    this.adapted.set(records, converted);
    return converted;
  }
}

import { useMemo } from 'react';
import type { RestrictionEnzyme, CutSite, ThinCutSiteHit } from '@waypoint/sequence-utils';
import {
  findCutSites,
  goldenGateOverhangLengthForEnzymeName,
  isGoldenGateEnzymeName,
  scanEnzymeStreaming,
  sortCutSitesByPosition,
} from '@waypoint/sequence-utils';
import type { RestrictionDigestEnd } from '../../design/public/types';
import { createRestrictionDigestEnd } from '../../design/public/restriction-digest';

export interface OverhangInfo {
  sequence: string;

  kind?: DigestEndKind;

  enzymeName: string;

  enzymeNames: string[];

  sitePosition: number | null;

  siteOrientation: 'forward' | 'reverse' | null;

  rdEnd?: RestrictionDigestEnd;
}

export type DigestEndKind = 'enzyme' | 'native';

export function isNativeDigestEnd(end: Pick<OverhangInfo, 'kind'>): boolean {
  return end.kind === 'native';
}

export type GGFragmentType = 'insert' | 'backbone' | 'unusable' | 'rd';

export interface VirtualDigestFragment {
  index: number;

  startPosition: number;

  endPosition: number;

  length: number;

  upstream: OverhangInfo;

  downstream: OverhangInfo;

  ggType: GGFragmentType;

  wrapsOrigin: boolean;

  hasNativeEnd?: boolean;

  labelPosition?: number;

  annotations: string[];

  primaryAnnotation?: string;

  internalSites: Array<{
    position: number;
    orientation: 'forward' | 'reverse';
  }>;

  hasInternalSites: boolean;
}

export type GGStatus = 'ready' | 'ready-with-warning' | 'not-ready';

export type VirtualDigestDiagnosticScope = 'physical-digest' | 'goldengate';
export type VirtualDigestDiagnosticSeverity = 'info' | 'warning' | 'error';
export type VirtualDigestDiagnosticKind =
  | 'no-cut-sites'
  | 'goldengate-invalid-pair'
  | 'goldengate-extra-sites'
  | 'goldengate-duplicate-overhang';

export interface VirtualDigestDiagnosticAffectedEnd {
  fragmentIndex: number;
  end: 'upstream' | 'downstream';
}

export interface VirtualDigestDiagnostic {
  id: string;
  scope: VirtualDigestDiagnosticScope;
  kind: VirtualDigestDiagnosticKind;
  severity: VirtualDigestDiagnosticSeverity;
  message: string;
  overhang?: string;
  junctionIndices?: number[];
  fragmentIndices?: number[];
  affectedEnds?: VirtualDigestDiagnosticAffectedEnd[];
}

export interface VirtualDigestResult {
  fragments: VirtualDigestFragment[];

  ggStatus: GGStatus;

  warning?: string;

  cutSiteCount: number;

  overhangLength: number;

  enzymeNames: string[];

  digestKind: 'goldengate' | 'restriction';

  circular: boolean;

  diagnostics: VirtualDigestDiagnostic[];
}

interface DigestCutEvent {
  enzyme: RestrictionEnzyme;
  cutSite: CutSite;
  overhangLength: number;
  enzymeNames: string[];
}

export interface VirtualDigestOptions {
  circular?: boolean;

  maxFragments?: number;
}

export interface AsyncVirtualDigestOptions extends VirtualDigestOptions {
  abortSignal?: AbortSignal;

  yieldToEventLoop?: () => Promise<void>;

  scanBatchSize?: number;
}

export class VirtualDigestLimitError extends Error {
  constructor(
    public readonly fragmentCount: number,
    public readonly limit: number
  ) {
    super(`Digest produces at least ${fragmentCount} fragments, above the ${limit} limit.`);
    this.name = 'VirtualDigestLimitError';
  }
}

export function toDigestSourceAnnotations(
  annotations: readonly { name: string; start: number; end: number }[] = []
): Array<{ name: string; start: number; end: number }> {
  return annotations.map((annotation) => ({
    name: annotation.name,
    start: Math.max(0, annotation.start - 1),
    end: annotation.end,
  }));
}

interface DigestFragmentPlan {
  startEvent: DigestCutEvent | null;
  endEvent: DigestCutEvent | null;

  startPos: number;

  endPos: number;
}

function normalizeDigestInput(
  enzymeOrEnzymes: RestrictionEnzyme | RestrictionEnzyme[]
): RestrictionEnzyme[] {
  return Array.isArray(enzymeOrEnzymes) ? enzymeOrEnzymes : [enzymeOrEnzymes];
}

function overhangLengthForEnzyme(enzyme: RestrictionEnzyme): number {
  return goldenGateOverhangLengthForEnzymeName(enzyme.name) ?? enzyme.overhang_length ?? 0;
}

function isGoldenGateDigest(enzymeOrEnzymes: RestrictionEnzyme[]): boolean {
  return enzymeOrEnzymes.length === 1 && isGoldenGateEnzymeName(enzymeOrEnzymes[0].name);
}

function sortDigestCutEvents(events: DigestCutEvent[]): DigestCutEvent[] {
  return [...events].sort((a, b) => {
    const topDelta = a.cutSite.cutPositionTop - b.cutSite.cutPositionTop;
    if (topDelta !== 0) return topDelta;
    const bottomDelta = a.cutSite.cutPositionBottom - b.cutSite.cutPositionBottom;
    if (bottomDelta !== 0) return bottomDelta;
    const recognitionDelta = a.cutSite.recognitionStart - b.cutSite.recognitionStart;
    if (recognitionDelta !== 0) return recognitionDelta;
    return a.enzyme.name.localeCompare(b.enzyme.name);
  });
}

function coalescePhysicalCutEvents(events: DigestCutEvent[]): DigestCutEvent[] {
  const sorted = sortDigestCutEvents(events);
  const coalesced: DigestCutEvent[] = [];

  for (const event of sorted) {
    const previous = coalesced[coalesced.length - 1];
    if (
      previous &&
      previous.cutSite.cutPositionTop === event.cutSite.cutPositionTop &&
      previous.cutSite.cutPositionBottom === event.cutSite.cutPositionBottom
    ) {
      previous.enzymeNames = Array.from(new Set([...previous.enzymeNames, event.enzyme.name])).sort(
        (a, b) => a.localeCompare(b)
      );
      continue;
    }
    coalesced.push({ ...event, enzymeNames: [event.enzyme.name] });
  }

  return coalesced;
}

function appendEnzymeCutSites(params: {
  cutEvents: DigestCutEvent[];
  sites: CutSite[];
  enzyme: RestrictionEnzyme;
  circular: boolean;
  sequenceLength: number;
  cutEventLimit: number | undefined;
  maxFragments: number | undefined;
}): DigestCutEvent[] {
  const { enzyme, circular, sequenceLength, cutEventLimit, maxFragments } = params;
  const events = params.sites
    .map((cutSite) => ({
      enzyme,
      cutSite,
      overhangLength: overhangLengthForEnzyme(enzyme),
      enzymeNames: [enzyme.name],
    }))

    .filter(
      (event) =>
        circular ||
        (event.cutSite.cutPositionTop >= 0 &&
          event.cutSite.cutPositionTop <= sequenceLength &&
          event.cutSite.cutPositionBottom >= 0 &&
          event.cutSite.cutPositionBottom <= sequenceLength)
    );
  const cutEvents = coalescePhysicalCutEvents([...params.cutEvents, ...events]);

  if (cutEventLimit !== undefined && cutEvents.length > cutEventLimit) {
    throw new VirtualDigestLimitError(
      circular ? cutEvents.length : cutEvents.length + 1,
      maxFragments!
    );
  }

  if (
    cutEventLimit !== undefined &&
    params.sites.length === cutEventLimit + 1 &&
    cutEvents.length <= cutEventLimit
  ) {
    throw new VirtualDigestLimitError(maxFragments! + 1, maxFragments!);
  }

  return cutEvents;
}

function virtualDigestAbortError(): Error {
  const error = new Error('Virtual digest canceled.');
  error.name = 'AbortError';
  return error;
}

export function throwIfVirtualDigestAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw virtualDigestAbortError();
}

function thinHitToCutSite(hit: ThinCutSiteHit, enzyme: RestrictionEnzyme): CutSite {
  return {
    enzyme,
    cutPositionTop: hit.cutPositionTop,
    cutPositionBottom: hit.cutPositionBottom,
    ...(hit.cutPositionTopUnwrapped === undefined
      ? {}
      : { cutPositionTopUnwrapped: hit.cutPositionTopUnwrapped }),
    ...(hit.cutPositionBottomUnwrapped === undefined
      ? {}
      : { cutPositionBottomUnwrapped: hit.cutPositionBottomUnwrapped }),
    recognitionStart: hit.recognitionStart,
    recognitionEnd: hit.recognitionEnd,
    strand: hit.strand,
  };
}

function getSiteOrientation(cutSite: CutSite): 'forward' | 'reverse' {
  return cutSite.strand;
}

export function getGGFragmentType(
  upstream: OverhangInfo,
  downstream: OverhangInfo
): GGFragmentType {
  const upstreamOrientation = upstream.siteOrientation;
  const downstreamOrientation = downstream.siteOrientation;

  if (
    isNativeDigestEnd(upstream) ||
    isNativeDigestEnd(downstream) ||
    upstreamOrientation === null ||
    downstreamOrientation === null
  ) {
    return 'unusable';
  }

  if (upstreamOrientation === 'forward' && downstreamOrientation === 'reverse') {
    return 'insert';
  } else if (upstreamOrientation === 'reverse' && downstreamOrientation === 'forward') {
    return 'backbone';
  } else {
    return 'unusable';
  }
}

function calculateLabelPosition(
  startPosition: number,
  endPosition: number,
  seqLength: number,
  wrapsOrigin: boolean
): number {
  if (!wrapsOrigin) {
    return (startPosition + endPosition) / 2 / seqLength;
  }

  const lengthAfterOrigin = endPosition;
  const lengthBeforeOrigin = seqLength - startPosition;
  const totalLength = lengthBeforeOrigin + lengthAfterOrigin;
  const midpointOffset = totalLength / 2;

  if (midpointOffset <= lengthBeforeOrigin) {
    return (startPosition + midpointOffset) / seqLength;
  } else {
    return (midpointOffset - lengthBeforeOrigin) / seqLength;
  }
}

function getOverhangSequence(sequence: string, cutSite: CutSite, overhangLength: number): string {
  const topCut = cutSite.cutPositionTopUnwrapped ?? cutSite.cutPositionTop;
  const bottomCut = cutSite.cutPositionBottomUnwrapped ?? cutSite.cutPositionBottom;
  const start = topCut < bottomCut ? topCut : bottomCut;

  if (
    cutSite.cutPositionTopUnwrapped !== undefined &&
    cutSite.cutPositionBottomUnwrapped !== undefined
  ) {
    const normalizedStart = ((start % sequence.length) + sequence.length) % sequence.length;
    const first = sequence.slice(normalizedStart, normalizedStart + overhangLength);
    if (first.length === overhangLength) return first.toUpperCase();
    return (first + sequence.slice(0, overhangLength - first.length)).toUpperCase();
  }

  return sequence.slice(start, start + overhangLength).toUpperCase();
}

export function detectGoldenGateDuplicateOverhangs(
  fragments: VirtualDigestFragment[]
): VirtualDigestDiagnostic[] {
  const overhangToJunctions = new Map<string, number[]>();

  for (let i = 0; i < fragments.length; i++) {
    if (isNativeDigestEnd(fragments[i].downstream)) continue;
    const junctionOverhang = fragments[i].downstream.sequence.toUpperCase();
    const junctions = overhangToJunctions.get(junctionOverhang);
    if (junctions) junctions.push(i);
    else overhangToJunctions.set(junctionOverhang, [i]);
  }

  const diagnostics: VirtualDigestDiagnostic[] = [];
  for (const [overhang, junctionIndices] of overhangToJunctions) {
    if (junctionIndices.length <= 1) continue;

    const affectedEnds: VirtualDigestDiagnosticAffectedEnd[] = [];
    const fragmentIndices = new Set<number>();

    for (const fragment of fragments) {
      if (
        !isNativeDigestEnd(fragment.upstream) &&
        fragment.upstream.sequence.toUpperCase() === overhang
      ) {
        affectedEnds.push({ fragmentIndex: fragment.index, end: 'upstream' });
        fragmentIndices.add(fragment.index);
      }
      if (
        !isNativeDigestEnd(fragment.downstream) &&
        fragment.downstream.sequence.toUpperCase() === overhang
      ) {
        affectedEnds.push({ fragmentIndex: fragment.index, end: 'downstream' });
        fragmentIndices.add(fragment.index);
      }
    }

    diagnostics.push({
      id: `goldengate-duplicate-overhang:${overhang}`,
      scope: 'goldengate',
      kind: 'goldengate-duplicate-overhang',
      severity: 'warning',
      message: `Overhang ${overhang} appears at ${junctionIndices.length} junctions - may cause mis-ligation`,
      overhang,
      junctionIndices,
      fragmentIndices: Array.from(fragmentIndices).sort((a, b) => a - b),
      affectedEnds,
    });
  }

  return diagnostics;
}

function planCircularFragments(
  cutEvents: DigestCutEvent[],
  seqLength: number
): DigestFragmentPlan[] {
  const plans: DigestFragmentPlan[] = [];
  for (let i = 0; i < cutEvents.length; i++) {
    const startEvent = cutEvents[i];
    const endEvent = cutEvents[(i + 1) % cutEvents.length];
    const startPos = startEvent.cutSite.cutPositionTop;
    let endPos = endEvent.cutSite.cutPositionTop;

    if (endPos <= startPos) {
      endPos += seqLength;
    }

    plans.push({ startEvent, endEvent, startPos, endPos });
  }
  return plans;
}

function planLinearFragments(cutEvents: DigestCutEvent[], seqLength: number): DigestFragmentPlan[] {
  const plans: DigestFragmentPlan[] = [];
  for (let i = 0; i <= cutEvents.length; i++) {
    const startEvent = i === 0 ? null : cutEvents[i - 1];
    const endEvent = i === cutEvents.length ? null : cutEvents[i];
    plans.push({
      startEvent,
      endEvent,
      startPos: startEvent ? startEvent.cutSite.cutPositionTop : 0,
      endPos: endEvent ? endEvent.cutSite.cutPositionTop : seqLength,
    });
  }
  return plans;
}

function enzymeCutEnd(
  sequence: string,
  event: DigestCutEvent,
  end: 'upstream' | 'downstream'
): OverhangInfo {
  const overhang = getOverhangSequence(sequence, event.cutSite, event.overhangLength);
  return {
    sequence: overhang,
    enzymeName: event.enzyme.name,
    enzymeNames: event.enzymeNames,
    sitePosition: event.cutSite.recognitionStart,
    siteOrientation: getSiteOrientation(event.cutSite),
    rdEnd: createRestrictionDigestEnd(sequence, event.cutSite, event.enzyme, end, overhang),
  };
}

function nativeMoleculeEnd(): OverhangInfo {
  return {
    kind: 'native',
    sequence: '',
    enzymeName: '',
    enzymeNames: [],
    sitePosition: null,
    siteOrientation: null,
  };
}

export function computeVirtualDigest(
  sequence: string,
  enzyme: RestrictionEnzyme | RestrictionEnzyme[],
  annotations?: Array<{ name: string; start: number; end: number }>,
  options?: VirtualDigestOptions
): VirtualDigestResult {
  const circular = options?.circular !== false;
  const enzymes = normalizeDigestInput(enzyme);
  const enzymeNames = enzymes.map((input) => input.name);
  const digestKind = isGoldenGateDigest(enzymes) ? 'goldengate' : 'restriction';
  const overhangLength = Math.max(0, ...enzymes.map(overhangLengthForEnzyme));
  const seqLength = sequence.length;
  const maxFragments = options?.maxFragments;
  const cutEventLimit =
    maxFragments === undefined ? undefined : Math.max(0, maxFragments - (circular ? 0 : 1));
  let cutEvents: DigestCutEvent[] = [];

  for (const input of enzymes) {
    const sites = sortCutSitesByPosition(
      findCutSites(sequence, input, {
        circular,

        ...(cutEventLimit === undefined ? {} : { maxHits: cutEventLimit + 1 }),
      })
    );
    cutEvents = appendEnzymeCutSites({
      cutEvents,
      sites,
      enzyme: input,
      circular,
      sequenceLength: seqLength,
      cutEventLimit,
      maxFragments,
    });
  }

  return materializeVirtualDigest({
    sequence,
    annotations,
    circular,
    maxFragments,
    cutEvents,
    enzymeNames,
    digestKind,
    overhangLength,
  });
}

export async function computeVirtualDigestAsync(
  sequence: string,
  enzyme: RestrictionEnzyme | RestrictionEnzyme[],
  annotations?: Array<{ name: string; start: number; end: number }>,
  options?: AsyncVirtualDigestOptions
): Promise<VirtualDigestResult> {
  const circular = options?.circular !== false;
  const enzymes = normalizeDigestInput(enzyme);
  const enzymeNames = enzymes.map((input) => input.name);
  const digestKind = isGoldenGateDigest(enzymes) ? 'goldengate' : 'restriction';
  const overhangLength = Math.max(0, ...enzymes.map(overhangLengthForEnzyme));
  const maxFragments = options?.maxFragments;
  const cutEventLimit =
    maxFragments === undefined ? undefined : Math.max(0, maxFragments - (circular ? 0 : 1));
  const yieldToEventLoop =
    options?.yieldToEventLoop ??
    (() => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0)));
  let cutEvents: DigestCutEvent[] = [];

  throwIfVirtualDigestAborted(options?.abortSignal);
  for (let index = 0; index < enzymes.length; index++) {
    const input = enzymes[index];
    const hits = await scanEnzymeStreaming(
      sequence,
      input,
      index,
      enzymes.length,
      {
        onProgress: () => undefined,
        yieldToEventLoop,
        isCancelled: () => options?.abortSignal?.aborted === true,
      },
      {
        circular,
        batchSize: options?.scanBatchSize ?? 256,
        ...(cutEventLimit === undefined ? {} : { maxHitsPerEnzyme: cutEventLimit + 1 }),
      }
    );
    throwIfVirtualDigestAborted(options?.abortSignal);

    const sites = sortCutSitesByPosition(hits.map((hit) => thinHitToCutSite(hit, input)));
    cutEvents = appendEnzymeCutSites({
      cutEvents,
      sites,
      enzyme: input,
      circular,
      sequenceLength: sequence.length,
      cutEventLimit,
      maxFragments,
    });

    await yieldToEventLoop();
    throwIfVirtualDigestAborted(options?.abortSignal);
  }

  return materializeVirtualDigest({
    sequence,
    annotations,
    circular,
    maxFragments,
    cutEvents,
    enzymeNames,
    digestKind,
    overhangLength,
  });
}

function materializeVirtualDigest(params: {
  sequence: string;
  annotations?: Array<{ name: string; start: number; end: number }>;
  circular: boolean;
  maxFragments: number | undefined;
  cutEvents: DigestCutEvent[];
  enzymeNames: string[];
  digestKind: VirtualDigestResult['digestKind'];
  overhangLength: number;
}): VirtualDigestResult {
  const {
    sequence,
    annotations,
    circular,
    maxFragments,
    cutEvents,
    enzymeNames,
    digestKind,
    overhangLength,
  } = params;
  const seqLength = sequence.length;
  const cutSiteCount = cutEvents.length;
  const diagnostics: VirtualDigestDiagnostic[] = [];

  if (cutSiteCount === 0) {
    diagnostics.push({
      id: 'physical-digest:no-cut-sites',
      scope: 'physical-digest',
      kind: 'no-cut-sites',
      severity: 'warning',
      message: 'No cut sites found',
    });
    return {
      fragments: [],
      ggStatus: 'not-ready',
      warning: 'No cut sites found',
      cutSiteCount,
      overhangLength,
      enzymeNames,
      digestKind,
      circular,
      diagnostics,
    };
  }

  const orientations = cutEvents.map((event) => getSiteOrientation(event.cutSite));
  const hasForward = orientations.includes('forward');
  const hasReverse = orientations.includes('reverse');
  const hasValidPair = hasForward && hasReverse;

  let ggStatus: GGStatus;
  let warning: string | undefined;

  if (digestKind !== 'goldengate') {
    ggStatus = 'not-ready';
    warning = undefined;
  } else if (!hasValidPair) {
    ggStatus = 'not-ready';
    warning =
      cutSiteCount === 1
        ? 'Only 1 cut site found'
        : 'No valid GoldenGate pair (need one forward and one reverse site)';
    diagnostics.push({
      id: 'goldengate:invalid-pair',
      scope: 'goldengate',
      kind: 'goldengate-invalid-pair',
      severity: 'warning',
      message: warning,
    });
  } else if (cutSiteCount > 2) {
    ggStatus = 'ready-with-warning';
    warning = `${cutSiteCount} cut sites found - extra sites may interfere with assembly`;
    diagnostics.push({
      id: 'goldengate:extra-sites',
      scope: 'goldengate',
      kind: 'goldengate-extra-sites',
      severity: 'warning',
      message: warning,
    });
  } else {
    ggStatus = 'ready';
  }

  const fragments: VirtualDigestFragment[] = [];
  const fragmentPlans = (
    circular
      ? planCircularFragments(cutEvents, seqLength)
      : planLinearFragments(cutEvents, seqLength)
  ).filter((plan) => plan.endPos > plan.startPos);
  if (maxFragments !== undefined && fragmentPlans.length > maxFragments) {
    throw new VirtualDigestLimitError(fragmentPlans.length, maxFragments);
  }

  for (let i = 0; i < fragmentPlans.length; i++) {
    const { startEvent, endEvent, startPos, endPos } = fragmentPlans[i];

    const length = endPos - startPos;

    const actualEndPos = circular ? endPos % seqLength : endPos;
    const fragmentStart = circular ? startPos % seqLength : startPos;

    const upstreamOverhang: OverhangInfo = startEvent
      ? enzymeCutEnd(sequence, startEvent, 'upstream')
      : nativeMoleculeEnd();

    const downstreamOverhang: OverhangInfo = endEvent
      ? enzymeCutEnd(sequence, endEvent, 'downstream')
      : nativeMoleculeEnd();

    const fragmentAnnotations: string[] = [];
    let primaryAnnotation: string | undefined;

    if (annotations) {
      for (const ann of annotations) {
        const annStart = ann.start;
        const annEnd = ann.end;

        const fragmentStart = startPos % seqLength;
        const fragmentEnd = actualEndPos;

        let overlaps = false;
        if (fragmentStart < fragmentEnd) {
          overlaps =
            (annStart >= fragmentStart && annStart < fragmentEnd) ||
            (annEnd > fragmentStart && annEnd <= fragmentEnd) ||
            (annStart <= fragmentStart && annEnd >= fragmentEnd);
        } else {
          overlaps =
            annStart >= fragmentStart ||
            annEnd <= fragmentEnd ||
            (annStart <= fragmentEnd && annEnd >= fragmentStart);
        }

        if (overlaps) {
          fragmentAnnotations.push(ann.name);

          if (!primaryAnnotation) {
            primaryAnnotation = ann.name;
          }
        }
      }
    }

    const internalSites: VirtualDigestFragment['internalSites'] = [];
    for (let j = 0; j < cutSiteCount; j++) {
      if (j === i || j === (i + 1) % cutSiteCount) continue;

      const site = cutEvents[j].cutSite;
      const sitePos = site.cutPositionTop;

      let isInternal = false;
      if (startPos < actualEndPos) {
        isInternal = sitePos > startPos && sitePos < actualEndPos;
      } else {
        isInternal = sitePos > startPos || sitePos < actualEndPos;
      }

      if (isInternal) {
        internalSites.push({
          position: sitePos,
          orientation: getSiteOrientation(site),
        });
      }
    }

    const ggType =
      digestKind === 'goldengate' ? getGGFragmentType(upstreamOverhang, downstreamOverhang) : 'rd';

    const wrapsOrigin = circular && (cutSiteCount === 1 || fragmentStart > actualEndPos);

    const labelPosition = calculateLabelPosition(
      fragmentStart,
      actualEndPos,
      seqLength,
      wrapsOrigin
    );

    fragments.push({
      index: i,
      startPosition: fragmentStart,
      endPosition: actualEndPos,
      length,
      upstream: upstreamOverhang,
      downstream: downstreamOverhang,
      ggType,
      wrapsOrigin,
      hasNativeEnd: isNativeDigestEnd(upstreamOverhang) || isNativeDigestEnd(downstreamOverhang),
      labelPosition,
      annotations: fragmentAnnotations,
      primaryAnnotation,
      internalSites,
      hasInternalSites: internalSites.length > 0,
    });
  }

  return {
    fragments,
    circular,
    ggStatus,
    warning,
    cutSiteCount,
    overhangLength,
    enzymeNames,
    digestKind,
    diagnostics:
      digestKind === 'goldengate'
        ? [...diagnostics, ...detectGoldenGateDuplicateOverhangs(fragments)]
        : diagnostics,
  };
}

export type VirtualDigestCalculation =
  | { result: VirtualDigestResult | null; error?: never; errorClass?: never }
  | { result: null; error: unknown; errorClass: 'limit' | 'unknown' };

export function useVirtualDigestCalculation(
  sequence: string | undefined,
  enzyme: RestrictionEnzyme | RestrictionEnzyme[] | undefined,
  annotations?: Array<{ name: string; start: number; end: number }>,

  options?: VirtualDigestOptions
): VirtualDigestCalculation {
  const { circular, maxFragments } = options ?? {};
  return useMemo<VirtualDigestCalculation>(() => {
    if (!sequence || !enzyme || (Array.isArray(enzyme) && enzyme.length === 0)) {
      return { result: null };
    }

    try {
      return {
        result: computeVirtualDigest(sequence, enzyme, annotations, { circular, maxFragments }),
      };
    } catch (error) {
      return {
        result: null,
        error,
        errorClass: error instanceof VirtualDigestLimitError ? 'limit' : 'unknown',
      };
    }
  }, [sequence, enzyme, annotations, circular, maxFragments]);
}

export function useVirtualDigest(
  sequence: string | undefined,
  enzyme: RestrictionEnzyme | RestrictionEnzyme[] | undefined,
  annotations?: Array<{ name: string; start: number; end: number }>,
  options?: VirtualDigestOptions
): VirtualDigestResult | null {
  const calculation = useVirtualDigestCalculation(sequence, enzyme, annotations, options);
  if (calculation.errorClass) throw calculation.error;
  return calculation.result;
}

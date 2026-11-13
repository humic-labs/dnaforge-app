import type { ResolvedTranscript } from '@waypoint/genome-data';
import { pickCanonicalIsoform } from '@waypoint/genome-data';

import type { TranscriptCarrierFeature } from './indexed-genome-legacy-adapter';

export type TranscriptDisplayMode = 'canonical' | 'expanded';

export interface IsoformCollapseOptions {
  mode: TranscriptDisplayMode;
  expandedGeneIds?: ReadonlySet<string>;
}

export function collapseToCanonicalIsoforms(
  features: ReadonlyArray<TranscriptCarrierFeature>,
  options: IsoformCollapseOptions
): TranscriptCarrierFeature[] {
  const expandedGeneIds = options.expandedGeneIds;
  if (options.mode === 'expanded' && (!expandedGeneIds || expandedGeneIds.size === 0)) {
    return features.slice();
  }

  type Slot =
    | { kind: 'passthrough'; feature: TranscriptCarrierFeature }
    | { kind: 'gene'; geneId: string; isoforms: TranscriptCarrierFeature[] };
  const slots: Slot[] = [];
  const geneSlotByGeneId = new Map<string, Extract<Slot, { kind: 'gene' }>>();
  for (const f of features) {
    const geneId = readGeneId(f);
    const isTranscriptShape = isTranscriptCarrier(f);
    if (geneId == null || !isTranscriptShape) {
      slots.push({ kind: 'passthrough', feature: f });
      continue;
    }
    let slot = geneSlotByGeneId.get(geneId);
    if (!slot) {
      slot = { kind: 'gene', geneId, isoforms: [] };
      geneSlotByGeneId.set(geneId, slot);
      slots.push(slot);
    }
    slot.isoforms.push(f);
  }

  const result: TranscriptCarrierFeature[] = [];
  for (const slot of slots) {
    if (slot.kind === 'passthrough') {
      result.push(slot.feature);
      continue;
    }
    const expandThisGene =
      options.mode === 'expanded' || expandedGeneIds?.has(slot.geneId) === true;
    if (expandThisGene || slot.isoforms.length <= 1) {
      for (const iso of slot.isoforms) result.push(iso);
      continue;
    }
    const isoforms = slot.isoforms.filter(isResolvedTranscriptCarrier);
    const canonical = pickCanonicalIsoform(isoforms);
    if (canonical) result.push(canonical);
  }
  return result;
}

type IsoformCarrier = TranscriptCarrierFeature & {
  exons?: unknown;
  cds?: unknown;
  transcriptId?: unknown;
  geneId?: unknown;
  attributes?: { gene?: unknown[]; Parent?: unknown[] };
};

function asIsoformCarrier(feature: TranscriptCarrierFeature): IsoformCarrier {
  return feature;
}

function isTranscriptCarrier(feature: TranscriptCarrierFeature): boolean {
  const carrier = asIsoformCarrier(feature);
  return Array.isArray(carrier.exons) && Array.isArray(carrier.cds);
}

function isResolvedTranscriptCarrier(
  feature: TranscriptCarrierFeature
): feature is TranscriptCarrierFeature & ResolvedTranscript {
  const carrier = asIsoformCarrier(feature);
  return (
    Array.isArray(carrier.exons) &&
    Array.isArray(carrier.cds) &&
    typeof carrier.transcriptId === 'string'
  );
}

function readGeneId(feature: TranscriptCarrierFeature): string | null {
  const carrier = asIsoformCarrier(feature);
  if (typeof carrier.geneId === 'string' && carrier.geneId.length > 0) {
    return carrier.geneId;
  }
  const geneAttr = carrier.attributes?.gene;
  if (Array.isArray(geneAttr) && typeof geneAttr[0] === 'string' && geneAttr[0].length > 0) {
    return geneAttr[0];
  }
  return null;
}

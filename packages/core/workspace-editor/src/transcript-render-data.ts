import type { Annotation } from '@waypoint/sequence-utils';
import { cdsExtensionOriginalBounds } from './cds-extension-affordance';

export type TranscriptAnnotation = Annotation & { codingSegments?: Annotation['segments'] };
const cache = new WeakMap<readonly Annotation[], TranscriptAnnotation[]>();
const cohesiveCache = new WeakMap<readonly Annotation[], TranscriptAnnotation[]>();

export function cohesiveCdsRenderAnnotations(
  annotations: readonly TranscriptAnnotation[]
): TranscriptAnnotation[] {
  const cached = cohesiveCache.get(annotations);
  if (cached) return cached;
  const key = (a: Annotation) => {
    const original = a.type === 'CDS' ? cdsExtensionOriginalBounds(a) : null;
    const draft = a.qualifiers?.source?.[0] === 'pLannotate-draft';
    return `${original?.start ?? a.start}:${original?.end ?? a.end}:${a.direction ?? 1}:${draft ? (a.qualifiers?.status?.[0] ?? 'draft') : 'real'}`;
  };
  const coding = new Map<string, TranscriptAnnotation[]>();
  for (const a of annotations)
    if (a.type === 'CDS') {
      const group = coding.get(key(a));
      if (group) group.push(a);
      else coding.set(key(a), [a]);
    }
  const names = new Map<Annotation, Set<string>>();
  const result = annotations
    .filter((a) => {
      if (!['gene', 'mRNA', 'transcript'].includes(a.type)) return true;
      const matches = coding.get(key(a));
      if (matches?.length !== 1) return true;
      const cds = matches[0];
      if (!cdsExtensionOriginalBounds(cds)) {
        const blocks = (record: Annotation) =>
          record.segments?.length ? record.segments : [{ start: record.start, end: record.end }];
        const aBlocks = blocks(a),
          cBlocks = blocks(cds);
        if (
          aBlocks.length !== cBlocks.length ||
          aBlocks.some(
            (block, i) => block.start !== cBlocks[i].start || block.end !== cBlocks[i].end
          )
        )
          return true;
      }
      let aliases = names.get(cds);
      if (!aliases) {
        aliases = new Set();
        names.set(cds, aliases);
      }
      aliases.add(a.name);
      return false;
    })
    .map((a) => {
      const aliases = names.get(a);
      if (!aliases) return a;
      aliases.add(a.name);
      return { ...a, _compactName: [...aliases].join(' · ') };
    });
  cohesiveCache.set(annotations, result);
  return result;
}

export function transcriptRenderAnnotations(
  annotations: readonly Annotation[]
): TranscriptAnnotation[] {
  const cached = cache.get(annotations);
  if (cached) return cached;
  const cdsByBounds = new Map<string, Annotation[]>();
  const cdsByIdentity = new Map<string, Annotation[]>();
  const keys = (a: Annotation): string[] =>
    ['gene', 'locus_tag', 'transcript_id', 'gene_id', 'Parent'].flatMap((key) =>
      (a.qualifiers?.[key] ?? []).map((value) => `${key}:${value}`)
    );
  const bounds = (a: Annotation) => `${a.start}:${a.end}:${a.direction ?? 1}`;
  for (const a of annotations)
    if (a.type === 'CDS') {
      for (const [map, key] of [
        [cdsByBounds, bounds(a)],
        ...keys(a).map((key) => [cdsByIdentity, key]),
      ] as [Map<string, Annotation[]>, string][]) {
        const group = map.get(key);
        if (group) group.push(a);
        else map.set(key, [a]);
      }
    }
  const result = annotations.map((a) => {
    if (!['gene', 'mRNA', 'transcript'].includes(a.type)) return a;
    const linked = new Set(keys(a).flatMap((key) => cdsByIdentity.get(key) ?? []));
    const matches = linked.size ? [...linked] : (cdsByBounds.get(bounds(a)) ?? []);
    const compatible = matches.filter((c) => (c.direction ?? 1) === (a.direction ?? 1));
    if (compatible.length !== 1) return a;
    const cds = compatible[0];
    const codingSegments = cds.segments?.length
      ? cds.segments
      : [{ start: cds.start, end: cds.end }];
    return { ...a, segments: a.segments?.length ? a.segments : codingSegments, codingSegments };
  });
  cache.set(annotations, result);
  return result;
}

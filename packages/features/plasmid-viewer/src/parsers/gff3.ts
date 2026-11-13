import { parseGff3Line, type GenomeFeature } from '@waypoint/genome-data';
import type { ParsedPlasmid, PlasmidFeature, FeatureDirection } from '../types';

const GFF3_PRAGMA = '##gff-version 3';

export function isGff3Format(content: string): boolean {
  if (!content) return false;
  const lines = content.slice(0, 4096).split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    return line.startsWith(GFF3_PRAGMA);
  }
  return false;
}

function strandToDirection(strand: string): FeatureDirection {
  if (strand === '+') return 'forward';
  if (strand === '-') return 'reverse';
  return 'none';
}

function pickDisplayName(attrs: Record<string, string[]>): string {
  return attrs.Name?.[0] ?? attrs.gene?.[0] ?? attrs.product?.[0] ?? attrs.ID?.[0] ?? 'feature';
}

function attrsToQualifiers(attrs: Record<string, string[]>): PlasmidFeature['qualifiers'] {
  return { ...attrs };
}

function projectGenomeFeatureToPlasmid(f: GenomeFeature): PlasmidFeature {
  return {
    type: f.type,
    start: f.start + 1,
    end: f.end,
    direction: strandToDirection(f.strand),
    qualifiers: attrsToQualifiers(f.attributes),
    displayName: pickDisplayName(f.attributes),
    color: '#9ca3af',
  };
}

function splitEmbeddedFasta(content: string): { gff: string; fasta: string | null } {
  const marker = content.indexOf('\n##FASTA');
  if (marker < 0) return { gff: content, fasta: null };
  return {
    gff: content.slice(0, marker),
    fasta: content.slice(marker + 1),
  };
}

function parseEmbeddedFastaSequence(fasta: string | null): { name: string; sequence: string } {
  if (!fasta) return { name: '', sequence: '' };
  const lines = fasta.split(/\r?\n/);
  let name = '';
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('##') || line.length === 0) continue;
    if (line.startsWith('>')) {
      if (name) break;
      name = line.slice(1).trim().split(/\s+/)[0] ?? '';
      continue;
    }
    out.push(line);
  }
  return { name, sequence: out.join('').toUpperCase() };
}

const TRANSCRIPT_CLASS_TYPES: ReadonlySet<string> = new Set([
  'mRNA',
  'transcript',
  'ncRNA',
  'lnc_RNA',
  'lncRNA',
  'miRNA',
  'snoRNA',
  'snRNA',
  'tRNA',
  'rRNA',
  'pseudogenic_transcript',
]);

function foldTranscripts(raw: GenomeFeature[]): PlasmidFeature[] {
  const byId = new Map<string, GenomeFeature>();
  for (const f of raw) {
    const id = f.attributes.ID?.[0];
    if (id) byId.set(id, f);
  }

  const exonsByParent = new Map<string, Array<{ start: number; end: number }>>();
  const cdsByParent = new Map<string, Array<{ start: number; end: number }>>();
  for (const f of raw) {
    const parentRef = f.attributes.Parent?.[0];
    if (!parentRef) continue;
    if (f.type === 'exon') {
      const acc = exonsByParent.get(parentRef) ?? [];
      acc.push({ start: f.start + 1, end: f.end });
      exonsByParent.set(parentRef, acc);
    } else if (f.type === 'CDS') {
      const acc = cdsByParent.get(parentRef) ?? [];
      acc.push({ start: f.start + 1, end: f.end });
      cdsByParent.set(parentRef, acc);
    }
  }

  for (const arr of exonsByParent.values()) arr.sort((a, b) => a.start - b.start);
  for (const arr of cdsByParent.values()) arr.sort((a, b) => a.start - b.start);

  const emitted: PlasmidFeature[] = [];
  const consumedAsChild = new Set<GenomeFeature>();

  for (const f of raw) {
    if (!TRANSCRIPT_CLASS_TYPES.has(f.type)) continue;
    const id = f.attributes.ID?.[0];
    const exons = id ? exonsByParent.get(id) : undefined;
    const cds = id ? cdsByParent.get(id) : undefined;

    if (exons && id) {
      for (const child of raw) {
        if (child.type === 'exon' && child.attributes.Parent?.[0] === id) {
          consumedAsChild.add(child);
        }
      }
    }
    if (cds && id) {
      for (const child of raw) {
        if (child.type === 'CDS' && child.attributes.Parent?.[0] === id) {
          consumedAsChild.add(child);
        }
      }
    }

    const exonsForFeature = exons && exons.length > 0 ? exons : undefined;
    const cdsForFeature = cds && cds.length > 0 ? cds : undefined;

    emitted.push({
      type: f.type,
      start: f.start + 1,
      end: f.end,
      direction: strandToDirection(f.strand),
      qualifiers: attrsToQualifiers(f.attributes),
      displayName: pickDisplayName(f.attributes),
      color: '#3b82f6',
      ...(exonsForFeature ? { exons: exonsForFeature, segments: exonsForFeature } : {}),
      ...(cdsForFeature ? { cds: cdsForFeature } : {}),
      ...(id ? { transcriptId: id } : {}),
    });
  }

  for (const f of raw) {
    if (consumedAsChild.has(f)) continue;
    if (TRANSCRIPT_CLASS_TYPES.has(f.type)) continue;
    emitted.push(projectGenomeFeatureToPlasmid(f));
  }

  return emitted;
}

export function parseGff3AsPlasmid(content: string): ParsedPlasmid {
  const { gff, fasta } = splitEmbeddedFasta(content);

  const topologyLine = gff.split(/\r?\n/).find((l) => l.startsWith('##dna-indexer-topology'));
  const circular = topologyLine ? topologyLine.endsWith(' circular') : false;

  const raw: GenomeFeature[] = [];
  for (const line of gff.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = parseGff3Line(line);
    if (f) raw.push(f);
  }

  const features = foldTranscripts(raw);

  const fastaParts = parseEmbeddedFastaSequence(fasta);
  const seqid = raw[0]?.chrom ?? fastaParts.name ?? 'gff3';
  const sequence = fastaParts.sequence;
  const length = sequence.length || raw.reduce((m, f) => Math.max(m, f.end), 0);

  return {
    name: seqid,
    length,
    circular,
    sequence,
    features,
    primers: [],
  };
}

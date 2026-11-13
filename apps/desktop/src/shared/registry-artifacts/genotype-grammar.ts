export type ExtractedEdgeType = 'carried_by' | 'has_marker' | 'derives_from' | 'associated_with';

export interface ExtractedEdge {
  type: ExtractedEdgeType;
  fromRole: 'self' | 'other';
  toLookup: { kind: string; name: string };
  confidence: 'suggested';
  sourceSpan: string;
}

const MARKER_VOCABULARY: readonly string[] = [
  'kanMX',
  'natMX',
  'hphMX',
  'bleMX',
  'patMX',
  'ampR',
  'kanR',
  'cmR',
  'tetR',
  'specR',
  'gentR',
  'URA3',
  'LEU2',
  'HIS3',
  'TRP1',
  'LYS2',
  'ADE2',
  'MET15',
  'MET17',
  'LYS5',
];

function tokenBoundaryPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
}

function pushUnique(edges: ExtractedEdge[], edge: ExtractedEdge): void {
  const exists = edges.some(
    (existing) =>
      existing.type === edge.type &&
      existing.fromRole === edge.fromRole &&
      existing.toLookup.kind === edge.toLookup.kind &&
      existing.toLookup.name === edge.toLookup.name
  );
  if (!exists) {
    edges.push(edge);
  }
}

function extractCarriedPlasmids(genotype: string, edges: ExtractedEdge[]): void {
  const pattern = /\[\s*([A-Za-z][\w.-]*)\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(genotype)) !== null) {
    const name = match[1];
    pushUnique(edges, {
      type: 'carried_by',
      fromRole: 'other',
      toLookup: { kind: 'plasmid', name },
      confidence: 'suggested',
      sourceSpan: match[0],
    });
  }
}

function extractMarkers(genotype: string, edges: ExtractedEdge[]): void {
  for (const token of MARKER_VOCABULARY) {
    const match = tokenBoundaryPattern(token).exec(genotype);
    if (match) {
      pushUnique(edges, {
        type: 'has_marker',
        fromRole: 'self',
        toLookup: { kind: 'marker', name: token },
        confidence: 'suggested',
        sourceSpan: match[0],
      });
    }
  }
}

function extractLineage(genotype: string, selfName: string, edges: ExtractedEdge[]): void {
  const self = selfName.trim().toLowerCase();
  const patterns: RegExp[] = [
    /\bderived from\s+([A-Za-z][\w-]*)/gi,
    /\bparent:\s*([A-Za-z][\w-]*)/gi,
    /\b([A-Za-z][\w-]*)\s+derivative\b/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(genotype)) !== null) {
      const parent = match[1];
      if (parent.toLowerCase() === self) {
        continue;
      }
      pushUnique(edges, {
        type: 'derives_from',
        fromRole: 'self',
        toLookup: { kind: 'strain', name: parent },
        confidence: 'suggested',
        sourceSpan: match[0],
      });
    }
  }
}

export function extractGenotypeRelationships(genotype: string, selfName: string): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
  if (!genotype || !genotype.trim()) {
    return edges;
  }
  extractCarriedPlasmids(genotype, edges);
  extractMarkers(genotype, edges);
  extractLineage(genotype, selfName, edges);
  return edges;
}

interface AccessionMatcher {
  pattern: RegExp;
  normalize: (code: string) => string;
}

const ACCESSION_MATCHERS: readonly AccessionMatcher[] = [
  { pattern: /\bAddgene\s*#\s*(\d+)/gi, normalize: (code) => `Addgene #${code}` },
  { pattern: /\bATCC\s*#?\s*([A-Za-z]*-?\d+[A-Za-z]*)/gi, normalize: (code) => `ATCC ${code}` },
  { pattern: /\bDSMZ?\s*#?\s*(\d+)/gi, normalize: (code) => `DSM ${code}` },
];

export function extractSourceRelationships(source: string): ExtractedEdge[] {
  const edges: ExtractedEdge[] = [];
  if (!source || !source.trim()) {
    return edges;
  }
  for (const matcher of ACCESSION_MATCHERS) {
    let match: RegExpExecArray | null;
    while ((match = matcher.pattern.exec(source)) !== null) {
      const name = matcher.normalize(match[1]);
      pushUnique(edges, {
        type: 'associated_with',
        fromRole: 'self',
        toLookup: { kind: 'external_ref', name },
        confidence: 'suggested',
        sourceSpan: match[0].trim(),
      });
    }
  }
  return edges;
}

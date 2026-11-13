import type { CopiedRegion } from './store';

export function copiedRegionName(copiedRegion: CopiedRegion): string {
  return copiedRegion.sourceName || 'Copied sequence';
}

export function copiedRegionKind(copiedRegion: CopiedRegion): string {
  return copiedRegion.sourceType === 'rd' ? 'Restriction digest fragment' : 'PCR product';
}

function copiedRegionNameIncludesKind(copiedRegion: CopiedRegion): boolean {
  const name = copiedRegionName(copiedRegion);
  return copiedRegion.sourceType === 'rd'
    ? /\b(?:rd|digest|restriction)\b/i.test(name)
    : /\b(?:pcr|amplicon)\b/i.test(name);
}

export function copiedRegionCompactContext(copiedRegion: CopiedRegion): string {
  const parts: string[] = [];
  if (!copiedRegionNameIncludesKind(copiedRegion)) {
    parts.push(copiedRegion.sourceType === 'rd' ? 'Digest' : 'PCR');
  }
  parts.push(copiedRegionName(copiedRegion));
  return parts.join(' · ');
}

export function copiedRegionContext(copiedRegion: CopiedRegion): string {
  return [
    copiedRegionCompactContext(copiedRegion),
    `${copiedRegion.sequence.length.toLocaleString()} bp`,
  ].join(' · ');
}

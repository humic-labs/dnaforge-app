import { IUPAC_REGEX_CLASS, IUPAC_COMPLEMENT } from '../iupac';
import type { RestrictionEnzyme, CutSite, CutterFilter, ActiveEnzyme } from './types';

const IUPAC_CODES: Readonly<Record<string, string>> = IUPAC_REGEX_CLASS;

export function recognitionToRegex(recognitionSequence: string): RegExp {
  let pattern = '';
  for (const char of recognitionSequence.toUpperCase()) {
    const code = IUPAC_CODES[char];
    if (code) {
      pattern += code;
    } else {
      pattern += char;
    }
  }
  return new RegExp(pattern, 'gi');
}

function complementBase(base: string): string {
  return IUPAC_COMPLEMENT[base.toUpperCase()] ?? base;
}

export function reverseComplement(sequence: string): string {
  return sequence
    .split('')
    .reverse()
    .map((b) => complementBase(b))
    .join('');
}

export function isPalindrome(recognitionSequence: string): boolean {
  const rc = reverseComplement(recognitionSequence);
  return recognitionSequence.toUpperCase() === rc.toUpperCase();
}

export interface FindCutSitesOptions {
  circular?: boolean;
  maxHits?: number;
}

export function cutSiteRecognitionSelection(
  site: Pick<CutSite, 'recognitionStart' | 'recognitionEnd'>,
  sequenceLength: number
): { start: number; end: number; wraps?: boolean } {
  const start = site.recognitionStart;
  if (sequenceLength <= 0) return { start, end: start };
  if (site.recognitionEnd === 0) {
    return { start, end: sequenceLength - 1 };
  }
  const end = site.recognitionEnd - 1;
  return site.recognitionEnd < start ? { start, end, wraps: true } : { start, end };
}

export function findCutSites(
  sequence: string,
  enzyme: RestrictionEnzyme,
  options: FindCutSitesOptions = {}
): CutSite[] {
  if (enzyme.cut_position_top === null || enzyme.cut_position_bottom === null) {
    return [];
  }
  if (options.maxHits !== undefined && options.maxHits <= 0) return [];

  const cutSites: CutSite[] = [];
  const recSeq = enzyme.recognition_sequence;
  const recLen = enzyme.recognition_sequence_length;

  const length = sequence.length;
  const wrap = options.circular === true && length >= recLen;
  const scanned = wrap ? sequence + sequence.slice(0, recLen - 1) : sequence;
  const norm = (value: number): number => (wrap ? ((value % length) + length) % length : value);

  const forwardRegex = recognitionToRegex(recSeq);
  let match: RegExpExecArray | null;
  while ((match = forwardRegex.exec(scanned)) !== null) {
    const rawStart = match.index;
    const recognitionStart = norm(rawStart);
    const recognitionEnd = norm(rawStart + recLen);

    const cutPositionTopUnwrapped = rawStart + enzyme.cut_position_top;
    const cutPositionBottomUnwrapped = rawStart + enzyme.cut_position_bottom;
    const cutPositionTop = norm(cutPositionTopUnwrapped);
    const cutPositionBottom = norm(cutPositionBottomUnwrapped);

    cutSites.push({
      enzyme,
      cutPositionTop,
      cutPositionBottom,
      ...(wrap ? { cutPositionTopUnwrapped, cutPositionBottomUnwrapped } : {}),
      recognitionStart,
      recognitionEnd,
      strand: 'forward',
    });

    if (match[0].length === 0) {
      forwardRegex.lastIndex++;
    }
    if (options.maxHits !== undefined && cutSites.length >= options.maxHits) {
      return cutSites;
    }
  }

  if (!isPalindrome(recSeq)) {
    const revCompSeq = reverseComplement(recSeq);
    const reverseRegex = recognitionToRegex(revCompSeq);

    while ((match = reverseRegex.exec(scanned)) !== null) {
      const rawStart = match.index;
      const recognitionStart = norm(rawStart);
      const rawEnd = rawStart + recLen;
      const recognitionEnd = norm(rawEnd);

      const cutPositionTopUnwrapped = rawEnd - enzyme.cut_position_bottom;
      const cutPositionBottomUnwrapped = rawEnd - enzyme.cut_position_top;
      const cutPositionTop = norm(cutPositionTopUnwrapped);
      const cutPositionBottom = norm(cutPositionBottomUnwrapped);

      cutSites.push({
        enzyme,
        cutPositionTop,
        cutPositionBottom,
        ...(wrap ? { cutPositionTopUnwrapped, cutPositionBottomUnwrapped } : {}),
        recognitionStart,
        recognitionEnd,
        strand: 'reverse',
      });

      if (match[0].length === 0) {
        reverseRegex.lastIndex++;
      }
      if (options.maxHits !== undefined && cutSites.length >= options.maxHits) {
        return cutSites;
      }
    }
  }

  return cutSites;
}

export function findAllCutSites(sequence: string, enzymes: RestrictionEnzyme[]): CutSite[] {
  return enzymes.flatMap((enzyme) => findCutSites(sequence, enzyme));
}

export function countCutSites(sequence: string, enzyme: RestrictionEnzyme): number {
  if (enzyme.cut_position_top === null || enzyme.cut_position_bottom === null) {
    return 0;
  }
  const recSeq = enzyme.recognition_sequence;
  let count = 0;
  const forwardRegex = recognitionToRegex(recSeq);
  let match: RegExpExecArray | null;
  while ((match = forwardRegex.exec(sequence)) !== null) {
    count += 1;
    if (match[0].length === 0) forwardRegex.lastIndex++;
  }
  if (!isPalindrome(recSeq)) {
    const reverseRegex = recognitionToRegex(reverseComplement(recSeq));
    while ((match = reverseRegex.exec(sequence)) !== null) {
      count += 1;
      if (match[0].length === 0) reverseRegex.lastIndex++;
    }
  }
  return count;
}

export function getActiveEnzymeData(sequence: string, enzyme: RestrictionEnzyme): ActiveEnzyme {
  const cutSites = findCutSites(sequence, enzyme);
  return {
    enzyme,
    cutCount: cutSites.length,
    cutSites,
  };
}

export function filterCutSitesByCutterType(
  cutSites: CutSite[],
  filter: CutterFilter,
  activeEnzymeNames: Set<string>
): CutSite[] {
  if (filter === 'both') {
    return cutSites;
  }

  const sitesByEnzyme = new Map<string, CutSite[]>();
  for (const site of cutSites) {
    const name = site.enzyme.name;
    if (!sitesByEnzyme.has(name)) {
      sitesByEnzyme.set(name, []);
    }
    sitesByEnzyme.get(name)!.push(site);
  }

  const filteredSites: CutSite[] = [];
  for (const [name, sites] of sitesByEnzyme) {
    const count = sites.length;
    const isActive = activeEnzymeNames.has(name);

    if (filter === 'none') {
      if (isActive) {
        filteredSites.push(...sites);
      }
    } else if (filter === 'single') {
      if (count === 1) {
        filteredSites.push(...sites);
      }
    } else if (filter === 'double') {
      if (count === 2) {
        filteredSites.push(...sites);
      }
    } else if (filter === 'single-double') {
      if (count === 1 || count === 2) {
        filteredSites.push(...sites);
      }
    }
  }

  return filteredSites;
}

export function sortCutSitesByPosition(cutSites: CutSite[]): CutSite[] {
  return [...cutSites].sort((a, b) => a.cutPositionTop - b.cutPositionTop);
}

export function groupCutSitesByEnzyme(cutSites: CutSite[]): Map<string, CutSite[]> {
  const grouped = new Map<string, CutSite[]>();
  for (const site of cutSites) {
    const name = site.enzyme.name;
    if (!grouped.has(name)) {
      grouped.set(name, []);
    }
    grouped.get(name)!.push(site);
  }
  return grouped;
}

export function isInRecognitionSite(position: number, cutSites: CutSite[]): CutSite | null {
  for (const site of cutSites) {
    if (position >= site.recognitionStart && position < site.recognitionEnd) {
      return site;
    }
  }
  return null;
}

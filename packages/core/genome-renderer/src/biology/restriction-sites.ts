import { IUPAC_COMPLEMENT } from '@waypoint/sequence-utils';

export interface RestrictionEnzyme {
  name: string;
  recognition: string;
  cutTop: number;
  cutBottom: number;
}

export interface CutSite {
  enzyme: RestrictionEnzyme;
  position: number;
  cutPositionTop: number;
  cutPositionBottom: number;
  recognitionEnd: number;
  overhang: 'blunt' | '5prime' | '3prime';
  isInternalCutSite?: boolean;
  isPreview?: boolean;
  color?: string;
}

export const COMMON_ENZYMES: RestrictionEnzyme[] = [
  { name: 'EcoRI', recognition: 'GAATTC', cutTop: 1, cutBottom: 5 },
  { name: 'BamHI', recognition: 'GGATCC', cutTop: 1, cutBottom: 5 },
  { name: 'HindIII', recognition: 'AAGCTT', cutTop: 1, cutBottom: 5 },
  { name: 'PstI', recognition: 'CTGCAG', cutTop: 5, cutBottom: 1 },
  { name: 'SalI', recognition: 'GTCGAC', cutTop: 1, cutBottom: 5 },
  { name: 'XhoI', recognition: 'CTCGAG', cutTop: 1, cutBottom: 5 },
  { name: 'XbaI', recognition: 'TCTAGA', cutTop: 1, cutBottom: 5 },
  { name: 'NotI', recognition: 'GCGGCCGC', cutTop: 2, cutBottom: 6 },
  { name: 'SmaI', recognition: 'CCCGGG', cutTop: 3, cutBottom: 3 },
  { name: 'KpnI', recognition: 'GGTACC', cutTop: 5, cutBottom: 1 },
  { name: 'NcoI', recognition: 'CCATGG', cutTop: 1, cutBottom: 5 },
  { name: 'NdeI', recognition: 'CATATG', cutTop: 2, cutBottom: 4 },
  { name: 'BglII', recognition: 'AGATCT', cutTop: 1, cutBottom: 5 },
  { name: 'NheI', recognition: 'GCTAGC', cutTop: 1, cutBottom: 5 },
  { name: 'EcoRV', recognition: 'GATATC', cutTop: 3, cutBottom: 3 },
  { name: 'BsaI', recognition: 'GGTCTC', cutTop: 7, cutBottom: 11 },
  { name: 'BbsI', recognition: 'GAAGAC', cutTop: 8, cutBottom: 12 },
  { name: 'BsmBI', recognition: 'CGTCTC', cutTop: 7, cutBottom: 11 },
];

export function findCutSites(
  sequence: string,
  enzymes: RestrictionEnzyme[] = COMMON_ENZYMES
): CutSite[] {
  const sites: CutSite[] = [];
  const upperSeq = sequence.toUpperCase();

  for (const enzyme of enzymes) {
    const recog = enzyme.recognition.toUpperCase();
    const recogLen = recog.length;

    const overhang: 'blunt' | '5prime' | '3prime' =
      enzyme.cutTop === enzyme.cutBottom
        ? 'blunt'
        : enzyme.cutTop < enzyme.cutBottom
          ? '5prime'
          : '3prime';

    let pos = 0;
    while (pos <= upperSeq.length - recogLen) {
      const idx = upperSeq.indexOf(recog, pos);
      if (idx === -1) break;
      sites.push({
        enzyme,
        position: idx,
        cutPositionTop: idx + enzyme.cutTop,
        cutPositionBottom: idx + enzyme.cutBottom,
        recognitionEnd: idx + recogLen,
        overhang,
      });
      pos = idx + 1;
    }

    const rc = reverseComplementRecognition(recog);
    if (rc !== recog) {
      pos = 0;
      while (pos <= upperSeq.length - recogLen) {
        const idx = upperSeq.indexOf(rc, pos);
        if (idx === -1) break;
        sites.push({
          enzyme,
          position: idx,
          cutPositionTop: idx + (recogLen - enzyme.cutBottom),
          cutPositionBottom: idx + (recogLen - enzyme.cutTop),
          recognitionEnd: idx + recogLen,
          overhang,
        });
        pos = idx + 1;
      }
    }
  }

  return sites.sort((a, b) => a.position - b.position);
}

const RC: Readonly<Record<string, string>> = IUPAC_COMPLEMENT;

function reverseComplementRecognition(seq: string): string {
  let rc = '';
  for (let i = seq.length - 1; i >= 0; i--) {
    rc += RC[seq[i]] ?? 'N';
  }
  return rc;
}

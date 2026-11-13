import type { CutSite, RestrictionEnzyme } from './types';

export interface ThinCutSiteHit {
  enzymeName: string;
  cutPositionTop: number;
  cutPositionBottom: number;
  cutPositionTopUnwrapped?: number;
  cutPositionBottomUnwrapped?: number;
  recognitionStart: number;
  recognitionEnd: number;
  strand: 'forward' | 'reverse';
}

export type CutSiteWorkerRequest =
  | {
      type: 'scan';
      jobId: number;
      sequence: string;
      enzymes: RestrictionEnzyme[];
      circular?: boolean;
      maxHitsPerEnzyme?: number;
    }
  | {
      type: 'cancel';
      jobId: number;
    };

export type CutSiteWorkerResponse =
  | {
      type: 'progress';
      jobId: number;
      enzymeName: string;
      enzymeIndex: number;
      totalEnzymes: number;
      hits: ThinCutSiteHit[];
    }
  | {
      type: 'enzyme-done';
      jobId: number;
      enzymeName: string;
      enzymeIndex: number;
      totalEnzymes: number;
    }
  | {
      type: 'done';
      jobId: number;
    }
  | {
      type: 'cancelled';
      jobId: number;
    }
  | {
      type: 'error';
      jobId: number;
      message: string;
    };

export function rehydrateHit(
  thin: ThinCutSiteHit,
  byName: Map<string, RestrictionEnzyme>
): CutSite | null {
  const enzyme = byName.get(thin.enzymeName);
  if (!enzyme) return null;
  return {
    enzyme,
    cutPositionTop: thin.cutPositionTop,
    cutPositionBottom: thin.cutPositionBottom,
    ...(thin.cutPositionTopUnwrapped === undefined
      ? {}
      : { cutPositionTopUnwrapped: thin.cutPositionTopUnwrapped }),
    ...(thin.cutPositionBottomUnwrapped === undefined
      ? {}
      : { cutPositionBottomUnwrapped: thin.cutPositionBottomUnwrapped }),
    recognitionStart: thin.recognitionStart,
    recognitionEnd: thin.recognitionEnd,
    strand: thin.strand,
  };
}

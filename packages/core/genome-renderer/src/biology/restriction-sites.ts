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

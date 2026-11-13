export type Topology = 'linear' | 'circular';

export interface Feature {
  id: string;
  name: string;
  type: string;
  start: number;
  end: number;
  strand: 1 | -1;
  color?: string;
}

export interface DsDNA {
  id: string;
  name: string;
  sequence: string;
  topology: Topology;
  length: number;
  features?: Feature[];
}

export interface Primer {
  id: string;
  name: string;
  sequence: string;
  bindingSequence: string;
  tail: string;
  bindingTm?: number;
}

export interface PrimerPair {
  forward: Primer;
  reverse: Primer;
}

export interface GibsonJunction {
  id: string;
  index: number;
  positionInFinalProduct: number;
  homologySequence: string;
  leftFragmentId: string;
  rightFragmentId: string;
}

export interface AssemblyResult {
  junctions: GibsonJunction[];
  primerPairs: PrimerPair[];
  pcrProducts: DsDNA[];
  assembled: DsDNA;
  validation: {
    valid: boolean;
    errors: string[];
  };
}

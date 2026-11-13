export interface SubsystemTimings {
  transform: number;
  backbone: number;
  features: number;
  labels: number;
  codons: number;
  orfs: number;
  restrictions: number;
  sequence: number;
  highlight: number;
}

export function emptyTimings(): SubsystemTimings {
  return {
    transform: 0,
    backbone: 0,
    features: 0,
    labels: 0,
    codons: 0,
    orfs: 0,
    restrictions: 0,
    sequence: 0,
    highlight: 0,
  };
}

export function totalMs(t: SubsystemTimings): number {
  return (
    t.transform +
    t.backbone +
    t.features +
    t.labels +
    t.codons +
    t.orfs +
    t.restrictions +
    t.sequence +
    t.highlight
  );
}

export function formatTimings(t: SubsystemTimings): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (v > 0.01) parts.push(`${k}: ${v.toFixed(2)}ms`);
  }
  return parts.join(' | ') || '(all <0.01ms)';
}

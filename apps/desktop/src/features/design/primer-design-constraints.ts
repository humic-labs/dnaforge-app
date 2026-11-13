export interface PrimerDesignConstraints {
  targetPcrTm: number;
  overlapLength: number;
}

export function isPrimerDesignConstraints(value: unknown): value is PrimerDesignConstraints {
  return (
    typeof value === 'object' &&
    value !== null &&
    'targetPcrTm' in value &&
    typeof value.targetPcrTm === 'number' &&
    Number.isFinite(value.targetPcrTm) &&
    value.targetPcrTm >= 40 &&
    value.targetPcrTm <= 75 &&
    'overlapLength' in value &&
    typeof value.overlapLength === 'number' &&
    Number.isInteger(value.overlapLength) &&
    value.overlapLength >= 15 &&
    value.overlapLength <= 60
  );
}

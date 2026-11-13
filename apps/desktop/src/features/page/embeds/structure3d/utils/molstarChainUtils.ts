'use client';

export function isValidChainId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 4 && /^[A-Za-z0-9]+$/.test(id);
}

export function isValidEntityId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.length >= 1 && id.length <= 16 && /^[A-Za-z0-9_.-]+$/.test(id)
  );
}

export function extractChainId(
  chainTable: {
    label_asym_id?: { value: (idx: number) => unknown };
    auth_asym_id?: { value: (idx: number) => unknown };
  },
  chainIdx: number
): string | null {
  const labelId = chainTable.label_asym_id?.value(chainIdx);
  const authId = chainTable.auth_asym_id?.value(chainIdx);

  if (isValidChainId(labelId)) {
    return labelId;
  }
  if (isValidChainId(authId)) {
    return authId;
  }
  return null;
}

export function isValidCompId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 10 && /^[A-Za-z0-9]+$/.test(id);
}

export const WATER_RESIDUES = new Set(['HOH', 'WAT', 'H2O', 'DOD', 'D2O']);

export const STANDARD_RESIDUES = new Set([
  'ALA',
  'ARG',
  'ASN',
  'ASP',
  'CYS',
  'GLU',
  'GLN',
  'GLY',
  'HIS',
  'ILE',
  'LEU',
  'LYS',
  'MET',
  'PHE',
  'PRO',
  'SER',
  'THR',
  'TRP',
  'TYR',
  'VAL',
  'SEC',
  'PYL',
  'MSE',
  'HYP',
  'DA',
  'DC',
  'DG',
  'DT',
  'A',
  'C',
  'G',
  'U',
]);

const IDENTITY_OPERATOR = '1_555';
const IDENTITY_ASSEMBLY_OPERATOR = 'ASM_1';

export function getUnitOperatorName(unit: {
  conformation?: {
    operator?: {
      name?: string;
    };
  };
}): string {
  const opName = unit.conformation?.operator?.name;
  if (typeof opName === 'string' && opName.length > 0) {
    return opName;
  }
  return IDENTITY_OPERATOR;
}

export function getOperatorSuffix(operatorName: string): string {
  if (
    !operatorName ||
    operatorName === IDENTITY_OPERATOR ||
    operatorName === IDENTITY_ASSEMBLY_OPERATOR
  ) {
    return '';
  }

  const asmMatch = operatorName.match(/^ASM[_-](\d+)$/);
  if (asmMatch) {
    const num = parseInt(asmMatch[1], 10);
    if (num > 1) {
      return String(num);
    }
    return '';
  }

  const crystalMatch = operatorName.match(/^(\d+)_/);
  if (crystalMatch) {
    const num = parseInt(crystalMatch[1], 10);
    if (num > 1) {
      return String(num);
    }
    return '';
  }

  console.warn('[getOperatorSuffix] Unrecognized operator format:', operatorName);
  return '';
}

export interface EffectiveChainInfo {
  effectiveChainId: string;
  baseChain: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator: string;
  instanceId?: string;
  isPrimary: boolean;
}

export function extractEffectiveChainInfo(
  unit: {
    id: string | number;
    conformation?: {
      operator?: {
        name?: string;
        instanceId?: string;
      };
    };
  },
  chainTable: {
    label_asym_id?: { value: (idx: number) => unknown };
    auth_asym_id?: { value: (idx: number) => unknown };
    label_entity_id?: { value: (idx: number) => unknown };
  },
  chainIdx: number
): EffectiveChainInfo | null {
  const rawLabelAsymId = chainTable.label_asym_id?.value(chainIdx);
  const rawAuthAsymId = chainTable.auth_asym_id?.value(chainIdx);
  const rawEntityId = chainTable.label_entity_id?.value(chainIdx);
  const labelAsymId = isValidChainId(rawLabelAsymId) ? rawLabelAsymId : undefined;
  const authAsymId = isValidChainId(rawAuthAsymId) ? rawAuthAsymId : undefined;
  const entityId = isValidEntityId(rawEntityId) ? rawEntityId : undefined;
  const baseChain = labelAsymId ?? authAsymId ?? extractChainId(chainTable, chainIdx);

  if (!baseChain) return null;

  const operator = getUnitOperatorName(unit);
  const nativeInstanceId = unit.conformation?.operator?.instanceId;
  const isPrimary = operator === IDENTITY_OPERATOR || operator === IDENTITY_ASSEMBLY_OPERATOR;

  const suffix = getOperatorSuffix(operator);

  const effectiveChainId = baseChain + suffix;

  return {
    effectiveChainId,
    baseChain,
    labelAsymId,
    authAsymId,
    entityId,
    operator,
    ...(typeof nativeInstanceId === 'string' && nativeInstanceId.length > 0
      ? { instanceId: nativeInstanceId }
      : {}),
    isPrimary,
  };
}

export function parseEffectiveChainId(effectiveChainId: string): {
  baseChain: string;
  operatorSuffix: string;
} {
  const match = effectiveChainId.match(/^([A-Za-z]+)(\d+)?$/);
  if (match) {
    return {
      baseChain: match[1],
      operatorSuffix: match[2] || '',
    };
  }
  return {
    baseChain: effectiveChainId,
    operatorSuffix: '',
  };
}

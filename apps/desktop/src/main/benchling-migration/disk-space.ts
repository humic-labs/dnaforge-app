import { readStorageCapacity, type StorageCapacity } from '@waypoint/platform/node-storage';
import type { MigrationIssue } from '../../shared/benchling-migration';

export type MigrationStorageEstimateInput = {
  compressedArchiveBytes: number | null;
  declaredUncompressedBytes: number | null;
  projectedObjectBytes: number | null;
  largestTemporaryBytes: number | null;
  safetyMarginRatio?: number;
  minimumSafetyMarginBytes?: number;
};

export type MigrationStorageGate = {
  determinate: boolean;
  allowed: boolean;
  requiredBytes: number | null;
  availableBytes: number;
  capacitySource?: StorageCapacity['source'];
  immediatelyFreeBytes?: number;
  issue: MigrationIssue | null;
};

export type InspectedArchiveStorageEvidence = {
  compressedArchiveBytes: number;
  declaredUncompressedBytes: number;
  largestUncompressedEntryBytes: number;
};

export function deriveInspectedMigrationAcquisitionEstimate(
  inspection: InspectedArchiveStorageEvidence
): MigrationStorageEstimateInput {
  for (const value of [
    inspection.compressedArchiveBytes,
    inspection.declaredUncompressedBytes,
    inspection.largestUncompressedEntryBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Migration ZIP inspection sizes must be non-negative safe integers.');
    }
  }
  if (inspection.largestUncompressedEntryBytes > inspection.declaredUncompressedBytes) {
    throw new Error('Migration ZIP inspection largest entry exceeds its declared total.');
  }

  return {
    compressedArchiveBytes: inspection.compressedArchiveBytes,
    declaredUncompressedBytes: inspection.declaredUncompressedBytes,
    projectedObjectBytes: 0,
    largestTemporaryBytes: Math.max(
      inspection.compressedArchiveBytes,
      inspection.largestUncompressedEntryBytes
    ),
  };
}

export function calculateRequiredMigrationBytes(
  input: MigrationStorageEstimateInput
): number | null {
  const parts = [
    input.compressedArchiveBytes,
    input.declaredUncompressedBytes,
    input.projectedObjectBytes,
    input.largestTemporaryBytes,
  ];
  if (parts.some((part) => part === null)) return null;
  for (const part of parts as number[]) {
    if (!Number.isSafeInteger(part) || part < 0) {
      throw new Error('Migration storage estimates must be non-negative safe integers.');
    }
  }
  const subtotal = (parts as number[]).reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(subtotal)) throw new Error('Migration storage estimate is too large.');
  const ratio = input.safetyMarginRatio ?? 0.1;
  const minimumMargin = input.minimumSafetyMarginBytes ?? 1024 ** 3;
  if (
    !Number.isFinite(ratio) ||
    ratio < 0 ||
    !Number.isSafeInteger(minimumMargin) ||
    minimumMargin < 0
  ) {
    throw new Error('Migration safety margin configuration is invalid.');
  }
  const margin = Math.max(Math.ceil(subtotal * ratio), minimumMargin);
  const required = subtotal + margin;
  if (!Number.isSafeInteger(required)) throw new Error('Migration storage estimate is too large.');
  return required;
}

export function evaluateMigrationStorageGate(
  input: MigrationStorageEstimateInput,
  availableBytes: number
): MigrationStorageGate {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error('Available storage must be a non-negative safe integer.');
  }
  const requiredBytes = calculateRequiredMigrationBytes(input);
  if (requiredBytes === null) {
    return {
      determinate: false,
      allowed: false,
      requiredBytes: null,
      availableBytes,
      issue: {
        code: 'insufficient_storage',
        message: 'Download size cannot be bounded; migration requires user action before download.',
        blocking: true,
        details: { availableBytes, reason: 'size_unknown' },
      },
    };
  }
  if (availableBytes < requiredBytes) {
    return {
      determinate: true,
      allowed: false,
      requiredBytes,
      availableBytes,
      issue: {
        code: 'insufficient_storage',
        message: 'The destination does not have enough available storage for this migration batch.',
        blocking: true,
        details: { requiredBytes, availableBytes },
      },
    };
  }
  return {
    determinate: true,
    allowed: true,
    requiredBytes,
    availableBytes,
    issue: null,
  };
}

export async function checkMigrationStorageGate(
  destinationPath: string,
  input: MigrationStorageEstimateInput
): Promise<MigrationStorageGate> {
  const capacity = await readStorageCapacity(destinationPath, { purpose: 'important' });
  const gate = evaluateMigrationStorageGate(input, capacity.availableBytes);
  const source = {
    capacitySource: capacity.source,
    immediatelyFreeBytes: capacity.freeBytes,
  };
  return {
    ...gate,
    ...source,
    issue: gate.issue ? { ...gate.issue, details: { ...gate.issue.details, ...source } } : null,
  };
}

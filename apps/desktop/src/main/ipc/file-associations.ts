import { handleGroup } from '../../shared/ipc-contract';
import type {
  FileActivationDelivery,
  MaterializeQuickLookPackageRequest,
  PrepareQuickLookPackageRequest,
  PromoteQuickLookPackageRequest,
  PromoteQuickLookPackageResult,
  QuickLookPackageReceipt,
} from '../../shared/file-association-ipc';
import { handlerFamily, type FileAssociationFamilyId } from '../../shared/file-associations';
import type { DefaultHandlerService } from '../file-associations/default-handler-service';
import { assertSafePath } from './path-allowlist';
import { fileAssociationsContract } from '../../shared/ipc/file-associations.contract';

export interface RegisterFileAssociationHandlersDeps {
  readonly takePendingAndMarkReady: () => FileActivationDelivery[];
  readonly defaultHandler: DefaultHandlerService;
  readonly materializeQuickLookPackage: (
    request: MaterializeQuickLookPackageRequest
  ) => Promise<QuickLookPackageReceipt>;
  readonly prepareQuickLookPackage: (request: PrepareQuickLookPackageRequest) => Promise<boolean>;
  readonly promoteQuickLookPackage: (
    request: PromoteQuickLookPackageRequest
  ) => Promise<PromoteQuickLookPackageResult>;
}

function parseFamilyId(value: unknown): FileAssociationFamilyId {
  if (value === 'genbank' || value === 'snapgene') return value;
  throw new Error('Unknown file association family.');
}

function parseMaterializeQuickLookRequest(value: unknown): MaterializeQuickLookPackageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Quick Look request must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sourcePath !== 'string' || record.sourcePath.length === 0) {
    throw new Error('Quick Look source path is required.');
  }
  return {
    sourcePath: record.sourcePath,
    familyId: parseFamilyId(record.familyId),
  };
}

function parsePrepareQuickLookRequest(value: unknown): PrepareQuickLookPackageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Quick Look package preparation request must be an object.');
  }
  const packageRoot = (value as Record<string, unknown>).packageRoot;
  if (typeof packageRoot !== 'string' || packageRoot.length === 0) {
    throw new Error('Quick Look package root is required.');
  }
  return { packageRoot };
}

function parseQuickLookReceipt(value: unknown): QuickLookPackageReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Quick Look receipt must be an object.');
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    'sourcePath',
    'productPath',
    'packageRoot',
    'contentHash',
    'sourceFileName',
  ] as const) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new Error(`Quick Look receipt ${field} is required.`);
    }
  }
  if (!Array.isArray(record.records) || record.records.length === 0) {
    throw new Error('Quick Look receipt records are required.');
  }
  const records = record.records.map((value, ordinal) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Quick Look record ${ordinal + 1} is invalid.`);
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.recordId !== 'string' ||
      candidate.recordId.length === 0 ||
      candidate.ordinal !== ordinal ||
      typeof candidate.displayName !== 'string' ||
      typeof candidate.sequenceLength !== 'number' ||
      !Number.isSafeInteger(candidate.sequenceLength) ||
      candidate.sequenceLength <= 0 ||
      typeof candidate.circular !== 'boolean' ||
      typeof candidate.productPath !== 'string' ||
      candidate.productPath.length === 0
    ) {
      throw new Error(`Quick Look record ${ordinal + 1} is invalid.`);
    }
    return {
      recordId: candidate.recordId,
      ordinal,
      displayName: candidate.displayName,
      sequenceLength: candidate.sequenceLength,
      circular: candidate.circular,
      productPath: candidate.productPath,
    };
  });
  if (new Set(records.map((entry) => entry.recordId)).size !== records.length) {
    throw new Error('Quick Look record ids must be unique.');
  }
  const firstRecord = records[0];
  if (!firstRecord) throw new Error('Quick Look receipt records are required.');
  return {
    sourcePath: record.sourcePath as string,
    productPath: record.productPath as string,
    packageRoot: record.packageRoot as string,
    contentHash: record.contentHash as string,
    familyId: parseFamilyId(record.familyId),
    sourceFileName: record.sourceFileName as string,
    records: [firstRecord, ...records.slice(1)],
  };
}

function parsePromoteQuickLookRequest(value: unknown): PromoteQuickLookPackageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Quick Look promotion request must be an object.');
  }
  const record = value as Record<string, unknown>;
  const destination = record.destination;
  if (!destination || typeof destination !== 'object' || Array.isArray(destination)) {
    throw new Error('Quick Look promotion destination is required.');
  }
  const destinationRecord = destination as Record<string, unknown>;
  if (
    destinationRecord.kind === 'existing-workspace' &&
    typeof destinationRecord.rootPath === 'string' &&
    destinationRecord.rootPath.length > 0
  ) {
    return {
      receipt: parseQuickLookReceipt(record.receipt),
      destination: { kind: 'existing-workspace', rootPath: destinationRecord.rootPath },
    };
  }
  if (
    destinationRecord.kind === 'new-workspace' &&
    typeof destinationRecord.name === 'string' &&
    destinationRecord.name.trim().length > 0
  ) {
    return {
      receipt: parseQuickLookReceipt(record.receipt),
      destination: { kind: 'new-workspace', name: destinationRecord.name },
    };
  }
  throw new Error('Quick Look promotion destination is invalid.');
}

export function registerFileAssociationHandlers(deps: RegisterFileAssociationHandlersDeps): void {
  handleGroup(fileAssociationsContract, {
    takePendingActivations: () => deps.takePendingAndMarkReady(),
    materializeQuickLookPackage: async (_event, request: unknown) => {
      const parsed = parseMaterializeQuickLookRequest(request);
      const sourcePath = await assertSafePath(parsed.sourcePath, {
        requireAbsolute: true,
        errorPrefix: 'Quick Look source',
      });
      return deps.materializeQuickLookPackage({ ...parsed, sourcePath });
    },
    prepareQuickLookPackage: (_event, request: unknown) =>
      deps.prepareQuickLookPackage(parsePrepareQuickLookRequest(request)),
    promoteQuickLookPackage: (_event, request: unknown) =>
      deps.promoteQuickLookPackage(parsePromoteQuickLookRequest(request)),
    queryHandlers: () => deps.defaultHandler.queryAll(),
    requestDefault: (_event, familyId: unknown) =>
      deps.defaultHandler.requestDefault(handlerFamily(familyId).id),
  });
}

import { mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { hostedCatalogIdForAssemblyPaste } from '../reference-assets/hosted-assembly-paste-match';
import {
  acquireNcbiAssemblyPackage,
  parseNcbiAssemblyLink,
} from '../reference-assets/ncbi-assembly-link';
import { BrowserWindow, dialog } from 'electron';
import {
  REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL,
  REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
  REFERENCE_ASSET_GET_LOCAL_PREPARATION_STATUS_CHANNEL,
  REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL,
  REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL,
  REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL,
  REFERENCE_ASSET_LIST_HOSTED_CHANNEL,
  REFERENCE_ASSET_SET_OPEN_VERSIONS_CHANNEL,
  type OpenReferenceVersionV1,
  REFERENCE_ASSET_LIST_LOCAL_CHANNEL,
  REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL,
  REFERENCE_ASSET_RETRY_LOCAL_CHANNEL,
  type HostedReferenceCatalogEntryV1,
  type HubGenomeReferenceSourceV1,
  type PreparedReferenceAssemblyEntryV1,
  type ReferenceAssetGetHostedPreparationStatusRequestV1,
  type ReferenceAssetGetLocalPreparationStatusRequestV1,
  type ReferenceAssetHostedPreparationStatusV1,
  type ReferenceAssetImportHubGenomeRequestV1,
  type ReferenceAssetImportHubGenomeResultV1,
  type ReferenceAssetImportLocalRequestV1,
  type ReferenceAssetImportLocalResultV1,
  type ReferenceAssetHostedInstallProgressV1,
  type ReferenceAssetInstallHostedRequestV1,
  type ReferenceAssetInstallHostedResultV1,
  type ReferenceAssetLocalPreparationStatusV1,
  type ReferenceAssetPreparationProgressUpdateV1,
  type ReferenceAssetPreparationProgressV1,
  type ReferenceAssetRetryLocalRequestV1,
  type ReferenceAssetRetryLocalResultV1,
  type ReferenceAssetThemeModeV1,
} from '../../shared/reference-assets-ipc';
import type { LocalReferenceSourceSelection } from '../reference-assets/local-reference-source-resolver';

export interface ImportLocalReferenceAssetAuthorityInput {
  readonly selection: LocalReferenceSourceSelection;
  readonly themeMode: ReferenceAssetThemeModeV1;
  readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
}

export interface RegisterReferenceAssetIpcHandlersDeps {
  readonly importLocal: (
    input: ImportLocalReferenceAssetAuthorityInput
  ) => Promise<PreparedReferenceAssemblyEntryV1>;
  readonly importHubGenome?: (input: {
    readonly source: HubGenomeReferenceSourceV1;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }) => Promise<PreparedReferenceAssemblyEntryV1>;
  readonly listLocal: () => Promise<ReadonlyArray<PreparedReferenceAssemblyEntryV1>>;
  readonly getLocalPreparationStatus?: (
    assemblyId: string
  ) => Promise<ReferenceAssetLocalPreparationStatusV1 | null>;
  readonly retryLocal?: (input: {
    readonly assemblyId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }) => Promise<PreparedReferenceAssemblyEntryV1>;
  readonly listHosted: () => Promise<ReadonlyArray<HostedReferenceCatalogEntryV1>>;
  readonly getHostedPreparationStatus?: (input: {
    readonly catalogId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
  }) => Promise<ReferenceAssetHostedPreparationStatusV1 | null>;
  readonly installHosted: (input: {
    readonly catalogId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }) => Promise<PreparedReferenceAssemblyEntryV1>;
  readonly openHosted?: (input: {
    readonly catalogId: string;
    readonly themeMode: ReferenceAssetThemeModeV1;
    readonly onProgress: (progress: ReferenceAssetPreparationProgressUpdateV1) => void;
  }) => Promise<ReferenceAssetInstallHostedResultV1>;
  readonly setOpenVersions?: (
    ownerId: number,
    versions: readonly OpenReferenceVersionV1[]
  ) => Promise<void>;
  readonly retainOpenedVersion?: (
    ownerId: number,
    entry: PreparedReferenceAssemblyEntryV1
  ) => Promise<void>;
  readonly releaseRendererVersions?: (ownerId: number) => void;
  readonly createOperationId?: () => string;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireSafeRequestId(value: unknown, message: string): string {
  if (typeof value !== 'string' || !SAFE_REQUEST_ID.test(value)) {
    throw new Error(message);
  }
  return value;
}

function parseImportLocalRequest(input: unknown): ReferenceAssetImportLocalRequestV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('themeMode' in input) ||
    (input.themeMode !== 'light' && input.themeMode !== 'dark')
  ) {
    throw new Error('Invalid custom reference import request.');
  }
  if (
    !('operationId' in input) ||
    typeof input.operationId !== 'string' ||
    !SAFE_REQUEST_ID.test(input.operationId)
  ) {
    throw new Error('Invalid custom reference import request.');
  }
  const sourcePath = 'sourcePath' in input ? input.sourcePath : undefined;
  if (
    sourcePath !== undefined &&
    (typeof sourcePath !== 'string' ||
      sourcePath.trim() === '' ||
      sourcePath.includes('\0') ||
      !isAbsolute(sourcePath))
  ) {
    throw new Error('Invalid custom reference import request.');
  }
  const assemblyLink = 'assemblyLink' in input ? input.assemblyLink : undefined;
  if (
    assemblyLink !== undefined &&
    (typeof assemblyLink !== 'string' ||
      assemblyLink.trim() === '' ||
      assemblyLink.length > 2_048 ||
      assemblyLink.includes('\0'))
  ) {
    throw new Error('Invalid custom reference import request.');
  }
  if (sourcePath && assemblyLink) {
    throw new Error('Invalid custom reference import request.');
  }
  return {
    operationId: input.operationId,
    themeMode: input.themeMode,
    ...(sourcePath ? { sourcePath } : {}),
    ...(assemblyLink ? { assemblyLink } : {}),
  };
}

const MAX_HUB_URL_LENGTH = 2048;
const MAX_HUB_TEXT_LENGTH = 512;

function optionalHubText(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.includes('\0') || value.length > MAX_HUB_TEXT_LENGTH) {
    throw new Error(message);
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseImportHubGenomeRequest(input: unknown): ReferenceAssetImportHubGenomeRequestV1 {
  const message = 'Invalid hub genome import request.';
  if (typeof input !== 'object' || input === null) throw new Error(message);
  const record = input as Record<string, unknown>;
  if (record.themeMode !== 'light' && record.themeMode !== 'dark') throw new Error(message);
  if (record.provider !== 'assembly-hub' && record.provider !== 'genark') throw new Error(message);
  const operationId = requireSafeRequestId(record.operationId, message);
  const genome = requireSafeRequestId(record.genome, message);
  for (const field of ['hubUrl', 'twoBitPath'] as const) {
    const value = record[field];
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.includes('\0') ||
      value.length > MAX_HUB_URL_LENGTH
    ) {
      throw new Error(message);
    }
  }
  const organism = optionalHubText(record.organism, message);
  const assemblyName = optionalHubText(record.assemblyName, message);
  const taxId = record.taxId;
  if (taxId !== undefined && (!Number.isSafeInteger(taxId) || (taxId as number) <= 0)) {
    throw new Error(message);
  }
  return {
    operationId,
    themeMode: record.themeMode,
    provider: record.provider,
    hubUrl: (record.hubUrl as string).trim(),
    genome,
    twoBitPath: (record.twoBitPath as string).trim(),
    ...(organism ? { organism } : {}),
    ...(assemblyName ? { assemblyName } : {}),
    ...(taxId !== undefined ? { taxId: taxId as number } : {}),
  };
}

function parseGetLocalPreparationStatusRequest(
  input: unknown
): ReferenceAssetGetLocalPreparationStatusRequestV1 {
  if (typeof input !== 'object' || input === null || !('assemblyId' in input)) {
    throw new Error('Invalid local reference preparation status request.');
  }
  return {
    assemblyId: requireSafeRequestId(
      input.assemblyId,
      'Invalid local reference preparation status request.'
    ),
  };
}

function parseRetryLocalRequest(input: unknown): ReferenceAssetRetryLocalRequestV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('operationId' in input) ||
    !('assemblyId' in input) ||
    !('themeMode' in input) ||
    (input.themeMode !== 'light' && input.themeMode !== 'dark')
  ) {
    throw new Error('Invalid local reference retry request.');
  }
  return {
    operationId: requireSafeRequestId(input.operationId, 'Invalid local reference retry request.'),
    assemblyId: requireSafeRequestId(input.assemblyId, 'Invalid local reference retry request.'),
    themeMode: input.themeMode,
  };
}

function parseInstallHostedRequest(input: unknown): ReferenceAssetInstallHostedRequestV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('catalogId' in input) ||
    typeof input.catalogId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.catalogId) ||
    !('themeMode' in input) ||
    (input.themeMode !== 'light' && input.themeMode !== 'dark') ||
    !('intent' in input) ||
    (input.intent !== 'open-view' && input.intent !== 'require-ready')
  ) {
    throw new Error('Invalid hosted reference install request.');
  }
  return {
    catalogId: input.catalogId,
    themeMode: input.themeMode,
    intent: input.intent,
  };
}

function parseGetHostedPreparationStatusRequest(
  input: unknown
): ReferenceAssetGetHostedPreparationStatusRequestV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('catalogId' in input) ||
    !('themeMode' in input) ||
    (input.themeMode !== 'light' && input.themeMode !== 'dark')
  ) {
    throw new Error('Invalid hosted reference preparation status request.');
  }
  return {
    catalogId: requireSafeRequestId(
      input.catalogId,
      'Invalid hosted reference preparation status request.'
    ),
    themeMode: input.themeMode,
  };
}

function parseProgressUpdate(
  input: ReferenceAssetPreparationProgressUpdateV1
): ReferenceAssetPreparationProgressUpdateV1 {
  if (
    typeof input.phase !== 'string' ||
    input.phase.trim() === '' ||
    typeof input.label !== 'string' ||
    input.label.trim() === ''
  ) {
    throw new Error('Invalid reference preparation progress update.');
  }
  const hasCompleted = input.completed !== undefined;
  const hasTotal = input.total !== undefined;
  if (hasCompleted !== hasTotal) {
    throw new Error('Reference preparation progress must provide both completed and total.');
  }
  if (
    hasCompleted &&
    (!Number.isFinite(input.completed) ||
      !Number.isFinite(input.total) ||
      input.completed! < 0 ||
      input.total! <= 0 ||
      input.completed! > input.total!)
  ) {
    throw new Error('Invalid bounded reference preparation progress.');
  }
  if (
    input.assemblyId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.assemblyId)
  ) {
    throw new Error('Invalid reference preparation assembly id.');
  }
  return {
    phase: input.phase,
    label: input.label,
    ...(input.assemblyId ? { assemblyId: input.assemblyId } : {}),
    ...(hasCompleted ? { completed: input.completed, total: input.total } : {}),
  };
}

type ProgressSender = {
  readonly isDestroyed?: () => boolean;
  readonly send: (channel: string, ...args: unknown[]) => void;
};

function sendProgressBestEffort(
  sender: ProgressSender,
  channel: typeof REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL,
  progress: ReferenceAssetPreparationProgressV1
): void;
function sendProgressBestEffort(
  sender: ProgressSender,
  channel: typeof REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
  progress: ReferenceAssetHostedInstallProgressV1
): void;
function sendProgressBestEffort(
  sender: ProgressSender,
  channel:
    | typeof REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL
    | typeof REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
  progress: ReferenceAssetPreparationProgressV1 | ReferenceAssetHostedInstallProgressV1
): void {
  try {
    if (sender.isDestroyed?.()) return;
    if (channel === REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL) {
      sendRendererIpc(
        sender,
        REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
        progress as ReferenceAssetHostedInstallProgressV1
      );
    } else {
      sendRendererIpc(sender, REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL, progress);
    }
  } catch {}
}

export function registerReferenceAssetIpcHandlers(
  deps: RegisterReferenceAssetIpcHandlersDeps
): void {
  mainIpc.handle(
    REFERENCE_ASSET_IMPORT_LOCAL_CHANNEL,
    async (event, rawRequest: unknown): Promise<ReferenceAssetImportLocalResultV1> => {
      const request = parseImportLocalRequest(rawRequest);
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { status: 'cancelled' };

      const publishProgress = (update: ReferenceAssetPreparationProgressUpdateV1): void => {
        const progress: ReferenceAssetPreparationProgressV1 = {
          operationId: request.operationId,
          ...parseProgressUpdate(update),
        };
        sendProgressBestEffort(
          event.sender,
          REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL,
          progress
        );
      };
      if (request.assemblyLink) {
        const hostedCatalogId = hostedCatalogIdForAssemblyPaste(request.assemblyLink);
        if (hostedCatalogId) return { status: 'hosted', catalogId: hostedCatalogId };
        let parsedAccession = false;
        try {
          parseNcbiAssemblyLink(request.assemblyLink);
          parsedAccession = true;
        } catch {
          parsedAccession = false;
        }
        if (!parsedAccession) {
          throw new Error(
            'That name is not in the hosted library. Paste the GCF or GCA accession.'
          );
        }
        publishProgress({
          phase: 'sources-selected',
          label: 'Downloading the NCBI assembly package',
        });
      }
      const linkedPackage = request.assemblyLink
        ? await acquireNcbiAssemblyPackage({ link: request.assemblyLink })
        : null;
      const selection = linkedPackage
        ? { canceled: false, filePaths: [linkedPackage.packagePath] }
        : request.sourcePath
          ? { canceled: false, filePaths: [request.sourcePath] }
          : await dialog.showOpenDialog(win, {
              title: 'Add reference',
              properties: ['openFile', 'openDirectory'],
              filters: [
                {
                  name: 'Reference sequence or NCBI package',
                  extensions: ['fa', 'fasta', 'fna', 'ffn', 'frn', 'gz', 'zip'],
                },
              ],
            });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      if (selection.filePaths.length !== 1) {
        throw new Error('Choose exactly one folder containing one reference assembly.');
      }

      publishProgress({
        phase: 'sources-selected',
        label: linkedPackage
          ? `Downloaded NCBI assembly ${linkedPackage.accession}`
          : 'Inspecting selected reference source',
      });

      try {
        const entry = await deps.importLocal({
          selection: {
            path: selection.filePaths[0],
          },
          themeMode: request.themeMode,
          onProgress: publishProgress,
        });
        return { status: 'ready', entry };
      } finally {
        if (linkedPackage) {
          await rm(linkedPackage.directoryPath, { recursive: true, force: true });
        }
      }
    }
  );

  mainIpc.handle(
    REFERENCE_ASSET_IMPORT_HUB_GENOME_CHANNEL,
    async (event, rawRequest: unknown): Promise<ReferenceAssetImportHubGenomeResultV1> => {
      const request = parseImportHubGenomeRequest(rawRequest);
      if (!deps.importHubGenome) {
        throw new Error('Assembly hub import is unavailable.');
      }
      const publishProgress = (update: ReferenceAssetPreparationProgressUpdateV1): void => {
        const progress: ReferenceAssetPreparationProgressV1 = {
          operationId: request.operationId,
          ...parseProgressUpdate(update),
        };
        sendProgressBestEffort(
          event.sender,
          REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL,
          progress
        );
      };
      publishProgress({
        phase: 'hub-genome-selected',
        label: `Fetching ${request.genome} from its hub`,
      });
      const { operationId: _operationId, themeMode, ...source } = request;
      const entry = await deps.importHubGenome({
        source,
        themeMode,
        onProgress: publishProgress,
      });
      return { status: 'ready', entry };
    }
  );

  mainIpc.handle(REFERENCE_ASSET_LIST_LOCAL_CHANNEL, () => deps.listLocal());
  mainIpc.handle(REFERENCE_ASSET_GET_LOCAL_PREPARATION_STATUS_CHANNEL, (_event, rawRequest) => {
    const request = parseGetLocalPreparationStatusRequest(rawRequest);
    return deps.getLocalPreparationStatus?.(request.assemblyId) ?? null;
  });
  mainIpc.handle(
    REFERENCE_ASSET_RETRY_LOCAL_CHANNEL,
    async (event, rawRequest: unknown): Promise<ReferenceAssetRetryLocalResultV1> => {
      const request = parseRetryLocalRequest(rawRequest);
      if (!deps.retryLocal) {
        throw new Error('Local reference retry is unavailable.');
      }
      const publishProgress = (update: ReferenceAssetPreparationProgressUpdateV1): void => {
        const progress: ReferenceAssetPreparationProgressV1 = {
          operationId: request.operationId,
          ...parseProgressUpdate(update),
        };
        sendProgressBestEffort(
          event.sender,
          REFERENCE_ASSET_PREPARATION_PROGRESS_CHANNEL,
          progress
        );
      };
      const entry = await deps.retryLocal({
        assemblyId: request.assemblyId,
        themeMode: request.themeMode,
        onProgress: publishProgress,
      });
      return { status: 'ready', entry };
    }
  );
  const versionOwners = new Set<number>();
  mainIpc.handle(
    REFERENCE_ASSET_SET_OPEN_VERSIONS_CHANNEL,
    async (event, rawVersions: unknown): Promise<void> => {
      if (!Array.isArray(rawVersions) || rawVersions.length > 256)
        throw new Error('Invalid open reference versions.');
      const versions = rawVersions.map((value): OpenReferenceVersionV1 => {
        if (!value || typeof value !== 'object') throw new Error('Invalid open reference version.');
        return {
          catalogId: requireSafeRequestId(value.catalogId, 'Invalid open reference catalog ID.'),
          generationId: requireSafeRequestId(
            value.generationId,
            'Invalid open reference generation ID.'
          ),
        };
      });
      if (!versionOwners.has(event.sender.id)) {
        versionOwners.add(event.sender.id);
        event.sender.once('destroyed', () => {
          versionOwners.delete(event.sender.id);
          deps.releaseRendererVersions?.(event.sender.id);
        });
      }
      await deps.setOpenVersions?.(event.sender.id, versions);
    }
  );
  mainIpc.handle(REFERENCE_ASSET_LIST_HOSTED_CHANNEL, () => deps.listHosted());
  mainIpc.handle(
    REFERENCE_ASSET_GET_HOSTED_PREPARATION_STATUS_CHANNEL,
    (_event, rawRequest: unknown) => {
      const request = parseGetHostedPreparationStatusRequest(rawRequest);
      return deps.getHostedPreparationStatus?.(request) ?? null;
    }
  );
  mainIpc.handle(
    REFERENCE_ASSET_INSTALL_HOSTED_CHANNEL,
    async (event, rawRequest: unknown): Promise<ReferenceAssetInstallHostedResultV1> => {
      const request = parseInstallHostedRequest(rawRequest);
      const operationId = (deps.createOperationId ?? randomUUID)();
      const publishProgress = (update: ReferenceAssetPreparationProgressUpdateV1): void => {
        const progress: ReferenceAssetHostedInstallProgressV1 = {
          operationId,
          catalogId: request.catalogId,
          ...parseProgressUpdate(update),
        };
        sendProgressBestEffort(
          event.sender,
          REFERENCE_ASSET_HOSTED_INSTALL_PROGRESS_CHANNEL,
          progress
        );
      };
      publishProgress({
        phase: 'resolving-hosted-reference',
        label: 'Checking the hosted reference',
      });
      if (request.intent === 'open-view' && deps.openHosted) {
        const opened = await deps.openHosted({
          catalogId: request.catalogId,
          themeMode: request.themeMode,
          onProgress: publishProgress,
        });
        await deps.retainOpenedVersion?.(event.sender.id, opened.entry);
        return opened;
      }
      const entry = await deps.installHosted({
        catalogId: request.catalogId,
        themeMode: request.themeMode,
        onProgress: publishProgress,
      });
      await deps.retainOpenedVersion?.(event.sender.id, entry);
      return { status: 'ready', entry };
    }
  );
}

import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import {
  BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS,
  BENCHLING_MIGRATION_RENDER_VALIDATION_REQUEST_CHANNEL,
  BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
  isSafeMigrationDestinationPath,
  migrationRenderValidationResponseChannel,
  parseMigrationRenderValidationRequest,
  parseMigrationRenderValidationResponse,
  type MigrationRenderSurface,
  type MigrationRenderValidationRequest,
  type MigrationRenderValidationResponse,
} from '../../shared/benchling-migration-render-validation';
import type { ProjectionReceipt } from '../../shared/benchling-migration';
import type { LocalBundleRenderValidationInput } from './local-bundle-executor';
import { BENCHLING_REGISTRY_CONVERTER_ID } from './registry-projection';
import type { MigrationRenderCheck } from './validation';
import { buildNativeMigrationMaterializationPlan } from './native-materialization';
import { createMigrationRendererReadiness } from './renderer-readiness';
import { BENCHLING_MIGRATION_RENDER_VALIDATION_READY_CHANNEL } from '../../shared/benchling-migration-render-validation';

const DEFAULT_RENDER_VALIDATION_TIMEOUT_MS = 30_000;
const RENDER_REQUEST_PATH_CONCURRENCY = 16;

export type RendererMigrationRenderValidatorOptions = {
  timeoutMs?: number;
};

export function createRendererMigrationRenderValidator(
  getMainWindow: () => BrowserWindow | null,
  options: RendererMigrationRenderValidatorOptions = {}
): (input: LocalBundleRenderValidationInput) => Promise<MigrationRenderCheck[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_VALIDATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error('Migration renderer-validation timeout must be between 1 and 120000 ms.');
  }
  const readiness = createMigrationRendererReadiness(() => {
    const window = getMainWindow();
    return window && !window.isDestroyed() && !window.webContents.isDestroyed()
      ? window.webContents
      : null;
  });
  const observed = new WeakSet<BrowserWindow['webContents']>();
  mainIpc.on(BENCHLING_MIGRATION_RENDER_VALIDATION_READY_CHANNEL, (event, ready) => {
    if (typeof ready !== 'boolean' || event.sender !== getMainWindow()?.webContents) return;
    if (!observed.has(event.sender)) {
      observed.add(event.sender);
      event.sender.on('did-navigate', () => readiness.setReady(event.sender, false));
      event.sender.once('destroyed', () => readiness.setReady(event.sender, false));
    }
    readiness.setReady(event.sender, ready);
  });

  return async (input) => {
    if (input.selectedSourceObjectIds.length === 0) return [];
    try {
      assertUniqueRenderSourceObjectIds(input.selectedSourceObjectIds);
      const checks: MigrationRenderCheck[] = [];
      const receiptGroups = new Map<string, ProjectionReceipt[]>();
      for (const receipt of input.receipts) {
        const group = receiptGroups.get(receipt.sourceObjectId) ?? [];
        group.push(receipt);
        receiptGroups.set(receipt.sourceObjectId, group);
      }
      reportRenderProgress(input, 0);
      for (
        let offset = 0;
        offset < input.selectedSourceObjectIds.length;
        offset += BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS
      ) {
        const selectedSourceObjectIds = input.selectedSourceObjectIds.slice(
          offset,
          offset + BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS
        );
        const request = await buildRendererValidationRequest({
          ...input,
          selectedSourceObjectIds,
          receipts: selectedSourceObjectIds.flatMap(
            (sourceObjectId) => receiptGroups.get(sourceObjectId) ?? []
          ),
        });
        await readiness.wait(timeoutMs);
        const response = await requestRendererValidation(getMainWindow(), request, timeoutMs);
        checks.push(...validateCorrelatedResponse(request, response));
        reportRenderProgress(input, checks.length);
      }
      return checks;
    } catch (error) {
      const reason = rendererValidationFailureReason(error);
      return input.selectedSourceObjectIds.map((sourceObjectId) => ({
        sourceObjectId,
        passed: false,
        message: `Destination render validation failed closed: ${reason}`,
      }));
    }
  };
}

function rendererValidationFailureReason(error: unknown): string {
  if (isFilesystemError(error)) {
    return 'Projected content could not be opened safely.';
  }
  return error instanceof Error ? error.message : 'Unknown renderer validation error.';
}

function isFilesystemError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as NodeJS.ErrnoException;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.syscall === 'string' &&
    (typeof candidate.path === 'string' || candidate.code === 'ENOENT')
  );
}

export async function buildRendererValidationRequest(
  input: LocalBundleRenderValidationInput,
  requestId: string = randomUUID(),
  deps: Readonly<{
    assertContainedRegularFile?: typeof assertContainedRegularFile;
  }> = {}
): Promise<MigrationRenderValidationRequest> {
  if (input.selectedSourceObjectIds.length > BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS) {
    throw new Error(
      `Deterministic render sample exceeds ${BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS} items.`
    );
  }
  assertUniqueRenderSourceObjectIds(input.selectedSourceObjectIds);

  const receiptGroups = new Map<string, ProjectionReceipt[]>();
  for (const receipt of input.receipts) {
    const receipts = receiptGroups.get(receipt.sourceObjectId) ?? [];
    receipts.push(receipt);
    receiptGroups.set(receipt.sourceObjectId, receipts);
  }

  const checkedPaths = new Set<string>();
  const pathsToCheck: string[] = [];
  const items = [];
  const catalogReceipts = input.receipts.filter(
    (receipt) => receipt.destination?.kind === 'catalog-record'
  );
  const sourceById = new Map(input.sourceObjects.map((source) => [source.id, source]));
  const catalogPlan = catalogReceipts.length
    ? await buildNativeMigrationMaterializationPlan({
        run: input.run,
        sourceObjects: catalogReceipts.map((receipt) => {
          const source = sourceById.get(receipt.sourceObjectId);
          const payload = receipt.catalogPayload;
          if (!source || !payload || payload.sourceObjectId !== source.id) {
            throw new Error(
              `Render target ${receipt.sourceObjectId} has no exact catalog payload.`
            );
          }
          return {
            ...source,
            name: payload.name,
            metadata: payload.metadata,
            content: payload.content,
          };
        }),
        receipts: catalogReceipts,
        resolutions: [],
        folderProjection: null,
      })
    : null;
  const catalogRecords = new Map(
    catalogPlan?.limsEntities?.map((entity) => [entity.entityRawId, entity.input])
  );
  for (const sourceObjectId of input.selectedSourceObjectIds) {
    const matches = receiptGroups.get(sourceObjectId) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Render target ${sourceObjectId} has ${matches.length} projection receipts; exactly one is required.`
      );
    }
    const receipt = matches[0];
    if (receipt.runId !== input.run.id) {
      throw new Error(`Render target ${sourceObjectId} has a receipt from another run.`);
    }
    if (receipt.destination?.kind === 'catalog-record') {
      const catalogRecord = catalogRecords.get(receipt.destinationObjectId);
      if (!catalogRecord)
        throw new Error(`Render target ${sourceObjectId} has no native catalog record.`);
      items.push({
        sourceObjectId,
        destinationObjectId: receipt.destinationObjectId,
        projection: receipt.projection,
        converterId: receipt.converterId,
        surface: 'lims_registry',
        catalogRecord,
      });
      continue;
    }
    const renderDestinationPath = receiptRenderDestinationPath(receipt);
    if (!isSafeMigrationDestinationPath(renderDestinationPath)) {
      throw new Error(`Render target ${sourceObjectId} has an unsafe destination path.`);
    }
    if (!checkedPaths.has(renderDestinationPath)) {
      checkedPaths.add(renderDestinationPath);
      pathsToCheck.push(renderDestinationPath);
    }
    items.push({
      sourceObjectId,
      destinationObjectId: receipt.destinationObjectId,
      destinationPath: renderDestinationPath,
      projection: receipt.projection,
      converterId: receipt.converterId,
      surface: surfaceForReceipt(receipt),
    });
  }
  await runBoundedPathChecks(pathsToCheck, RENDER_REQUEST_PATH_CONCURRENCY, (path) =>
    (deps.assertContainedRegularFile ?? assertContainedRegularFile)(input.run.workspacePath, path)
  );

  return parseMigrationRenderValidationRequest({
    version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
    requestId,
    runId: input.run.id,
    workspaceId: input.run.projectionScopeId ?? input.run.workspaceId,
    workspaceRoot: resolve(input.run.workspacePath),
    items,
  });
}

function reportRenderProgress(input: LocalBundleRenderValidationInput, completed: number): void {
  try {
    input.onProgress?.({ completed, total: input.selectedSourceObjectIds.length });
  } catch {}
}

async function runBoundedPathChecks(
  paths: readonly string[],
  concurrency: number,
  check: (path: string) => Promise<void>
): Promise<void> {
  const errors: Array<unknown | undefined> = new Array(paths.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < paths.length) {
      const index = nextIndex++;
      try {
        await check(paths[index]);
      } catch (error) {
        errors[index] = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, () => worker()));
  const firstError = errors.find((error) => error !== undefined);
  if (firstError !== undefined) throw firstError;
}

function assertUniqueRenderSourceObjectIds(sourceObjectIds: readonly string[]): void {
  if (new Set(sourceObjectIds).size !== sourceObjectIds.length) {
    throw new Error('Deterministic render sample contains duplicate source object IDs.');
  }
}

async function requestRendererValidation(
  mainWindow: BrowserWindow | null,
  request: MigrationRenderValidationRequest,
  timeoutMs: number
): Promise<MigrationRenderValidationResponse> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error('The product renderer is unavailable.');
  }
  const expectedSender = mainWindow.webContents;
  const responseChannel = migrationRenderValidationResponseChannel(request.requestId);

  return new Promise<MigrationRenderValidationResponse>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      mainIpc.removeListener(responseChannel, listener);
    };
    const settle = (
      result:
        | { kind: 'success'; response: MigrationRenderValidationResponse }
        | { kind: 'error'; error: Error }
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result.kind === 'success') resolvePromise(result.response);
      else rejectPromise(result.error);
    };
    const listener = (event: IpcMainEvent, payload: unknown): void => {
      if (event.sender !== expectedSender) return;
      try {
        settle({ kind: 'success', response: parseMigrationRenderValidationResponse(payload) });
      } catch (error) {
        settle({
          kind: 'error',
          error:
            error instanceof Error
              ? error
              : new Error('The renderer returned malformed validation evidence.'),
        });
      }
    };

    timer = setTimeout(
      () => settle({ kind: 'error', error: new Error('The product renderer timed out.') }),
      timeoutMs
    );
    mainIpc.on(responseChannel, listener);
    try {
      sendRendererIpc(
        expectedSender,
        BENCHLING_MIGRATION_RENDER_VALIDATION_REQUEST_CHANNEL,
        request
      );
    } catch (error) {
      settle({
        kind: 'error',
        error:
          error instanceof Error
            ? error
            : new Error('The render-validation request could not be delivered.'),
      });
    }
  });
}

function validateCorrelatedResponse(
  request: MigrationRenderValidationRequest,
  response: MigrationRenderValidationResponse
): MigrationRenderCheck[] {
  if (response.requestId !== request.requestId || response.runId !== request.runId) {
    throw new Error('Renderer validation response correlation did not match the request.');
  }
  if (response.checks.length !== request.items.length) {
    throw new Error(
      `Renderer returned ${response.checks.length} checks for ${request.items.length} requested sources.`
    );
  }
  const requestBySourceId = new Map(request.items.map((item) => [item.sourceObjectId, item]));
  const responseBySourceId = new Map(response.checks.map((check) => [check.sourceObjectId, check]));
  if (responseBySourceId.size !== response.checks.length) {
    throw new Error('Renderer validation response contains duplicate source object IDs.');
  }
  for (const check of response.checks) {
    const requested = requestBySourceId.get(check.sourceObjectId);
    if (!requested) {
      throw new Error(
        `Renderer validation response contains extra source ${check.sourceObjectId}.`
      );
    }
    if (check.surface !== requested.surface) {
      throw new Error(`Renderer validation surface changed for ${check.sourceObjectId}.`);
    }
  }
  for (const item of request.items) {
    if (!responseBySourceId.has(item.sourceObjectId)) {
      throw new Error(`Renderer validation response is missing source ${item.sourceObjectId}.`);
    }
  }
  return request.items.map((item) => {
    const check = responseBySourceId.get(item.sourceObjectId) as NonNullable<
      ReturnType<typeof responseBySourceId.get>
    >;
    return {
      sourceObjectId: check.sourceObjectId,
      passed: check.passed,
      ...(check.message ? { message: check.message } : {}),
    };
  });
}

function surfaceForReceipt(receipt: ProjectionReceipt): MigrationRenderSurface {
  if (receipt.destination?.kind === 'catalog-record') return 'lims_registry';
  if (receipt.converterId === BENCHLING_REGISTRY_CONVERTER_ID) return 'lims_registry';
  if (receipt.projection === 'artifact' || receipt.projection === 'fallback') return 'artifact';
  const lower = receipt.destinationPath.toLowerCase();
  if (lower.endsWith('.wpnote.json') || lower.endsWith('/.forge/notebook.json')) return 'notebook';
  if (lower.endsWith('.faa')) return 'protein';
  if (
    lower.endsWith('.dnaforge-protocol.json') ||
    lower.endsWith('.dnaforge-protocol-run.json') ||
    lower.endsWith('/.forge/protocol.json') ||
    lower.endsWith('/.forge/protocol-run.json') ||
    lower.endsWith('.dnaforge-collection.json')
  ) {
    return 'scientific_document';
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (
    lower.endsWith('.gb') ||
    lower.endsWith('.gbk') ||
    lower.endsWith('.genbank') ||
    lower.endsWith('.fasta') ||
    lower.endsWith('.fa') ||
    lower.endsWith('.fna') ||
    lower.endsWith('.dna') ||
    lower.endsWith('.ab1')
  ) {
    return 'sequence';
  }
  return 'text';
}

function receiptRenderDestinationPath(receipt: ProjectionReceipt): string {
  switch (receipt.destination?.kind) {
    case 'file':
      return receipt.destination.relativePath;
    case 'package':
      return receipt.destination.primaryRelativePath;
    case 'catalog-record':
      throw new Error('Catalog render targets do not have file paths.');
    default:
      return receipt.destinationPath;
  }
}

async function assertContainedRegularFile(
  workspacePathInput: string,
  relativePath: string
): Promise<void> {
  const workspacePath = resolve(workspacePathInput);
  if (!isAbsolute(workspacePath)) throw new Error('Migration workspace path must be absolute.');
  const workspaceStats = await lstat(workspacePath);
  if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
    throw new Error('Migration workspace must be a regular directory.');
  }

  let current = workspacePath;
  const segments = relativePath.replace(/\\/g, '/').split('/');
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    if (current !== workspacePath && !current.startsWith(`${workspacePath}${sep}`)) {
      throw new Error('Projection path escaped the bound staging workspace.');
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error('Projection path contains a symbolic link.');
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error('Projection path contains a non-directory segment.');
    }
    if (index === segments.length - 1 && (!stats.isFile() || stats.size === 0)) {
      throw new Error('Projected content is not a non-empty regular file.');
    }
  }
}

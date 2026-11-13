import { createHash } from 'node:crypto';
import type {
  GmailReceiptFilterSummary,
  ProviderActivityBundle,
  ProviderActivityObservation,
  ProviderActivityOperationKind,
  ProviderCommandJournalEntry,
  ProviderTaskGmailRescanAuthorization,
  ScopedFolderCommandCorrelation,
} from '../../shared/benchling-migration';

export const PROVIDER_ACTIVITY_BUNDLE_SCHEMA =
  'dnaforge.benchling.provider-activity-bundle.v1' as const;
export const SCOPED_FOLDER_PROVIDER_PRE_DISPATCH_MISS_REASON =
  'provider_pre_dispatch_blocked' as const;
export const MAX_PROVIDER_ACTIVITY_OBSERVATIONS = 16;
const GMAIL_RECEIPT_FILTER_SUMMARY_SCHEMA =
  'dnaforge.benchling.gmail-receipt-filter-summary.v1' as const;
const MAX_GMAIL_RECEIPT_FILTER_COUNT = 32;
const GMAIL_RECEIPT_FILTER_STAGES = ['sender', 'date', 'family', 'time', 'excluded'] as const;

export type BridgeProviderActivityBundle = {
  schema: typeof PROVIDER_ACTIVITY_BUNDLE_SCHEMA;
  complete: boolean;
  observations: ProviderActivityObservation[];
};

const NETWORK_CLASSES = new Set([
  'export_submit',
  'export_task_status',
  'gmail_receipt_page',
  'export_archive_metadata',
  'export_archive_range',
  'export_archive_download',
  'folder_scope_discovery',
  'targeted_read',
]);
const OPERATION_CLASSES: Record<ProviderActivityOperationKind, ReadonlySet<string>> = {
  submit_export: new Set(['export_submit']),
  reconcile_export_submission: new Set(['export_submit']),
  poll_export_receipts: new Set(['export_task_status', 'gmail_receipt_page']),
  recover_export_receipt: new Set(['gmail_receipt_page']),
  inspect_export: new Set(['export_task_status', 'export_archive_metadata']),
  inspect_export_range: new Set(['export_task_status', 'export_archive_range']),
  discover_failed_export_split: new Set(),
  discover_scoped_folder_page: new Set(['folder_scope_discovery']),
  download_export: new Set(['export_task_status', 'export_archive_download']),
  targeted_read: new Set(['targeted_read']),
};
const NETWORK_BACKED_OPERATIONS = new Set<ProviderActivityOperationKind>([
  'submit_export',
  'reconcile_export_submission',
  'poll_export_receipts',
  'recover_export_receipt',
  'inspect_export',
  'inspect_export_range',
  'discover_scoped_folder_page',
  'download_export',
  'targeted_read',
]);

export function emptyBridgeProviderActivityBundle(complete: boolean): BridgeProviderActivityBundle {
  return {
    schema: PROVIDER_ACTIVITY_BUNDLE_SCHEMA,
    complete,
    observations: [],
  };
}

export function durableProviderCommandEntry(input: {
  runId: string;
  commandRequestId: string;
  operationKind: ProviderActivityOperationKind;
  exportJobId?: string;
  nativeExportLedgerEpoch?: string;
  reconcilesCommandRequestId?: string;
  explicitResumeAttempt?: number;
  interventionSha256?: string;
  scopedFolderCorrelation?: ScopedFolderCommandCorrelation;
  directFolderGmailRescan?: Extract<ProviderTaskGmailRescanAuthorization, { scopeKind: 'folder' }>;
  issuedAt: string;
}): ProviderCommandJournalEntry {
  assertOpaqueEvidenceId(input.runId, 'provider command run ID');
  assertOpaqueEvidenceId(input.commandRequestId, 'provider command request ID');
  if (input.exportJobId !== undefined) {
    assertOpaqueEvidenceId(input.exportJobId, 'provider command export job ID');
    if (
      input.operationKind !== 'submit_export' &&
      input.operationKind !== 'reconcile_export_submission' &&
      input.operationKind !== 'download_export'
    ) {
      throw new Error('Only export submission and download commands may reference an export job.');
    }
  }
  if (input.operationKind === 'reconcile_export_submission') {
    if (
      input.exportJobId === undefined ||
      !/^native-ledger-epoch:[a-f0-9]{32}$/u.test(String(input.nativeExportLedgerEpoch)) ||
      input.reconcilesCommandRequestId === undefined ||
      !Number.isSafeInteger(input.explicitResumeAttempt) ||
      Number(input.explicitResumeAttempt) < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(input.interventionSha256))
    ) {
      throw new Error('Native export reconciliation requires exact durable correlation.');
    }
    assertOpaqueEvidenceId(
      input.reconcilesCommandRequestId,
      'native export original command request ID'
    );
  } else if (
    input.reconcilesCommandRequestId !== undefined ||
    input.explicitResumeAttempt !== undefined ||
    input.interventionSha256 !== undefined
  ) {
    throw new Error('Only native export reconciliation may carry resume correlation.');
  }
  if (
    input.nativeExportLedgerEpoch !== undefined &&
    (!/^native-ledger-epoch:[a-f0-9]{32}$/u.test(input.nativeExportLedgerEpoch) ||
      (input.operationKind !== 'submit_export' &&
        input.operationKind !== 'reconcile_export_submission' &&
        input.operationKind !== 'download_export'))
  ) {
    throw new Error('Only native export submission and download commands may carry continuity.');
  }
  if (
    input.operationKind === 'download_export' &&
    (input.exportJobId === undefined || input.nativeExportLedgerEpoch === undefined)
  ) {
    throw new Error('Protected-download commands require exact durable correlation.');
  }
  if (input.operationKind === 'discover_scoped_folder_page') {
    if (input.scopedFolderCorrelation === undefined || input.exportJobId !== undefined) {
      throw new Error('Scoped Folder commands require exact scoped correlation only.');
    }
  } else if (input.scopedFolderCorrelation !== undefined) {
    throw new Error('Only scoped Folder commands may carry scoped correlation.');
  }
  if (input.directFolderGmailRescan !== undefined) {
    if (
      input.operationKind !== 'poll_export_receipts' ||
      (input.directFolderGmailRescan.schema !==
        'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v1' &&
        input.directFolderGmailRescan.schema !==
          'dnaforge.benchling.provider-task-direct-folder-gmail-rescan.v2' &&
        input.directFolderGmailRescan.schema !==
          'dnaforge.benchling.provider-task-direct-folder-sequence-gmail-recovery.v1' &&
        input.directFolderGmailRescan.schema !==
          'dnaforge.benchling.provider-task-direct-folder-succeeded-gmail-recovery.v1') ||
      input.directFolderGmailRescan.scopeKind !== 'folder' ||
      input.directFolderGmailRescan.runId !== input.runId
    ) {
      throw new Error('Direct Folder Gmail rescan commands require exact durable correlation.');
    }
  }
  if (!Number.isFinite(Date.parse(input.issuedAt))) {
    throw new Error('Provider command issue timestamp is invalid.');
  }
  return {
    id: digestEvidenceId('provider-command', providerCommandIdentity(input)),
    ...input,
  };
}

function providerCommandIdentity(input: {
  runId: string;
  commandRequestId: string;
  operationKind: ProviderActivityOperationKind;
  exportJobId?: string;
  nativeExportLedgerEpoch?: string;
  reconcilesCommandRequestId?: string;
  explicitResumeAttempt?: number;
  interventionSha256?: string;
  scopedFolderCorrelation?: ScopedFolderCommandCorrelation;
  directFolderGmailRescan?: Extract<ProviderTaskGmailRescanAuthorization, { scopeKind: 'folder' }>;
}): string {
  const base = `${input.runId}\0${input.commandRequestId}\0${input.operationKind}`;
  if (input.exportJobId !== undefined) return `${base}\0${input.exportJobId}`;
  return base;
}

export function durableProviderActivityBundle(input: {
  runId: string;
  commandRequestId: string;
  operationKind: ProviderActivityOperationKind;
  observedAt: string;
  activity: BridgeProviderActivityBundle;
}): ProviderActivityBundle {
  assertOpaqueEvidenceId(input.runId, 'provider activity run ID');
  assertOpaqueEvidenceId(input.commandRequestId, 'provider activity command request ID');
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error('Provider activity timestamp is invalid.');
  }
  const activity = validateBridgeProviderActivityBundle(input.activity, input.operationKind);
  const body = {
    runId: input.runId,
    commandRequestId: input.commandRequestId,
    operationKind: input.operationKind,
    observedAt: input.observedAt,
    ...activity,
  };
  return {
    id: digestEvidenceId('provider-activity', JSON.stringify(body)),
    ...body,
  };
}

export function validateBridgeProviderActivityBundle(
  input: unknown,
  operationKind: ProviderActivityOperationKind
): BridgeProviderActivityBundle {
  const bundle = record(input, 'provider activity bundle');
  exactKeys(bundle, ['schema', 'complete', 'observations'], 'provider activity bundle');
  if (bundle.schema !== PROVIDER_ACTIVITY_BUNDLE_SCHEMA || typeof bundle.complete !== 'boolean') {
    throw new Error('Provider activity bundle header is invalid.');
  }
  if (
    !Array.isArray(bundle.observations) ||
    bundle.observations.length > MAX_PROVIDER_ACTIVITY_OBSERVATIONS
  ) {
    throw new Error('Provider activity observation list is invalid or too large.');
  }
  if (
    bundle.complete === true &&
    bundle.observations.length === 0 &&
    NETWORK_BACKED_OPERATIONS.has(operationKind)
  ) {
    throw new Error(
      'Complete provider activity for a network-backed operation requires an observation.'
    );
  }
  const observations = bundle.observations.map((value, ordinal) =>
    validateObservation(value, ordinal, operationKind)
  );
  return {
    schema: PROVIDER_ACTIVITY_BUNDLE_SCHEMA,
    complete: bundle.complete,
    observations,
  };
}

export function assertExactScopedFolderSuccessActivity(bundle: BridgeProviderActivityBundle): void {
  const observation = bundle.observations[0];
  if (
    bundle.complete !== true ||
    bundle.observations.length !== 1 ||
    observation?.ordinal !== 0 ||
    observation.kind !== 'network_request' ||
    observation.requestClass !== 'folder_scope_discovery' ||
    observation.providerSurface !== 'benchling_tenant' ||
    observation.method !== 'POST' ||
    observation.result !== 'response' ||
    observation.statusClass !== '2xx'
  ) {
    throw new Error(
      'Successful scoped Folder discovery requires one complete Benchling tenant POST 2xx observation.'
    );
  }
}

export function assertExactScopedFolderPreDispatchActivity(
  bundle: BridgeProviderActivityBundle
): void {
  const observation = bundle.observations[0];
  if (
    bundle.complete !== true ||
    bundle.observations.length !== 1 ||
    observation?.ordinal !== 0 ||
    observation.kind !== 'local_miss' ||
    observation.requestClass !== 'folder_scope_discovery' ||
    observation.providerSurface !== 'benchling_tenant' ||
    observation.method !== 'POST' ||
    observation.reason !== SCOPED_FOLDER_PROVIDER_PRE_DISPATCH_MISS_REASON
  ) {
    throw new Error(
      'Scoped Folder provider pre-dispatch failure requires one complete provider-free local-miss observation.'
    );
  }
}

function validateObservation(
  input: unknown,
  ordinal: number,
  operationKind: ProviderActivityOperationKind
): ProviderActivityObservation {
  const observation = record(input, 'provider activity observation');
  if (observation.ordinal !== ordinal || !Number.isSafeInteger(observation.ordinal)) {
    throw new Error('Provider activity ordinals must be contiguous and zero-based.');
  }
  if (
    typeof observation.requestClass !== 'string' ||
    !NETWORK_CLASSES.has(observation.requestClass) ||
    !OPERATION_CLASSES[operationKind].has(observation.requestClass)
  ) {
    throw new Error('Provider activity request class is not allowed for this operation.');
  }
  if (
    observation.providerSurface !== 'benchling_tenant' &&
    observation.providerSurface !== 'benchling_temp_storage' &&
    observation.providerSurface !== 'gmail_web'
  ) {
    throw new Error('Provider activity surface is invalid.');
  }
  if (!['GET', 'HEAD', 'POST', 'READ'].includes(String(observation.method))) {
    throw new Error('Provider activity method is invalid.');
  }
  validateClassSurfaceAndMethod(observation, operationKind);

  if (observation.kind === 'network_request') {
    exactKeys(
      observation,
      ['ordinal', 'kind', 'requestClass', 'providerSurface', 'method', 'result', 'statusClass'],
      'provider network request observation'
    );
    if (observation.result === 'response') {
      if (!['2xx', '3xx', '4xx', '5xx'].includes(String(observation.statusClass))) {
        throw new Error('Provider response observation has an invalid status class.');
      }
    } else if (observation.result === 'transport_error') {
      if (observation.statusClass !== null) {
        throw new Error('Provider transport failure cannot claim an HTTP status.');
      }
    } else {
      throw new Error('Provider request result is invalid.');
    }
  } else if (observation.kind === 'cache_hit') {
    const hasFilterSummary = observation.filterSummary !== undefined;
    exactKeys(
      observation,
      [
        'ordinal',
        'kind',
        'requestClass',
        'providerSurface',
        'method',
        'cacheLayer',
        ...(hasFilterSummary ? ['filterSummary'] : []),
      ],
      'provider cache observation'
    );
    if (
      !['extension_memory', 'extension_session', 'main_process_memory', 'browser_page'].includes(
        String(observation.cacheLayer)
      )
    ) {
      throw new Error('Provider cache layer is invalid.');
    }
    if (
      observation.cacheLayer === 'main_process_memory' &&
      observation.requestClass !== 'targeted_read'
    ) {
      throw new Error('Main-process provider cache is restricted to targeted reads.');
    }
    if (
      observation.cacheLayer === 'browser_page' &&
      observation.requestClass !== 'gmail_receipt_page'
    ) {
      throw new Error('Browser-page evidence is restricted to Gmail receipt reads.');
    }
    if (
      hasFilterSummary &&
      (observation.requestClass !== 'gmail_receipt_page' ||
        observation.providerSurface !== 'gmail_web' ||
        observation.method !== 'READ' ||
        observation.cacheLayer !== 'browser_page')
    ) {
      throw new Error('Gmail receipt filter summaries require one browser-page Gmail read.');
    }
    if (hasFilterSummary) {
      observation.filterSummary = validateGmailReceiptFilterSummary(observation.filterSummary);
    }
  } else if (observation.kind === 'local_miss') {
    exactKeys(
      observation,
      ['ordinal', 'kind', 'requestClass', 'providerSurface', 'method', 'reason'],
      'provider local-miss observation'
    );
    const exactReceiptMiss =
      observation.reason === 'receipt_not_open' &&
      observation.requestClass === 'gmail_receipt_page' &&
      observation.providerSurface === 'gmail_web' &&
      observation.method === 'READ' &&
      ['poll_export_receipts', 'recover_export_receipt'].includes(operationKind);
    const exactScopedFolderAuthorityMiss =
      observation.reason === 'traversal_authority_missing' &&
      observation.requestClass === 'folder_scope_discovery' &&
      observation.providerSurface === 'benchling_tenant' &&
      observation.method === 'POST' &&
      operationKind === 'discover_scoped_folder_page';
    const exactScopedFolderPreDispatchMiss =
      observation.reason === SCOPED_FOLDER_PROVIDER_PRE_DISPATCH_MISS_REASON &&
      observation.requestClass === 'folder_scope_discovery' &&
      observation.providerSurface === 'benchling_tenant' &&
      observation.method === 'POST' &&
      operationKind === 'discover_scoped_folder_page';
    if (!exactReceiptMiss && !exactScopedFolderAuthorityMiss && !exactScopedFolderPreDispatchMiss) {
      throw new Error('Provider local-miss reason is invalid.');
    }
  } else {
    throw new Error('Provider activity kind is invalid.');
  }
  return structuredClone(observation) as ProviderActivityObservation;
}

function validateClassSurfaceAndMethod(
  observation: Record<string, unknown>,
  operationKind: ProviderActivityOperationKind
): void {
  const requestClass = observation.requestClass;
  const surface = observation.providerSurface;
  const method = observation.method;
  if (requestClass === 'gmail_receipt_page') {
    const exactRecoveryLocalMiss =
      observation.kind === 'local_miss' &&
      ['poll_export_receipts', 'recover_export_receipt'].includes(operationKind) &&
      surface === 'gmail_web' &&
      method === 'READ' &&
      observation.reason === 'receipt_not_open';
    const exactReceiptCache =
      observation.kind === 'cache_hit' &&
      surface === 'gmail_web' &&
      method === 'READ' &&
      (observation.cacheLayer === 'browser_page' ||
        (operationKind === 'recover_export_receipt' &&
          observation.cacheLayer === 'extension_memory'));
    if (!exactReceiptCache && !exactRecoveryLocalMiss) {
      throw new Error(
        'Gmail receipt evidence must describe an existing browser-page read or exact recovery cache hit or typed local miss.'
      );
    }
    return;
  }
  if (requestClass === 'folder_scope_discovery' && observation.kind === 'local_miss') {
    if (
      operationKind !== 'discover_scoped_folder_page' ||
      surface !== 'benchling_tenant' ||
      method !== 'POST' ||
      (observation.reason !== 'traversal_authority_missing' &&
        observation.reason !== SCOPED_FOLDER_PROVIDER_PRE_DISPATCH_MISS_REASON)
    ) {
      throw new Error(
        'Scoped Folder local-miss evidence must describe only missing traversal authority or a fixed provider pre-dispatch block.'
      );
    }
    return;
  }
  if (surface === 'gmail_web' || method === 'READ' || observation.cacheLayer === 'browser_page') {
    throw new Error('Only Gmail receipt reads may use browser-page evidence fields.');
  }
  if (
    ['export_submit', 'export_task_status', 'folder_scope_discovery', 'targeted_read'].includes(
      String(requestClass)
    ) &&
    surface !== 'benchling_tenant'
  ) {
    throw new Error('Tenant provider request was assigned to the wrong surface.');
  }
  if (requestClass === 'export_submit' && method !== 'POST') {
    throw new Error('Export submission evidence must use POST.');
  }
  if (requestClass === 'folder_scope_discovery' && method !== 'POST') {
    throw new Error('Scoped Folder discovery evidence must use POST.');
  }
  if (['export_task_status', 'targeted_read'].includes(String(requestClass)) && method !== 'GET') {
    throw new Error('Provider read evidence must use GET.');
  }
  if (requestClass === 'export_archive_metadata') {
    const valid =
      (surface === 'benchling_tenant' && method === 'HEAD') ||
      (surface === 'benchling_tenant' && method === 'GET') ||
      (surface === 'benchling_temp_storage' && method === 'HEAD') ||
      (surface === 'benchling_temp_storage' && method === 'GET');
    if (!valid) throw new Error('Archive metadata evidence uses an invalid surface or method.');
  }
  if (
    ['export_archive_range', 'export_archive_download'].includes(String(requestClass)) &&
    method !== 'GET'
  ) {
    throw new Error('Archive transfer evidence must use GET.');
  }
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains non-allowlisted fields.`);
  }
}

function validateGmailReceiptFilterSummary(input: unknown): GmailReceiptFilterSummary {
  const summary = record(input, 'Gmail receipt filter summary');
  exactKeys(summary, ['schema', 'rejected', 'countsAreExact'], 'Gmail receipt filter summary');
  if (
    summary.schema !== GMAIL_RECEIPT_FILTER_SUMMARY_SCHEMA ||
    typeof summary.countsAreExact !== 'boolean'
  ) {
    throw new Error('Gmail receipt filter summary metadata is invalid.');
  }
  const rejected = record(summary.rejected, 'Gmail receipt filter rejection counts');
  exactKeys(rejected, [...GMAIL_RECEIPT_FILTER_STAGES], 'Gmail receipt filter rejection counts');
  const sanitized = {} as GmailReceiptFilterSummary['rejected'];
  for (const stage of GMAIL_RECEIPT_FILTER_STAGES) {
    const count = rejected[stage];
    if (
      !Number.isSafeInteger(count) ||
      Number(count) < 0 ||
      Number(count) > MAX_GMAIL_RECEIPT_FILTER_COUNT
    ) {
      throw new Error('Gmail receipt filter rejection count is invalid.');
    }
    sanitized[stage] = Number(count);
  }
  if (Object.values(sanitized).every((count) => count === 0)) {
    throw new Error('Gmail receipt filter summaries require at least one rejection.');
  }
  if (
    summary.countsAreExact === false &&
    Object.values(sanitized).every((count) => count !== MAX_GMAIL_RECEIPT_FILTER_COUNT)
  ) {
    throw new Error('Capped Gmail receipt filter summaries require one saturated count.');
  }
  return {
    schema: GMAIL_RECEIPT_FILTER_SUMMARY_SCHEMA,
    rejected: sanitized,
    countsAreExact: summary.countsAreExact,
  };
}

function digestEvidenceId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

function assertOpaqueEvidenceId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

import type { LimsImportColumnMappingOverride, LimsImportPlan } from '../lims';
import { NativeDocumentCommandError } from '../native-document-error';

import type {
  ImportReviewCommand,
  ImportReviewDocument,
  ImportReviewInspection,
  ImportReviewReceipt,
  ImportReviewSource,
} from '../import-review';
export type {
  ImportReviewCommand,
  ImportReviewDocument,
  ImportReviewInspection,
  ImportReviewReceipt,
} from '../import-review';

export interface ImportReviewDependencies<Context = undefined> {
  newId(): string;
  read(id: string): Promise<ImportReviewDocument | null>;
  write(document: ImportReviewDocument): Promise<void>;
  assertAuthority(workspaceRoot: string, mutating: boolean): Promise<void>;
  validateDestination?(workspaceRoot: string, destinationDir: string): Promise<void>;
  fingerprint(source: ImportReviewSource): Promise<string>;
  build(source: ImportReviewSource): Promise<LimsImportPlan>;
  map(plan: LimsImportPlan, mappings: LimsImportColumnMappingOverride[]): Promise<LimsImportPlan>;
  accept(plan: LimsImportPlan, ids: string[], accepted: boolean): LimsImportPlan;
  resolveLink(
    plan: LimsImportPlan,
    command: Extract<ImportReviewCommand, { kind: 'resolve-link' }>
  ): Promise<LimsImportPlan>;
  resolveDuplicate?(
    plan: LimsImportPlan,
    command: Extract<ImportReviewCommand, { kind: 'resolve-duplicate' }>
  ): Promise<LimsImportPlan>;
  apply(document: ImportReviewDocument, context?: Context): Promise<ImportReviewReceipt>;
  preflightApply?(document: ImportReviewDocument, context?: Context): Promise<void>;
  failureReceipt?(error: unknown): ImportReviewReceipt | undefined;
}

export class ImportReviewOwner<Context = undefined> {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly dependencies: ImportReviewDependencies<Context>) {}

  async prepare(input: {
    workspaceRoot: string;
    destinationDir: string;
    source: ImportReviewSource;
  }): Promise<ImportReviewInspection> {
    input = structuredClone(input);
    await this.dependencies.assertAuthority(input.workspaceRoot, true);
    await this.dependencies.validateDestination?.(input.workspaceRoot, input.destinationDir);
    const sourceFingerprint = await this.dependencies.fingerprint(input.source);
    const plan = await this.dependencies.build(input.source);
    await this.dependencies.assertAuthority(input.workspaceRoot, true);
    if ((await this.dependencies.fingerprint(input.source)) !== sourceFingerprint)
      throw new Error('IMPORT_SOURCE_CHANGED: The source changed while preparing the review.');
    const document: ImportReviewDocument = {
      ...structuredClone(input),
      id: this.dependencies.newId(),
      revision: this.dependencies.newId(),
      sourceFingerprint,
      plan,
      phase: 'review',
    };
    await this.dependencies.write(document);
    return inspect(document);
  }

  async snapshot(id: string): Promise<ImportReviewDocument> {
    const document = await this.dependencies.read(id);
    if (!document) throw new Error('IMPORT_REVIEW_NOT_FOUND: This review is unavailable.');
    await this.dependencies.assertAuthority(document.workspaceRoot, false);
    return structuredClone(document);
  }

  async execute(
    input: {
      id: string;
      expectedRevision?: string;
      command: ImportReviewCommand;
    },
    context?: Context
  ): Promise<ImportReviewInspection> {
    const previous = this.pending.get(input.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.run(input, context));
    this.pending.set(input.id, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(input.id) === operation) this.pending.delete(input.id);
    }
  }

  private async run(
    input: {
      id: string;
      expectedRevision?: string;
      command: ImportReviewCommand;
    },
    context?: Context
  ): Promise<ImportReviewInspection> {
    const stored = await this.dependencies.read(input.id);
    if (!stored) throw new Error('IMPORT_REVIEW_NOT_FOUND: This review is unavailable.');
    const document = structuredClone(stored);
    const { command } = input;
    await this.dependencies.assertAuthority(document.workspaceRoot, command.kind !== 'inspect');
    if (command.kind === 'inspect') return inspect(document, command);
    if (command.kind === 'apply' && document.requestId === command.requestId) {
      if (document.phase === 'applied' || document.phase === 'partial') return inspect(document);
      throw new Error('IMPORT_OUTCOME_UNRESOLVED: Inspect the retained attempt before continuing.');
    }
    if (document.revision !== input.expectedRevision)
      throw new Error('STALE_IMPORT_REVIEW: Inspect the current review before changing it.');
    if (document.phase !== 'review')
      throw new Error('IMPORT_REVIEW_SETTLED: This review cannot be changed or applied again.');
    if (command.kind === 'cancel') {
      document.phase = 'cancelled';
    } else if (command.kind === 'set-records-accepted') {
      const ids = new Set(document.plan.records.map((record) => record.id));
      if (command.recordIds.some((id) => !ids.has(id)))
        throw new Error('IMPORT_RECORD_NOT_FOUND: Choose exact records from this review.');
      document.plan = this.dependencies.accept(document.plan, command.recordIds, command.accepted);
    } else if (command.kind === 'set-mappings') {
      document.plan = await this.dependencies.map(document.plan, command.mappings);
    } else if (command.kind === 'set-destination') {
      await this.dependencies.assertAuthority(command.workspaceRoot, true);
      await this.dependencies.validateDestination?.(command.workspaceRoot, command.destinationDir);
      document.workspaceRoot = command.workspaceRoot;
      document.destinationDir = command.destinationDir;
    } else if (command.kind === 'set-source-options') {
      if ((await this.dependencies.fingerprint(document.source)) !== document.sourceFingerprint)
        throw new NativeDocumentCommandError(
          'IMPORT_SOURCE_CHANGED',
          'Prepare a new review for the changed source.',
          false
        );
      const { kind, ...options } = command;
      void kind;
      document.source = { ...document.source, ...options };
      document.plan = await this.dependencies.build(document.source);
    } else if (command.kind === 'resolve-duplicate') {
      if (!this.dependencies.resolveDuplicate)
        throw new Error('IMPORT_REVIEW_UNAVAILABLE: Duplicate decisions are unavailable.');
      document.plan = await this.dependencies.resolveDuplicate(document.plan, command);
    } else if (command.kind === 'resolve-link') {
      document.plan = await this.dependencies.resolveLink(document.plan, command);
    } else {
      if (!command.requestId?.trim())
        throw new Error('IMPORT_REQUEST_ID_REQUIRED: Supply a stable apply request ID.');
      if (!document.workspaceRoot || !document.destinationDir)
        throw new Error(
          'IMPORT_DESTINATION_REQUIRED: Choose an admitted destination before applying.'
        );
      if (!document.plan.canApply)
        throw new Error('IMPORT_REVIEW_REQUIRED: Resolve the accepted records before applying.');
      if ((await this.dependencies.fingerprint(document.source)) !== document.sourceFingerprint)
        throw new NativeDocumentCommandError(
          'IMPORT_SOURCE_CHANGED',
          'Prepare a new review for the changed source.',
          false
        );
      await this.dependencies.assertAuthority(document.workspaceRoot, true);
      await this.dependencies.validateDestination?.(
        document.workspaceRoot,
        document.destinationDir
      );
      await this.dependencies.preflightApply?.(structuredClone(document), context);
      document.phase = 'applying';
      document.requestId = command.requestId;
      document.revision = this.dependencies.newId();
      await this.dependencies.write(document);
      try {
        document.receipt = await this.dependencies.apply(structuredClone(document), context);
        document.phase = document.receipt.failed > 0 ? 'partial' : 'applied';
      } catch (error) {
        document.phase = 'failed';
        document.receipt = this.dependencies.failureReceipt?.(error);
        document.error = error instanceof Error ? error.message : String(error);
        document.revision = this.dependencies.newId();
        await this.dependencies.write(document);
        throw error;
      }
    }
    if (command.kind !== 'apply')
      await this.dependencies.assertAuthority(document.workspaceRoot, true);
    document.revision = this.dependencies.newId();
    await this.dependencies.write(document);
    return inspect(document);
  }
}

function inspect(
  document: ImportReviewDocument,
  page: { offset?: number; limit?: number } = {}
): ImportReviewInspection {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 25;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error(
      'INVALID_IMPORT_REVIEW_PAGE: Use a nonnegative offset and a limit of 1 to 100.'
    );
  const { plan } = document;
  return structuredClone({
    id: document.id,
    revision: document.revision,
    workspaceRoot: document.workspaceRoot,
    destinationDir: document.destinationDir,
    phase: document.phase,
    sourceName: plan.sourceName,
    sourceFingerprint: document.sourceFingerprint,
    schemaRevisionId: plan.schemaRevisionId,
    selectedSheet: plan.selectedSheet,
    sheetDispositions: plan.sheetDispositions,
    sourceKind: plan.sourceKind,
    columns: plan.columns,
    totalRecords: plan.records.length,
    records: plan.records.slice(offset, offset + limit),
    nextOffset: offset + limit < plan.records.length ? offset + limit : null,
    canApply:
      document.phase === 'review' &&
      plan.canApply &&
      !!document.workspaceRoot &&
      !!document.destinationDir,
    ...(document.receipt
      ? {
          receipt: {
            ...document.receipt,
            artifactPaths: document.receipt.artifactPaths.slice(0, 100),
            members: undefined,
          },
        }
      : {}),
    ...(document.error ? { error: document.error } : {}),
  });
}

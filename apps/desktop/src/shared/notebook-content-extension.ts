export type NotebookContentExtensionErrorCode =
  | 'NOTEBOOK_CONTENT_EXTENSION_INVALID'
  | 'NOTEBOOK_CONTENT_DATA_INVALID'
  | 'NOTEBOOK_CONTENT_MIGRATION_FAILED';

export class NotebookContentExtensionError extends Error {
  constructor(
    readonly code: NotebookContentExtensionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'NotebookContentExtensionError';
  }
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type NotebookContentDataParseResult =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

export interface NotebookRichBlockMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (data: Readonly<Record<string, unknown>>) => unknown;
}

export interface NotebookRichBlockMarkdownInput {
  readonly refId: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface NotebookMarkdownAstNode {
  readonly type?: string;
  readonly value?: string;
  readonly url?: string;
  readonly alt?: string;
  readonly title?: string | null;
  readonly align?: ReadonlyArray<'left' | 'right' | 'center' | null>;
  readonly children?: readonly NotebookMarkdownAstNode[];
}

export interface NotebookRichBlockFromMarkdownInput {
  readonly refId: string;
  readonly node: NotebookMarkdownAstNode;
}

export interface NotebookRichBlockFromMarkdownResult {
  readonly refId: string;
  readonly data: Record<string, unknown>;
}

export interface NotebookRichBlockContract {
  readonly kind: 'rich-block';
  readonly type: string;
  readonly currentVersion: number;
  readonly migrations: readonly NotebookRichBlockMigration[];
  readonly markdownNodeTypes?: readonly string[];
  readonly parseData: (value: unknown) => NotebookContentDataParseResult;
  readonly toMarkdown: (input: NotebookRichBlockMarkdownInput) => string;
  readonly fromMarkdown?: (
    input: NotebookRichBlockFromMarkdownInput
  ) => NotebookRichBlockFromMarkdownResult | null;
}

export interface NotebookMarkdownMarkContract {
  readonly kind: 'mark';
  readonly type: string;
  readonly toMarkdown: (input: {
    readonly text: string;
    readonly attrs: Readonly<Record<string, unknown>>;
  }) => string;
}

export type NotebookContentExtension = NotebookRichBlockContract | NotebookMarkdownMarkContract;

export type ResolvedNotebookRichBlock =
  | {
      readonly kind: 'supported';
      readonly contract: NotebookRichBlockContract;
      readonly data: Record<string, unknown>;
      readonly sourceVersion: number;
      readonly version: number;
    }
  | {
      readonly kind: 'unknown';
      readonly type: string;
      readonly version: number;
      readonly data: Record<string, unknown>;
    }
  | {
      readonly kind: 'future';
      readonly type: string;
      readonly version: number;
      readonly supportedVersion: number;
      readonly data: Record<string, unknown>;
    };

function validRichBlockType(type: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(type);
}

function validSyntaxType(type: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(type);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new NotebookContentExtensionError(
      'NOTEBOOK_CONTENT_EXTENSION_INVALID',
      `${label} must be a positive safe integer`
    );
  }
  return value;
}

function validateRichBlockContract(contract: NotebookRichBlockContract): void {
  if (!validRichBlockType(contract.type)) {
    throw new NotebookContentExtensionError(
      'NOTEBOOK_CONTENT_EXTENSION_INVALID',
      `Invalid rich-block type: ${contract.type}`
    );
  }
  const currentVersion = positiveInteger(
    contract.currentVersion,
    `${contract.type}.currentVersion`
  );
  if (contract.migrations.length !== currentVersion - 1) {
    throw new NotebookContentExtensionError(
      'NOTEBOOK_CONTENT_EXTENSION_INVALID',
      `${contract.type} must provide one migration for every version before ${currentVersion}`
    );
  }
  for (let version = 1; version < currentVersion; version += 1) {
    const migration = contract.migrations[version - 1];
    if (migration?.from !== version || migration.to !== version + 1) {
      throw new NotebookContentExtensionError(
        'NOTEBOOK_CONTENT_EXTENSION_INVALID',
        `${contract.type} migration chain must contain ${version} -> ${version + 1}`
      );
    }
  }
  const markdownNodeTypes = contract.markdownNodeTypes ?? [];
  if ((contract.fromMarkdown === undefined) !== (markdownNodeTypes.length === 0)) {
    throw new NotebookContentExtensionError(
      'NOTEBOOK_CONTENT_EXTENSION_INVALID',
      `${contract.type} must declare both fromMarkdown and at least one Markdown node type`
    );
  }
}

function validateMarkContract(contract: NotebookMarkdownMarkContract): void {
  if (!validSyntaxType(contract.type)) {
    throw new NotebookContentExtensionError(
      'NOTEBOOK_CONTENT_EXTENSION_INVALID',
      `Invalid Markdown mark type: ${contract.type}`
    );
  }
}

function richBlockVersion(value: unknown): number {
  if (value === undefined || value === null) return 1;
  return positiveInteger(value, 'Rich-block version');
}

export class NotebookContentExtensionRegistry {
  private readonly richBlocks = new Map<string, NotebookRichBlockContract>();
  private readonly markdownBlocks = new Map<string, NotebookRichBlockContract>();
  private readonly marks = new Map<string, NotebookMarkdownMarkContract>();

  constructor(extensions: readonly NotebookContentExtension[]) {
    for (const extension of extensions) {
      switch (extension.kind) {
        case 'rich-block':
          validateRichBlockContract(extension);
          if (this.richBlocks.has(extension.type)) {
            throw new NotebookContentExtensionError(
              'NOTEBOOK_CONTENT_EXTENSION_INVALID',
              `Duplicate rich-block type: ${extension.type}`
            );
          }
          this.richBlocks.set(extension.type, extension);
          for (const markdownNodeType of extension.markdownNodeTypes ?? []) {
            if (!validSyntaxType(markdownNodeType) || this.markdownBlocks.has(markdownNodeType)) {
              throw new NotebookContentExtensionError(
                'NOTEBOOK_CONTENT_EXTENSION_INVALID',
                `Duplicate or invalid Markdown node type: ${markdownNodeType}`
              );
            }
            this.markdownBlocks.set(markdownNodeType, extension);
          }
          break;
        case 'mark':
          validateMarkContract(extension);
          if (this.marks.has(extension.type)) {
            throw new NotebookContentExtensionError(
              'NOTEBOOK_CONTENT_EXTENSION_INVALID',
              `Duplicate Markdown mark type: ${extension.type}`
            );
          }
          this.marks.set(extension.type, extension);
          break;
        default: {
          const exhaustive: never = extension;
          throw new NotebookContentExtensionError(
            'NOTEBOOK_CONTENT_EXTENSION_INVALID',
            `Unknown notebook extension kind: ${String(exhaustive)}`
          );
        }
      }
    }
  }

  richBlock(type: string): NotebookRichBlockContract | undefined {
    return this.richBlocks.get(type);
  }

  mark(type: string): NotebookMarkdownMarkContract | undefined {
    return this.marks.get(type);
  }

  richBlockForMarkdownNode(type: string): NotebookRichBlockContract | undefined {
    return this.markdownBlocks.get(type);
  }

  allRichBlocks(): readonly NotebookRichBlockContract[] {
    return [...this.richBlocks.values()];
  }

  resolveRichBlock(input: {
    readonly type: unknown;
    readonly version: unknown;
    readonly data: unknown;
  }): ResolvedNotebookRichBlock {
    if (typeof input.type !== 'string' || !validRichBlockType(input.type)) {
      throw new NotebookContentExtensionError(
        'NOTEBOOK_CONTENT_DATA_INVALID',
        'Rich-block type is invalid'
      );
    }
    const version = richBlockVersion(input.version);
    if (!isUnknownRecord(input.data)) {
      throw new NotebookContentExtensionError(
        'NOTEBOOK_CONTENT_DATA_INVALID',
        `${input.type} version ${version} data must be an object`
      );
    }

    const contract = this.richBlocks.get(input.type);
    if (!contract) {
      return { kind: 'unknown', type: input.type, version, data: input.data };
    }
    if (version > contract.currentVersion) {
      return {
        kind: 'future',
        type: input.type,
        version,
        supportedVersion: contract.currentVersion,
        data: input.data,
      };
    }

    let migratedData: Record<string, unknown> = input.data;
    for (let from = version; from < contract.currentVersion; from += 1) {
      const migration = contract.migrations[from - 1];
      if (!migration) {
        throw new NotebookContentExtensionError(
          'NOTEBOOK_CONTENT_MIGRATION_FAILED',
          `${contract.type} has no migration from version ${from}`
        );
      }
      let migrated: unknown;
      try {
        migrated = migration.migrate(migratedData);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new NotebookContentExtensionError(
          'NOTEBOOK_CONTENT_MIGRATION_FAILED',
          `${contract.type} migration ${migration.from} -> ${migration.to} failed: ${message}`
        );
      }
      if (!isUnknownRecord(migrated)) {
        throw new NotebookContentExtensionError(
          'NOTEBOOK_CONTENT_MIGRATION_FAILED',
          `${contract.type} migration ${migration.from} -> ${migration.to} returned invalid data`
        );
      }
      migratedData = migrated;
    }

    const parsed = contract.parseData(migratedData);
    if (!parsed.ok) {
      throw new NotebookContentExtensionError(
        'NOTEBOOK_CONTENT_DATA_INVALID',
        `${contract.type} version ${contract.currentVersion} failed validation: ${parsed.reason}`
      );
    }
    return {
      kind: 'supported',
      contract,
      data: parsed.data,
      sourceVersion: version,
      version: contract.currentVersion,
    };
  }
}

export function createNotebookContentExtensionRegistry(
  extensions: readonly NotebookContentExtension[]
): NotebookContentExtensionRegistry {
  return new NotebookContentExtensionRegistry(extensions);
}

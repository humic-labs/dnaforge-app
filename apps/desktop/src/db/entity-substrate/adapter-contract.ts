export interface EntityReconcileContext {
  workspaceRoot: string | null;

  workspaceId?: number | null;

  workspaceScope?: string | null;

  mutationToken?: string;
}

export interface EntityProjectionState {
  fingerprint: string;

  updatedAtMs: number;

  eventSeq?: number;

  sourceBindingMatches?: boolean;
}

export interface WorkspaceEntityAdapter<TDoc = unknown> {
  readonly kind: string;

  readonly schema?: string;

  readonly projectionVersion?: number;

  matchesPath(path: string): boolean;

  parse(bytes: string, path: string): TDoc | Promise<TDoc>;

  parseSource?(
    bytes: string,
    path: string,
    fileMtimeMs: number,
    ctx?: EntityReconcileContext
  ): Promise<{ document: TDoc; fileMtimeMs: number }>;

  serialize(doc: TDoc): string;

  identity(doc: TDoc, ctx: EntityReconcileContext): string;

  projectionFingerprint(doc: TDoc): string | Promise<string>;

  getProjection(
    id: string,
    ctx: EntityReconcileContext,
    path: string
  ): Promise<EntityProjectionState | null>;

  writeProjection(
    doc: TDoc,
    id: string,
    fileMtimeMs: number,
    path: string,
    ctx: EntityReconcileContext,
    expectedProjection?: EntityProjectionState | null
  ): Promise<void | { sourceDocument: TDoc }>;

  reconcileRelationships?(
    doc: TDoc,
    id: string,
    path: string,
    ctx: EntityReconcileContext
  ): Promise<void>;
}

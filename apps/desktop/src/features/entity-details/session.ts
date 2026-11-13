import { toUserMessage, userMessage, type UserMessage } from '@waypoint/user-messages';
import { SavedDocumentCompletionError } from '../../services/saved-document-completion';
import {
  beginWorkspaceEditorWrite,
  registerWorkspaceEditorBlocker,
} from '../../services/workspace-editor-mutation-state';
import type { LimsEntityHistoryEntry } from '../../shared/lims';
import { metadataValuesEqual, metadataFieldDraftValue } from '../../shared/metadata-values';
import { resolvedEntitySchemaFields } from '../../shared/sequence-entity-schema';
import type { StoredMetadataFieldDraft } from '../../shared/components/entity-metadata/EntityMetadataFieldEditor';
import { createMetadataEditingCoordinator } from '../../shared/components/entity-metadata/metadata-editing-coordinator';
import type {
  EntityDetailsDefinition,
  EntityDetailsPorts,
  EntityDetailsTarget,
  EntityDetailsValues,
} from './types';

export interface EntityDetailsState {
  definition: EntityDetailsDefinition | null;
  draft: EntityDetailsValues | null;
  invalid: ReadonlySet<string>;
  activeField: string | null;
  loading: boolean;
  saving: boolean;
  error: UserMessage | null;
  notice: UserMessage | null;
  history: LimsEntityHistoryEntry[] | null;
  historyLoading: boolean;
  historyError: boolean;
  generation: number;
  saveRevision: number;
  savedFields: readonly string[];
  requiresReload: boolean;
  completionPending: boolean;
  fieldDrafts: Readonly<Record<string, StoredMetadataFieldDraft>>;
  mutationBlock: string | null;
  saveConfirmed: boolean;
}

function values(definition: EntityDetailsDefinition): EntityDetailsValues {
  return {
    ...(definition.record.scientific ? { scientific: { ...definition.record.scientific } } : {}),
    name: definition.record.name,
    fields: { ...definition.record.fields },
    schema: definition.record.schema,
    refreshGeneticCodeRevision: false,
  };
}

function same(left: unknown, right: unknown): boolean {
  return metadataValuesEqual(left, right);
}

function sameRevision(left: EntityDetailsDefinition, right: EntityDetailsDefinition): boolean {
  const a = left.savedRecord?.loaded;
  const b = right.savedRecord?.loaded;
  return (
    same(values(left), values(right)) &&
    ((!a && !b) ||
      Boolean(
        a &&
        b &&
        a.content === b.content &&
        a.path === b.path &&
        a.preview.entity.eventSeq === b.preview.entity.eventSeq
      ))
  );
}

export class EntityDetailsSession {
  private state: EntityDetailsState = {
    definition: null,
    draft: null,
    invalid: new Set(),
    activeField: null,
    loading: true,
    saving: false,
    error: null,
    notice: null,
    history: null,
    historyLoading: false,
    historyError: false,
    generation: 0,
    saveRevision: 0,
    savedFields: [],
    requiresReload: false,
    completionPending: false,
    fieldDrafts: {},
    mutationBlock: null,
    saveConfirmed: false,
  };
  private listeners = new Set<() => void>();
  private mutationHolds = new Map<symbol, string>();
  private recoveredDrafts = new Set<string>();
  private loadRequest = 0;
  private historyRequest = 0;
  private operation: Promise<void> | null = null;
  private completion: (() => Promise<void>) | null = null;
  private unregisterBlocker: () => void;
  readonly editingCoordinator = createMetadataEditingCoordinator();

  constructor(
    readonly target: EntityDetailsTarget,
    private readonly ports: EntityDetailsPorts
  ) {
    this.unregisterBlocker = registerWorkspaceEditorBlocker(() => ({
      entityId: this.target.entityId,
      path: this.state.definition?.record.path,
      state:
        this.state.saving || this.state.completionPending
          ? 'saving'
          : this.dirty
            ? 'dirty'
            : 'clean',
    }));
  }

  getSnapshot = (): EntityDetailsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(update: Partial<EntityDetailsState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }

  get dirty(): boolean {
    const { definition, draft, invalid } = this.state;
    return Boolean(
      invalid.size ||
      (definition && draft && !same(values(definition), { ...draft, name: draft.name.trim() }))
    );
  }

  get editing(): boolean {
    return (
      this.dirty ||
      this.state.activeField !== null ||
      this.state.saving ||
      this.state.requiresReload
    );
  }

  load = async (): Promise<boolean> => {
    const request = ++this.loadRequest;
    this.publish({ loading: !this.state.definition });
    try {
      const definition = await this.ports.load(this.target);
      if (request !== this.loadRequest) return false;
      if (
        this.dirty ||
        this.state.saving ||
        this.state.completionPending ||
        this.state.activeField !== null
      ) {
        const current = this.state.definition;
        const changed =
          !this.state.saving &&
          !this.state.completionPending &&
          current?.savedRecord &&
          definition.savedRecord &&
          !sameRevision(current, definition);
        this.publish({
          loading: false,
          ...(changed
            ? {
                requiresReload: true,
                error: userMessage('record.changedWhileEditing'),
              }
            : {}),
          ...(current
            ? {
                definition: {
                  ...current,
                  record: { ...current.record, readOnlyReason: definition.record.readOnlyReason },
                },
              }
            : {}),
        });
        return false;
      }
      this.completion = definition.pendingCompletion ?? null;
      const saveConfirmed = Boolean(
        this.state.definition &&
        sameRevision(this.state.definition, definition) &&
        this.state.saveConfirmed
      );
      this.publish({
        definition,
        draft: values(definition),
        loading: false,
        error: null,
        requiresReload: Boolean(this.completion),
        completionPending: Boolean(this.completion),
        saveConfirmed: Boolean(this.completion) || saveConfirmed,
      });
    } catch (cause) {
      if (request !== this.loadRequest) return false;
      this.publish({ loading: false, error: message(cause), requiresReload: true });
      return false;
    }
    void this.loadHistory();
    return true;
  };

  loadHistory = async (): Promise<void> => {
    const request = ++this.historyRequest;
    this.publish({ historyLoading: true, historyError: false });
    try {
      const history = await this.ports.history(this.target.entityId);
      if (request === this.historyRequest) this.publish({ history, historyLoading: false });
    } catch {
      if (request === this.historyRequest)
        this.publish({ historyError: true, historyLoading: false });
    }
  };

  fieldEditing = (key: string, editing: boolean): void => {
    if (this.state.saving && editing) return;
    this.publish({
      activeField: editing ? key : this.state.activeField === key ? null : this.state.activeField,
    });
  };

  stage = (key: string, draft: { valid: true; value: unknown } | { valid: false }): void => {
    if (this.state.saving || this.state.requiresReload || !this.state.draft) return;
    const invalid = new Set(this.state.invalid);
    if (draft.valid) invalid.delete(key);
    else invalid.add(key);
    const field = resolvedEntitySchemaFields(this.state.draft.schema).find(
      (entry) => entry.key === key
    );
    const baseline = this.state.definition?.record.fields ?? {};
    const value = draft.valid
      ? metadataFieldDraftValue(field ?? { type: 'string' }, draft.value, baseline[key])
      : undefined;
    let next = this.state.draft;
    if (draft.valid) {
      if (key === '$name') next = { ...next, name: String(draft.value) };
      else {
        const fields = { ...next.fields };
        if (value === undefined && !Object.hasOwn(baseline, key)) delete fields[key];
        else fields[key] = value;
        next = { ...next, fields };
      }
    }
    this.publish({ draft: next, invalid });
  };

  stageScientific = (scientific: NonNullable<EntityDetailsValues['scientific']>): void => {
    if (this.state.saving || this.state.requiresReload || !this.state.draft) return;
    const draft = { ...this.state.draft, scientific };
    const invalid = new Set(this.state.invalid);
    if (this.state.definition?.validate?.(draft)) invalid.add('$scientific');
    else invalid.delete('$scientific');
    this.publish({ draft, invalid });
  };

  storeFieldDraft = (key: string, draft: StoredMetadataFieldDraft | null): void => {
    const fieldDrafts = { ...this.state.fieldDrafts };
    if (draft) fieldDrafts[key] = draft;
    else delete fieldDrafts[key];
    this.publish({ fieldDrafts });
  };

  selectSchema = (schema: EntityDetailsValues['schema']): void => {
    if (
      this.state.saving ||
      this.state.requiresReload ||
      !this.state.draft ||
      !this.state.definition?.schemaChoices
    )
      return;
    if (schema.baseKind !== this.state.definition.record.schema.baseKind) {
      this.publish({ error: userMessage('record.schemaWrongType') });
      return;
    }
    this.publish({ draft: { ...this.state.draft, schema } });
  };

  refreshGeneticCode = (): void => {
    if (this.state.saving || this.state.requiresReload || !this.state.draft) return;
    this.publish({ draft: { ...this.state.draft, refreshGeneticCodeRevision: true } });
  };

  discard = (): void => {
    if (
      this.state.saving ||
      (this.state.completionPending && this.state.saveConfirmed) ||
      !this.state.definition
    )
      return;
    this.completion = null;
    this.state.definition.savedRecord?.discard();
    this.publish({
      draft: values(this.state.definition),
      invalid: new Set(),
      activeField: null,
      error: null,
      generation: this.state.generation + 1,
      fieldDrafts: {},
      completionPending: false,
      requiresReload: true,
      saveConfirmed: false,
    });
    void this.load();
  };

  requestClose = (close: () => void): void => {
    if (this.state.mutationBlock) {
      this.showError(toUserMessage(this.state.mutationBlock, 'record.readOnly'));
      return;
    }
    if (this.state.saving) return;
    if (this.state.completionPending) {
      this.showError(
        this.state.saveConfirmed
          ? userMessage('record.saveBeforeClosing')
          : userMessage('record.confirmBeforeClosing')
      );
      return;
    }
    if (this.dirty) this.publish({ error: userMessage('record.finishBeforeClosing') });
    else close();
  };

  showError = (error: UserMessage): void => this.publish({ error });

  markStale = (error: string): void => {
    this.publish({ error: toUserMessage(error, 'operation.failed'), requiresReload: true });
  };

  recoverRecordDraft = (
    draft: { name: string; fields: Record<string, unknown> },
    pending?: { key: string; complete: () => Promise<void> }
  ): void => {
    if (!this.state.definition || !this.state.draft || this.state.saving) return;
    const identity = JSON.stringify([draft, pending?.key]);
    if (this.recoveredDrafts.has(identity)) return;
    this.recoveredDrafts.add(identity);
    const restored = {
      ...this.state.draft,
      name: draft.name,
      fields: { ...this.state.draft.fields, ...draft.fields },
    };
    if (pending) this.completion = pending.complete;
    this.publish({
      draft: restored,
      ...(pending
        ? {
            definition: {
              ...this.state.definition,
              record: { ...this.state.definition.record, ...restored },
            },
            requiresReload: true,
            completionPending: true,
            saveConfirmed: false,
            error: userMessage('record.previousSaveUnconfirmed'),
          }
        : {}),
      invalid: new Set(),
      activeField: null,
      fieldDrafts: {},
      generation: this.state.generation + 1,
    });
  };

  holdMutations = (reason: string): (() => void) => {
    const owner = Symbol();
    this.mutationHolds.set(owner, reason);
    this.publish({ mutationBlock: this.mutationHolds.values().next().value ?? null });
    return () => {
      if (!this.mutationHolds.delete(owner)) return;
      this.publish({ mutationBlock: this.mutationHolds.values().next().value ?? null });
    };
  };

  performAction = async (operation: () => Promise<UserMessage | void>): Promise<void> => {
    if (this.state.mutationBlock) {
      this.showError(toUserMessage(this.state.mutationBlock, 'record.readOnly'));
      return;
    }
    if (this.operation || this.state.saving) return;
    if (this.state.requiresReload) {
      this.showError(userMessage('record.finishSavedChanges'));
      return;
    }
    if (this.dirty) {
      this.showError(userMessage('record.finishBeforeAction'));
      return;
    }
    this.loadRequest++;
    this.publish({ saving: true, error: null, notice: null });
    let finish: (() => void) | undefined;
    try {
      finish = beginWorkspaceEditorWrite({
        entityId: this.target.entityId,
        path: this.state.definition?.record.path,
      });
      let notice: UserMessage | null = null;
      this.operation = operation().then((result) => {
        notice = typeof result === 'string' ? toUserMessage(result, 'operation.failed') : null;
      });
      await this.operation;
      this.ports.changed(this.target.entityId);
      const definition = await this.ports.load(this.target);
      this.publish({
        definition,
        draft: values(definition),
        notice,
        generation: this.state.generation + 1,
      });
      void this.loadHistory();
    } catch (cause) {
      this.showError(toUserMessage(cause, 'operation.failed'));
    } finally {
      this.loadRequest++;
      this.operation = null;
      finish?.();
      this.publish({ saving: false });
    }
  };

  rename = async (name: string): Promise<void> => {
    if (this.state.mutationBlock) throw new Error(this.state.mutationBlock);
    if (this.operation || !this.state.definition?.rename)
      throw new Error('Wait for the current save to finish.');
    const definition = this.state.definition;
    const rename = definition.rename;
    if (!rename || definition.record.readOnlyReason || this.state.requiresReload)
      throw new Error('Editing is unavailable for this record.');
    if (!name.trim()) throw new Error('Name cannot be empty.');
    this.loadRequest++;
    this.publish({ saving: true, error: null, notice: null });
    let finish: (() => void) | undefined;
    try {
      finish = beginWorkspaceEditorWrite({
        entityId: this.target.entityId,
        path: definition.record.path,
      });
      const commitName = () => {
        const record = {
          ...definition.record,
          name: name.trim(),
          ...(definition.record.sequence?.document
            ? {
                sequence: {
                  ...definition.record.sequence,
                  document: { ...definition.record.sequence.document, name: name.trim() },
                },
              }
            : {}),
        };
        this.publish({
          definition: { ...definition, record },
          draft: this.state.draft ? { ...this.state.draft, name: name.trim() } : null,
          savedFields: ['name'],
        });
      };
      this.operation = rename(name.trim());
      try {
        await this.operation;
      } catch (cause) {
        if (!(cause instanceof SavedDocumentCompletionError)) throw cause;
        commitName();
        this.completion = cause.complete;
        this.publish({
          requiresReload: true,
          completionPending: true,
          error: toUserMessage(cause, 'document.saveRefreshPending'),
          saveConfirmed: cause.saveConfirmed,
        });
        if (cause.saveConfirmed) this.ports.changed(this.target.entityId);
        return;
      }
      commitName();
      this.publish({ saveRevision: this.state.saveRevision + 1, saveConfirmed: true });
      this.ports.changed(this.target.entityId);
      void this.loadHistory();
    } finally {
      this.loadRequest++;
      this.operation = null;
      finish?.();
      this.publish({ saving: false });
    }
  };

  save = async (): Promise<void> => {
    if (this.state.mutationBlock) {
      this.showError(toUserMessage(this.state.mutationBlock, 'record.readOnly'));
      return;
    }
    this.editingCoordinator.finish();
    if (this.operation || !this.dirty || this.state.invalid.size) return;
    const { definition, draft } = this.state;
    if (
      !definition?.save ||
      definition.record.readOnlyReason ||
      !draft ||
      !draft.name.trim() ||
      this.state.requiresReload
    )
      return;
    if (definition.rename && draft.name.trim() !== definition.record.name) {
      this.publish({
        error: userMessage('record.finishNameDraft'),
      });
      return;
    }
    this.loadRequest++;
    this.publish({ saving: true, error: null, notice: null });
    const savedFields = [
      ...Object.keys(draft.fields).filter(
        (key) => !same(draft.fields[key], definition.record.fields[key])
      ),
      ...(draft.name !== definition.record.name ? ['name'] : []),
    ];
    let finish: (() => void) | undefined;
    try {
      finish = beginWorkspaceEditorWrite({
        entityId: this.target.entityId,
        path: definition.record.path,
      });
      this.operation = definition.save({ ...draft, name: draft.name.trim() });
      await this.operation;
      this.publish({
        definition: {
          ...definition,
          record: {
            ...definition.record,
            ...draft,
            name: draft.name.trim(),
            refreshGeneticCodeRevision: false,
          },
        },
        draft: { ...draft, name: draft.name.trim(), refreshGeneticCodeRevision: false },
        invalid: new Set(),
        activeField: null,
        requiresReload: true,
        saveConfirmed: true,
        savedFields,
        fieldDrafts: {},
      });
      this.ports.changed(this.target.entityId);
      const next = await this.ports.load(this.target);
      if (next.record.readOnlyReason) throw new Error(next.record.readOnlyReason);
      this.publish({
        definition: next,
        draft: values(next),
        invalid: new Set(),
        activeField: null,
        generation: this.state.generation + 1,
        saveRevision: this.state.saveRevision + 1,
        savedFields,
        requiresReload: false,
        fieldDrafts: {},
      });
      void this.loadHistory();
    } catch (cause) {
      if (cause instanceof SavedDocumentCompletionError) {
        this.completion = cause.complete;
        this.publish({
          definition: {
            ...definition,
            record: { ...definition.record, ...draft, refreshGeneticCodeRevision: false },
          },
          draft: { ...draft, refreshGeneticCodeRevision: false },
          invalid: new Set(),
          activeField: null,
          fieldDrafts: {},
          requiresReload: true,
          completionPending: true,
          saveConfirmed: cause.saveConfirmed,
          savedFields,
        });
        if (cause.saveConfirmed) this.ports.changed(this.target.entityId);
      }
      this.publish({
        error:
          cause instanceof SavedDocumentCompletionError
            ? toUserMessage(cause, 'document.saveRefreshPending')
            : this.state.requiresReload
              ? userMessage('document.saveRefreshPending')
              : message(cause),
      });
    } finally {
      this.loadRequest++;
      this.operation = null;
      finish?.();
      this.publish({ saving: false });
    }
  };

  retryCompletion = async (): Promise<void> => {
    if (this.state.mutationBlock) {
      this.showError(toUserMessage(this.state.mutationBlock, 'record.readOnly'));
      return;
    }
    if (this.operation || this.state.saving) return;
    const complete = this.completion;
    const keepDraft = this.dirty;
    this.loadRequest++;
    this.publish({ saving: true, error: null });
    let finish: (() => void) | undefined;
    try {
      if (complete) {
        finish = beginWorkspaceEditorWrite({
          entityId: this.target.entityId,
          path: this.state.definition?.record.path,
        });
        this.operation = complete();
        await this.operation;
        this.completion = null;
        this.publish({ completionPending: false, saveConfirmed: true });
      }
      const definition = await this.ports.load(this.target);
      if (definition.record.readOnlyReason) throw new Error(definition.record.readOnlyReason);
      this.completion = definition.pendingCompletion ?? null;
      this.publish({
        definition: keepDraft ? this.state.definition : definition,
        draft: keepDraft ? this.state.draft : values(definition),
        requiresReload: Boolean(this.completion),
        completionPending: Boolean(this.completion),
        generation: this.state.generation + 1,
        saveRevision: this.state.saveRevision + 1,
      });
      this.ports.changed(this.target.entityId);
      void this.loadHistory();
    } catch (cause) {
      this.publish({
        error: !this.state.saveConfirmed
          ? toUserMessage(cause, 'document.saveUnconfirmed')
          : this.completion
            ? toUserMessage(cause, 'document.saveRefreshPending')
            : userMessage('document.saveRefreshPending'),
      });
    } finally {
      this.loadRequest++;
      this.operation = null;
      finish?.();
      this.publish({ saving: false });
    }
  };

  dispose = (): boolean => {
    if (this.dirty || this.state.saving || this.state.completionPending || this.listeners.size)
      return false;
    this.loadRequest++;
    this.historyRequest++;
    this.unregisterBlocker();
    return true;
  };
}

function message(cause: unknown): UserMessage {
  return toUserMessage(cause, 'operation.failed');
}

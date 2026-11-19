import { createHash, randomUUID } from 'node:crypto';
import { hasRequiredCapabilities } from '../shared/capability-policy';
import type { WindowZoomResult } from '../shared/window-zoom';
import { DEFAULT_MOLECULAR_AGENT_GUIDANCE } from '../shared/agent-presentation-instructions';
import {
  ADMINISTRATION_SETTINGS_DEFAULTS,
  administrationRequestSchema,
  administrationSettingsSchema,
  type AdministrationAccount,
  type AdministrationAgentAuthority,
  type AdministrationAction,
  type AdministrationActionTarget,
  type AdministrationEvent,
  type AdministrationHandoff,
  type AdministrationRequest,
  type AdministrationResult,
  type AdministrationSettings,
  type AdministrationSettingsSnapshot,
  type AdministrationShareImportReview,
  type AdministrationShareImportResult,
} from '../shared/administration';
import type { BenchlingMigrationRunView } from '../shared/benchling-migration-ipc';
import type {
  DeepSharePublishResult,
  DeepShareReview,
  DeepShareSelectionRequest,
} from '../shared/deep-share-ipc';

export interface AdministrationStorage {
  readSettings(): Partial<AdministrationSettings>;
  writeSettings(values: AdministrationSettings, adopted: Array<keyof AdministrationSettings>): void;
  readAction(id: string): AdministrationAction | null;
  writeAction(action: AdministrationAction): void;
}
export interface AdministrationOwnerDependencies {
  storage: AdministrationStorage;
  account(): Promise<AdministrationAccount | null>;
  prepareShare(selection: DeepShareSelectionRequest): Promise<DeepShareReview>;
  publishShare(
    selection: DeepShareSelectionRequest,
    digest: string,
    expectedAccountId: string,
    assertAuthority: () => Promise<void>
  ): Promise<DeepSharePublishResult>;
  migration(runId?: string): Promise<BenchlingMigrationRunView | null>;
  actOnMigration(
    runId: string,
    action: 'start' | 'pause' | 'resume' | 'unlock'
  ): Promise<BenchlingMigrationRunView>;
  requestApproval(action: AdministrationAction, signal: AbortSignal): Promise<boolean>;
  beginHandoff(target: AdministrationHandoff): Promise<void>;
  observeHandoff(
    target: AdministrationHandoff
  ): Promise<{ completed: boolean; cancelled?: boolean; message: string }>;
  applySettings?(
    snapshot: AdministrationSettingsSnapshot,
    keys: Array<keyof AdministrationSettings>
  ): WindowZoomResult | void;
  publish?(event: AdministrationEvent): void;
  now?: () => number;
  authorizeAgent?(agent: AdministrationAgentAuthority, required: string[]): Promise<void>;
  captureTargetAuthority?(target: AdministrationActionTarget): Promise<() => void>;
  prepareShareImport?(
    sourceUrl: string,
    expectedAccountId: string
  ): Promise<{
    review: AdministrationShareImportReview;
    apply(assertAuthority: () => Promise<void>): Promise<AdministrationShareImportResult>;
    assertCurrent(): void;
  }>;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const accountKey = (value: AdministrationAccount | null) =>
  value ? `${value.accountId}:${value.desktopSessionId}` : null;
const settingKeys = Object.keys(ADMINISTRATION_SETTINGS_DEFAULTS) as Array<
  keyof AdministrationSettings
>;

export function administrationMigrationRevision(run: BenchlingMigrationRunView): string {
  return `administration-migration-v1:${digest([run.id, run.workspaceId, run.state, run.resumeState, run.attempt, run.binding, run.recoveryAction, run.localBundleState, run.sourceArtifact])}`;
}

export class AdministrationOwner {
  private settings: AdministrationSettingsSnapshot | null = null;
  private readonly pending = new Map<string, AbortController>();
  private readonly targetAuthorities = new Map<string, () => void>();
  private readonly importPreparations = new Map<
    string,
    {
      apply(assertAuthority: () => Promise<void>): Promise<AdministrationShareImportResult>;
      assertCurrent(): void;
    }
  >();
  private readonly instance = randomUUID();
  private generation = 0;

  constructor(private readonly deps: AdministrationOwnerDependencies) {}

  async execute(
    input: AdministrationRequest,
    assertCurrent: () => void,
    agent?: AdministrationAgentAuthority,
    humanReview?: { actionId: string; expectedRevision: string }
  ): Promise<AdministrationResult> {
    let changed: boolean | 'unknown' = false;
    try {
      const { operation: op } = administrationRequestSchema.parse(input);
      assertCurrent();
      for (const id of this.importPreparations.keys()) {
        const action = this.deps.storage.readAction(id);
        if (!action || !['prepared', 'awaiting-human', 'executing'].includes(action.state))
          this.importPreparations.delete(id);
        else if (action.state === 'prepared' && Date.parse(action.expiresAt) <= this.now())
          this.transition(action, 'stale', 'The import preparation expired.');
      }
      await this.authorizeAgent(
        agent,
        op.kind === 'update-settings' ||
          op.kind === 'retry-settings' ||
          op.kind === 'adopt-settings'
          ? ['modify-settings']
          : op.kind === 'prepare-share' ||
              op.kind === 'prepare-share-import' ||
              op.kind === 'prepare-migration'
            ? ['write-workspace']
            : op.kind === 'prepare-handoff'
              ? [op.target.purpose === 'agent-access' ? 'manage-agent-access' : 'modify-settings']
              : ['read-workspace']
      );
      assertCurrent();
      if (op.kind === 'inspect-settings')
        return { kind: 'settings', snapshot: this.readSettings(), stateChanged: false };
      if (op.kind === 'inspect-structure-guidance') {
        const settings = this.readSettings();
        if (settings.unsavedKeys.includes('molecularAgentInstructions'))
          return this.fail(
            'STRUCTURE_GUIDANCE_UNSAVED',
            'Save or retry the structure guidance in Settings > AI, then read it again.',
            false
          );
        return {
          kind: 'structure-guidance',
          guidance: {
            defaultVersion: DEFAULT_MOLECULAR_AGENT_GUIDANCE.version,
            source: settings.adopted.includes('molecularAgentInstructions') ? 'override' : 'default',
            instructions:
              settings.values.molecularAgentInstructions ?? DEFAULT_MOLECULAR_AGENT_GUIDANCE.instructions,
          },
        };
      }
      if (
        op.kind === 'update-settings' ||
        op.kind === 'adopt-settings' ||
        op.kind === 'retry-settings'
      ) {
        const before = this.readSettings();
        if ('expectedRevision' in op && op.expectedRevision !== before.revision)
          return this.fail(
            'STALE_ADMINISTRATION_SETTINGS',
            'Settings changed. Inspect the current revision before updating.',
            false
          );
        const patch =
          op.kind === 'retry-settings'
            ? {}
            : Object.fromEntries(
                Object.entries(op.patch).filter(
                  ([key]) =>
                    op.kind !== 'adopt-settings' ||
                    !before.adopted.includes(key as keyof AdministrationSettings)
                )
              );
        const values = administrationSettingsSchema.parse({ ...before.values, ...patch });
        if (op.kind !== 'retry-settings' && !Object.keys(patch).length)
          return { kind: 'settings', snapshot: before, stateChanged: false };
        const writeKeys = (
          op.kind === 'retry-settings' ? (op.keys ?? before.unsavedKeys) : Object.keys(patch)
        ) as Array<keyof AdministrationSettings>;
        if (!writeKeys.length) return { kind: 'settings', snapshot: before, stateChanged: false };
        const unsaved = new Set([...before.unsavedKeys, ...writeKeys]);
        assertCurrent();
        changed = true;
        const snapshot: AdministrationSettingsSnapshot = {
          ownerId: this.instance,
          generation: this.generation + 1,
          revision: `administration-settings-v1:${digest([this.instance, ++this.generation, values])}`,
          values,
          adopted: [
            ...new Set([
              ...before.adopted,
              ...(Object.keys(patch) as Array<keyof AdministrationSettings>),
            ]),
          ],
          persistence: 'unsaved',
          unsavedKeys: [...unsaved],
          ...(before.zoom ? { zoom: before.zoom } : {}),
        };
        this.settings = snapshot;
        try {
          const zoom = this.deps.applySettings?.(snapshot, writeKeys);
          if (zoom) snapshot.zoom = zoom;
        } catch (error) {
          snapshot.message = `Preferences are retained, but display application is unconfirmed: ${error instanceof Error ? error.message : String(error)}`;
          if (writeKeys.includes('displayZoom'))
            snapshot.zoom = { status: 'failed', reason: 'apply_failed', factor: null };
        }
        const zoomFailed =
          writeKeys.includes('displayZoom') &&
          (snapshot.zoom?.status === 'failed' || snapshot.zoom?.status === 'refused');
        if (zoomFailed)
          snapshot.message =
            'The native display application failed. The selected value is retained for an explicit retry.';
        const persistentKeys = zoomFailed
          ? writeKeys.filter((key) => key !== 'displayZoom')
          : writeKeys;
        try {
          if (persistentKeys.length) this.deps.storage.writeSettings(values, persistentKeys);
          for (const key of persistentKeys) unsaved.delete(key);
        } catch (error) {
          snapshot.message = error instanceof Error ? error.message : String(error);
        }
        snapshot.unsavedKeys = [...unsaved];
        snapshot.persistence = unsaved.size ? 'unsaved' : 'saved';
        this.emit({ kind: 'settings', snapshot });
        return { kind: 'settings', snapshot, stateChanged: true };
      }
      if (op.kind === 'inspect-account') {
        const account = await this.deps.account();
        assertCurrent();
        return { kind: 'account', account };
      }
      if (op.kind === 'inspect-migration') {
        const run = await this.deps.migration(op.runId);
        assertCurrent();
        return {
          kind: 'migration',
          run,
          revision: run ? administrationMigrationRevision(run) : null,
        };
      }
      if (op.kind === 'prepare-share') {
        const account = await this.deps.account();
        if (!account)
          return this.fail('SIGN_IN_REQUIRED', 'Sign in before preparing a private share.', false);
        const review = await this.deps.prepareShare(op.selection);
        assertCurrent();
        await this.assertAccount(account);
        assertCurrent();
        return {
          kind: 'action',
          action: await this.prepare(
            {
              kind: 'share',
              selection: {
                ...op.selection,
                selectedConversationIds: op.selection.selectedConversationIds ?? [],
              },
              review,
            },
            account,
            [
              `Publish the reviewed ${review.files.length} files and ${review.chats.length} conversations as an anyone-with-link private share.`,
              `Account: ${account.email ?? account.accountId}.`,
              `Reviewed content: ${review.digest}.`,
            ],
            agent,
            assertCurrent
          ),
        };
      }
      if (op.kind === 'prepare-migration') {
        const account = await this.deps.account();
        const run = await this.deps.migration(op.runId);
        assertCurrent();
        if (!run || run.id !== op.runId)
          return this.fail('MIGRATION_NOT_FOUND', 'Choose an existing migration run.', false);
        await this.assertAccount(account);
        assertCurrent();
        return {
          kind: 'action',
          action: await this.prepare(
            {
              kind: 'migration',
              runId: run.id,
              runRevision: administrationMigrationRevision(run),
              action: op.action,
            },
            account,
            [`${op.action} the existing migration ${run.displayName}.`],
            agent,
            assertCurrent
          ),
        };
      }
      if (op.kind === 'prepare-share-import') {
        const account = await this.deps.account();
        if (!account)
          return this.fail(
            'SIGN_IN_REQUIRED',
            'Sign in before preparing a private-fork import.',
            false
          );
        if (!this.deps.prepareShareImport)
          return this.fail(
            'ADMINISTRATION_IMPORT_UNAVAILABLE',
            'Private-fork import is unavailable in this runtime.',
            false
          );
        const preparation = await this.deps
          .prepareShareImport(op.sourceUrl, account.accountId)
          .catch(() => {
            throw new Error(
              'ADMINISTRATION_SHARE_IMPORT_PREPARATION_FAILED: The shared bundle could not be loaded and validated for this account. Check the link and current sign-in.'
            );
          });
        assertCurrent();
        await this.assertAccount(account);
        assertCurrent();
        preparation.assertCurrent();
        const action = await this.prepare(
          { kind: 'share-import', review: preparation.review },
          account,
          [
            `Import ${preparation.review.source.fileCount} reviewed files and ${preparation.review.source.conversationCount} conversations from “${preparation.review.source.artifactName}”.`,
            `Create the new private project “${preparation.review.destination.displayName}” at ${preparation.review.destination.repoPath}.`,
            `Account: ${account.email ?? account.accountId}.`,
            `Source bundle: ${preparation.review.source.bundleSha256}.`,
          ],
          agent,
          assertCurrent
        );
        this.importPreparations.set(action.id, preparation);
        return { kind: 'action', action };
      }
      if (op.kind === 'prepare-handoff') {
        const account = await this.deps.account();
        const observation =
          op.target.purpose === 'sign-in'
            ? account
              ? {
                  completed: true,
                  message: 'The native sign-in owner already reports a signed-in session.',
                }
              : null
            : await this.deps.observeHandoff(op.target);
        assertCurrent();
        let action = await this.prepare(
          { kind: 'handoff', target: op.target },
          account,
          [
            'Open the existing human settings or sign-in flow; no credentials or authority are granted by this command.',
          ],
          agent,
          assertCurrent
        );
        if (observation?.completed) {
          action.result = observation;
          action = this.transition(action, 'completed', observation.message);
        }
        return { kind: 'action', action };
      }
      let action = this.deps.storage.readAction(op.actionId);
      if (!action)
        return this.fail(
          'ADMINISTRATION_ACTION_NOT_FOUND',
          'This action is unavailable; prepare a current action.',
          false
        );
      if (agent && action.originAgent?.identityId !== agent.identityId)
        return this.fail(
          'ADMINISTRATION_ACTION_DENIED',
          'This action belongs to a different caller. Prepare your own current action.',
          false
        );
      const signInHandoff =
        action.target.kind === 'handoff' && action.target.target.purpose === 'sign-in';
      if (!signInHandoff) await this.assertAccount(action.account);
      assertCurrent();
      action = this.deps.storage.readAction(op.actionId) ?? action;
      if (op.kind === 'inspect-action') {
        if (
          action.state === 'awaiting-human' &&
          action.target.kind === 'handoff' &&
          Date.parse(action.expiresAt) <= this.now()
        )
          action = this.transition(
            action,
            'stale',
            'The human handoff preparation expired. Prepare a current handoff.'
          );
        if (action.state === 'executing' && !this.pending.has(action.id))
          action = this.transition(
            action,
            'unresolved',
            'The previous execution ended without a confirmed outcome. Do not repeat it.'
          );
        if (
          action.state === 'awaiting-human' &&
          action.target.kind !== 'handoff' &&
          !this.pending.has(action.id)
        )
          action = this.transition(
            action,
            'cancelled',
            'The previous human decision ended without execution. Prepare a new action.'
          );
        if (action.state === 'awaiting-human' && action.target.kind === 'handoff') {
          const outcome = await this.deps.observeHandoff(action.target.target);
          assertCurrent();
          if (!signInHandoff) await this.assertAccount(action.account);
          assertCurrent();
          if (outcome.completed) {
            action = this.transition(action, 'completed', outcome.message);
            action.result = outcome;
            this.deps.storage.writeAction(action);
          } else if (outcome.cancelled)
            action = this.transition(action, 'cancelled', outcome.message);
        }
        return { kind: 'action', action };
      }
      if (op.expectedRevision !== action.revision)
        return this.fail(
          'STALE_ADMINISTRATION_ACTION',
          'The prepared action changed. Inspect its current state.',
          false,
          action
        );
      if (op.kind === 'cancel-action') {
        if (
          action.state === 'executing' ||
          action.state === 'completed' ||
          action.state === 'unresolved'
        )
          return this.fail(
            'ADMINISTRATION_ACTION_NOT_CANCELLABLE',
            'Execution has already begun or completed. Inspect its actual outcome.',
            false,
            action
          );
        this.pending.get(action.id)?.abort();
        return {
          kind: 'action',
          action: this.transition(
            action,
            'cancelled',
            'The prepared action was cancelled before execution.'
          ),
        };
      }
      if (
        action.state === 'completed' ||
        action.state === 'unresolved' ||
        action.state === 'executing' ||
        action.state === 'awaiting-human'
      )
        return { kind: 'action', action };
      if (action.state !== 'prepared')
        return this.fail(
          'ADMINISTRATION_ACTION_UNAVAILABLE',
          'Prepare a fresh action for the current target.',
          false,
          action
        );
      if (
        (action.target.kind !== 'handoff' &&
          this.deps.captureTargetAuthority &&
          !this.targetAuthorities.has(action.id)) ||
        (action.target.kind === 'share-import' && !this.importPreparations.has(action.id))
      )
        return {
          kind: 'action',
          action: this.transition(
            action,
            'stale',
            'This preparation belongs to a previous native owner. Prepare again against the current enrolled project.'
          ),
        };
      this.targetAuthorities.get(action.id)?.();
      this.importPreparations.get(action.id)?.assertCurrent();
      await this.authorizeAgent(
        agent,
        action.target.kind === 'handoff'
          ? [
              action.target.target.purpose === 'agent-access'
                ? 'manage-agent-access'
                : 'modify-settings',
            ]
          : ['write-workspace']
      );
      assertCurrent();
      if (Date.parse(action.expiresAt) <= this.now())
        return {
          kind: 'action',
          action: this.transition(action, 'stale', 'The preparation expired.'),
        };
      await this.assertAccount(action.account);
      assertCurrent();
      if (this.deps.storage.readAction(action.id)?.revision !== action.revision)
        return this.fail(
          'STALE_ADMINISTRATION_ACTION',
          'The prepared action changed while checking authority.',
          false
        );
      if (action.target.kind === 'handoff') {
        await this.deps.beginHandoff(action.target.target);
        assertCurrent();
        return {
          kind: 'action',
          action: this.transition(
            action,
            'awaiting-human',
            'Complete the existing human flow, then inspect this same action.'
          ),
        };
      }
      const controller = new AbortController();
      this.pending.set(action.id, controller);
      action = this.transition(
        action,
        'awaiting-human',
        action.target.kind === 'share' ||
          action.target.kind === 'share-import' ||
          action.target.action === 'unlock'
          ? 'Waiting for the exact native human decision.'
          : 'The existing migration owner will apply this prepared action.'
      );
      const reviewedByHuman =
        !action.originAgent &&
        humanReview?.actionId === action.id &&
        humanReview.expectedRevision === op.expectedRevision;
      void this.runPrepared(action, controller, assertCurrent, reviewedByHuman).catch(() => {});
      return { kind: 'action', action };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(
        error &&
          typeof error === 'object' &&
          'code' in error &&
          typeof error.code === 'string' &&
          /^[A-Z][A-Z0-9_]+$/u.test(error.code)
          ? error.code
          : (/^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] ?? 'ADMINISTRATION_FAILED'),
        message,
        changed
      );
    }
  }

  async invalidatePendingAccountActions(): Promise<void> {
    const current = await this.deps.account();
    for (const [id, controller] of this.pending) {
      const action = this.deps.storage.readAction(id);
      if (!action || accountKey(action.account) === accountKey(current)) continue;
      if (action.state !== 'executing')
        this.transition(action, 'stale', 'The account or session changed before execution.');
      controller.abort();
    }
  }

  private async runPrepared(
    initial: AdministrationAction,
    controller: AbortController,
    assertCurrent: () => void,
    reviewedByHuman: boolean
  ): Promise<void> {
    let action = initial;
    const current = () => {
      assertCurrent();
      this.targetAuthorities.get(action.id)?.();
      this.importPreparations.get(action.id)?.assertCurrent();
      if (
        controller.signal.aborted ||
        Date.parse(action.expiresAt) <= this.now() ||
        this.deps.storage.readAction(action.id)?.revision !== action.revision
      )
        throw new Error(
          'STALE_ADMINISTRATION_ACTION: The prepared action changed or was cancelled.'
        );
    };
    try {
      if (action.target.kind === 'handoff')
        throw new Error(
          'ADMINISTRATION_ACTION_INVALID: Human handoffs do not execute background mutations.'
        );
      const target = action.target;
      if (
        target.kind === 'share' || target.kind === 'share-import'
          ? !reviewedByHuman
          : target.action === 'unlock'
      ) {
        const approved = await this.deps.requestApproval(action, controller.signal);
        current();
        if (!approved) {
          this.transition(action, 'cancelled', 'The native human decision was cancelled.');
          return;
        }
      }
      await this.assertAccount(action.account);
      current();
      await this.authorizeAgent(action.originAgent ?? undefined, ['write-workspace']);
      current();
      if (target.kind === 'share') {
        const review = await this.deps.prepareShare(target.selection);
        current();
        await this.assertAccount(action.account);
        current();
        if (review.digest !== target.review.digest) {
          this.transition(
            action,
            'stale',
            'The selected share contents changed after preparation.'
          );
          return;
        }
        const expectedAccount = action.account;
        if (!expectedAccount) throw new Error('SIGN_IN_REQUIRED: Sign in before publishing.');
        action = this.transition(action, 'executing');
        const assertAuthority = async () => {
          await this.assertAccount(action.account);
          await this.authorizeAgent(action.originAgent ?? undefined, ['write-workspace']);
          current();
        };
        const result = await this.deps.publishShare(
          target.selection,
          target.review.digest,
          expectedAccount.accountId,
          assertAuthority
        );
        action.result = result;
        this.transition(
          action,
          result.ok ? 'completed' : 'unresolved',
          result.ok ? 'The exact reviewed share was published.' : result.message
        );
      } else if (target.kind === 'share-import') {
        const prepared = this.importPreparations.get(action.id);
        if (!prepared)
          throw new Error('ADMINISTRATION_IMPORT_UNAVAILABLE: Prepare this import again.');
        current();
        action = this.transition(action, 'executing');
        const assertAuthority = async () => {
          await this.assertAccount(action.account);
          await this.authorizeAgent(action.originAgent ?? undefined, ['write-workspace']);
          current();
        };
        const result = await prepared.apply(assertAuthority);
        action.result = result;
        this.transition(
          action,
          'completed',
          'The exact reviewed private-fork project was imported.'
        );
      } else {
        const run = await this.deps.migration(target.runId);
        current();
        await this.assertAccount(action.account);
        current();
        await this.authorizeAgent(action.originAgent ?? undefined, ['write-workspace']);
        current();
        if (!run || administrationMigrationRevision(run) !== target.runRevision) {
          this.transition(action, 'stale', 'The migration changed after preparation.');
          return;
        }
        action = this.transition(action, 'executing');
        const result = await this.deps.actOnMigration(target.runId, target.action);
        action.result = result;
        this.transition(action, 'completed', 'The existing migration owner accepted the action.');
      }
    } catch (error) {
      const latest = this.deps.storage.readAction(action.id);
      if (latest?.revision === action.revision)
        this.transition(
          action,
          action.state === 'executing' ? 'unresolved' : 'stale',
          error instanceof Error ? error.message : String(error)
        );
    } finally {
      this.pending.delete(action.id);
    }
  }

  private readSettings(): AdministrationSettingsSnapshot {
    if (!this.settings) {
      const stored = this.deps.storage.readSettings();
      const values = administrationSettingsSchema.parse({
        ...ADMINISTRATION_SETTINGS_DEFAULTS,
        ...stored,
      });
      this.settings = {
        ownerId: this.instance,
        generation: this.generation,
        revision: `administration-settings-v1:${digest([this.instance, this.generation, values])}`,
        values,
        adopted: settingKeys.filter((key) => stored[key] !== undefined),
        persistence: 'saved',
        unsavedKeys: [],
      };
    }
    return structuredClone(this.settings);
  }
  private async prepare(
    target: AdministrationActionTarget,
    account: AdministrationAccount | null,
    effects: string[],
    agent?: AdministrationAgentAuthority,
    assertCurrent: () => void = () => {}
  ): Promise<AdministrationAction> {
    const authority = await this.deps.captureTargetAuthority?.(target);
    assertCurrent();
    await this.assertAccount(account);
    assertCurrent();
    authority?.();
    const now = this.now();
    const action: AdministrationAction = {
      id: randomUUID(),
      revision: randomUUID(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30 * 60_000).toISOString(),
      account,
      originAgent: agent ? structuredClone(agent) : null,
      target,
      state: 'prepared',
      effects,
    };
    this.deps.storage.writeAction(action);
    if (authority) this.targetAuthorities.set(action.id, authority);
    this.emit({ kind: 'action', action });
    return action;
  }
  private transition(
    action: AdministrationAction,
    state: AdministrationAction['state'],
    message?: string
  ): AdministrationAction {
    const next = { ...action, revision: randomUUID(), state, ...(message ? { message } : {}) };
    this.deps.storage.writeAction(next);
    if (!['prepared', 'awaiting-human', 'executing'].includes(state))
      this.importPreparations.delete(action.id);
    this.emit({ kind: 'action', action: next });
    return next;
  }
  private async assertAccount(expected: AdministrationAccount | null): Promise<void> {
    if (accountKey(await this.deps.account()) !== accountKey(expected))
      throw new Error(
        'ADMINISTRATION_ACCOUNT_CHANGED: The signed-in account or session changed. Prepare a new action.'
      );
  }
  private async authorizeAgent(
    agent: AdministrationAgentAuthority | undefined,
    required: string[]
  ): Promise<void> {
    if (!agent) return;
    if (!this.deps.authorizeAgent || !hasRequiredCapabilities(agent.capabilities, required))
      throw new Error(
        'ADMINISTRATION_CAPABILITY_DENIED: This caller does not hold the required current capabilities.'
      );
    await this.deps.authorizeAgent(agent, required);
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private emit(event: AdministrationEvent): void {
    try {
      this.deps.publish?.(
        structuredClone(
          event.kind === 'action'
            ? {
                kind: 'action',
                action: {
                  id: event.action.id,
                  revision: event.action.revision,
                  state: event.action.state,
                },
              }
            : event
        )
      );
    } catch {}
  }
  private fail(
    code: string,
    message: string,
    stateChanged: boolean | 'unknown',
    action?: AdministrationAction
  ): AdministrationResult {
    return { kind: 'failed', code, message, stateChanged, ...(action ? { action } : {}) };
  }
}

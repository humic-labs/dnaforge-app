import {
  inventoryEquipmentIncidentActionId,
  inventoryEquipmentIncidentActionSummary,
  inventoryEquipmentIncidentActionIntentSha256,
  parseInventoryEquipmentIncidentActionChoices,
  parseInventoryEquipmentIncidentSummary,
  parseInventoryEquipmentIncidentActionSummary,
  inventoryTableCanonicalJson,
  type InventoryEquipmentIncidentActionChoices,
  type InventoryEquipmentIncidentActionProof,
  type InventoryEquipmentIncidentSummary,
  type InventoryEquipmentIncidentActionSummary,
  type InventoryPrincipal,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyEquipmentIncidentActionRequestSchema,
  inventoryEquipmentIncidentActionPreviewSnapshotSchema,
  inventoryEquipmentIncidentReadSchema,
  inventoryEquipmentIncidentFactsReadSchema,
  type InventoryApplyEquipmentIncidentActionRequest,
  type InventoryEquipmentIncidentActionPreviewSnapshot,
} from '../../shared/inventory-equipment-incidents';
import {
  assertInventoryReceiptForAttempt,
  executeInventoryAcceptedRequest,
  type InventoryAttempt,
  type InventoryPendingCoordinator,
} from './inventory-pending-coordinator';
import {
  equipmentIncidentFollowUpAction,
  equipmentIncidentFollowUpDraft,
  equipmentIncidentFollowUpDraftKey,
  equipmentIncidentDraftLabel,
  parseEquipmentIncidentFollowUpDraft,
  type EquipmentIncidentFollowUpDraft,
} from './inventory-equipment-incident-action-draft';
export type EquipmentIncidentScope = { project: string; inventoryId: string };
export type EquipmentIncidentReportDraft = {
  actionId: string;
  namespace?: string;
  configurationRevision: number;
  noticedTimeKnown: boolean;
  noticedTime: string;
  description: string;
  reason: string;
  followUp?: EquipmentIncidentFollowUpDraft;
};
type Phase =
  | { kind: 'editing' | 'previewing' | 'sending' }
  | { kind: 'failed'; message: string }
  | {
      kind: 'previewed';
      preview: InventoryEquipmentIncidentActionPreviewSnapshot;
      request?: InventoryApplyEquipmentIncidentActionRequest;
    }
  | { kind: 'unknown' | 'accepted-read-pending'; attempt: InventoryAttempt; message: string }
  | {
      kind: 'recorded';
      outcome: 'committed' | 'existing';
      incident: InventoryEquipmentIncidentSummary;
      record?: InventoryEquipmentIncidentActionSummary;
    };
export class InventoryEquipmentIncidentSession {
  private snapshot: { draft: EquipmentIncidentReportDraft; phase: Phase };
  private generation = 0;
  private active = true;
  private writable = true;
  private principalKey: string | null = null;
  private boundary: ReturnType<typeof setTimeout> | null = null;
  private prepared: InventoryApplyEquipmentIncidentActionRequest | null = null;
  private completed: Extract<Phase, { kind: 'recorded' }> | null = null;
  private readonly storageKey: string;
  private listeners = new Set<() => void>();
  constructor(
    readonly scope: EquipmentIncidentScope,
    readonly equipmentId: string,
    configurationRevision: number,
    private readonly client: InventoryClient,
    private readonly pending: InventoryPendingCoordinator,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly operationId: () => string = () => crypto.randomUUID(),
    private readonly initialFollowUp?: EquipmentIncidentFollowUpDraft
  ) {
    this.storageKey = `dnaforge.inventory.equipment-incident-report-draft.v1:${JSON.stringify([scope.project, scope.inventoryId, equipmentId])}`;
    if (initialFollowUp)
      this.storageKey += `:${equipmentIncidentFollowUpDraftKey(initialFollowUp)}`;
    this.snapshot = {
      draft: {
        actionId: crypto.randomUUID(),
        configurationRevision,
        noticedTimeKnown: false,
        noticedTime: '',
        description: '',
        reason: '',
        ...(initialFollowUp ? { followUp: structuredClone(initialFollowUp) } : {}),
      },
      phase: { kind: 'editing' },
    };
    try {
      const raw = storage.getItem(this.storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          saved.version !== 1 ||
          !saved.draft ||
          ['actionId', 'noticedTime', 'description', 'reason'].some(
            (key) => typeof saved.draft[key] !== 'string'
          ) ||
          !Number.isSafeInteger(saved.draft.configurationRevision) ||
          saved.draft.configurationRevision < 0 ||
          typeof saved.draft.noticedTimeKnown !== 'boolean' ||
          (saved.draft.namespace !== undefined &&
            (typeof saved.draft.namespace !== 'string' || !saved.draft.namespace))
        )
          throw Error('The retained outage draft could not be read.');
        if (
          JSON.stringify(
            saved.draft.followUp
              ? { kind: saved.draft.followUp.kind, incident: saved.draft.followUp.incident }
              : null
          ) !==
          JSON.stringify(
            initialFollowUp
              ? { kind: initialFollowUp.kind, incident: initialFollowUp.incident }
              : null
          )
        )
          throw Error('The retained incident action belongs to another incident.');
        if (saved.draft.followUp)
          saved.draft.followUp = parseEquipmentIncidentFollowUpDraft(saved.draft.followUp);
        this.snapshot.draft = saved.draft;
        if (saved.prepared) {
          inventoryApplyEquipmentIncidentActionRequestSchema.parse(saved.prepared);
          this.assertRequest(saved.prepared);
          this.prepared = saved.prepared;
        }
        if (saved.completed) {
          if (
            saved.completed.kind !== 'recorded' ||
            !['committed', 'existing'].includes(saved.completed.outcome)
          )
            throw Error('The saved incident result could not be read.');
          const incident = parseInventoryEquipmentIncidentSummary(saved.completed.incident);
          const record = saved.completed.record
            ? parseInventoryEquipmentIncidentActionSummary(saved.completed.record)
            : undefined;
          this.assertProof(record?.actionProof ?? incident.actionProof, this.choices());
          if (
            initialFollowUp &&
            (incident.id !== initialFollowUp.incident.incidentId ||
              incident.actionProof.intentSha256 !== initialFollowUp.incident.intentSha256)
          )
            throw Error('The saved result belongs to another incident.');
          this.completed = {
            kind: 'recorded',
            outcome: saved.completed.outcome,
            incident,
            ...(record ? { record } : {}),
          };
          this.snapshot.phase = this.completed;
        }
      }
      this.retainDraft();
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  activate() {
    this.active = true;
  }
  private publish(phase: Phase, draft = this.snapshot.draft) {
    if (!this.active) return;
    this.snapshot = { draft, phase };
    for (const listener of this.listeners) listener();
  }
  private busy() {
    return ['sending', 'unknown', 'accepted-read-pending', 'recorded'].includes(
      this.snapshot.phase.kind
    );
  }
  private retainDraft(draft = this.snapshot.draft) {
    this.storage.setItem(
      this.storageKey,
      JSON.stringify({
        version: 1,
        draft,
        prepared: this.prepared,
        ...(this.completed ? { completed: this.completed } : {}),
      })
    );
  }
  invalidate() {
    ++this.generation;
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
    if (!this.busy()) this.publish({ kind: 'editing' });
  }
  setWritable(value: boolean) {
    if (this.writable !== value) this.invalidate();
    this.writable = value;
  }
  setPrincipal(value: InventoryPrincipal) {
    const key = inventoryTableCanonicalJson(value);
    if (this.principalKey !== null && this.principalKey !== key) this.invalidate();
    this.principalKey = key;
  }
  edit(draft: EquipmentIncidentReportDraft) {
    if (this.busy()) return;
    this.invalidate();
    this.prepared = null;
    try {
      this.retainDraft(draft);
      this.publish({ kind: 'editing' }, structuredClone(draft));
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  private choices(): InventoryEquipmentIncidentActionChoices {
    const draft = this.snapshot.draft;
    if (draft.followUp) {
      if (
        !this.initialFollowUp ||
        draft.followUp.kind !== this.initialFollowUp.kind ||
        draft.followUp.incident.incidentId !== this.initialFollowUp.incident.incidentId ||
        draft.followUp.incident.intentSha256 !== this.initialFollowUp.incident.intentSha256
      )
        throw Error('This draft belongs to another incident action.');
      return parseInventoryEquipmentIncidentActionChoices({
        identity: {
          namespace: draft.namespace ?? 'manual-equipment-incidents',
          actionId: draft.actionId,
        },
        action: equipmentIncidentFollowUpAction(draft.followUp, draft.reason),
      });
    }
    let noticedAt: number | null = null;
    if (draft.noticedTimeKnown) {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(draft.noticedTime) ||
        !Number.isFinite(Date.parse(draft.noticedTime)) ||
        new Date(draft.noticedTime).toISOString() !== draft.noticedTime
      )
        throw Error('Enter when the outage was noticed with an explicit time zone.');
      noticedAt = Date.parse(draft.noticedTime);
    }
    return parseInventoryEquipmentIncidentActionChoices({
      identity: {
        namespace: draft.namespace ?? 'manual-equipment-incidents',
        actionId: draft.actionId,
      },
      action: {
        kind: 'report',
        equipment: {
          storageId: this.equipmentId,
          configurationRevision: draft.configurationRevision,
        },
        noticedAt,
        description: draft.description.trim(),
        reason: draft.reason.trim(),
      },
    });
  }
  private current(generation: number) {
    return this.active && generation === this.generation;
  }
  private assertProof(
    proof: InventoryEquipmentIncidentActionProof,
    choices: InventoryEquipmentIncidentActionChoices
  ) {
    if (
      proof.actionId !== inventoryEquipmentIncidentActionId(choices.identity) ||
      proof.intentSha256 !== inventoryEquipmentIncidentActionIntentSha256(choices) ||
      inventoryTableCanonicalJson(proof.choices) !== inventoryTableCanonicalJson(choices)
    )
      throw Error('The original outage record does not match the exact retained report.');
  }
  private assertRequest(request: InventoryApplyEquipmentIncidentActionRequest) {
    const action = request.choices.action;
    if (
      request.project !== this.scope.project ||
      request.inventoryId !== this.scope.inventoryId ||
      (this.initialFollowUp
        ? action.kind === 'report' ||
          action.kind !== this.initialFollowUp.kind ||
          action.incident.incidentId !== this.initialFollowUp.incident.incidentId ||
          action.incident.intentSha256 !== this.initialFollowUp.incident.intentSha256
        : action.kind !== 'report' || action.equipment.storageId !== this.equipmentId)
    )
      throw Error('This retained outage belongs to another equipment item, action or inventory.');
  }
  newAction() {
    if (
      this.snapshot.phase.kind !== 'recorded' &&
      !(
        this.snapshot.phase.kind === 'previewed' && this.snapshot.phase.preview.kind === 'no-change'
      )
    )
      return;
    this.invalidate();
    this.prepared = null;
    this.completed = null;
    const draft = {
      ...this.snapshot.draft,
      actionId: crypto.randomUUID(),
      reason: '',
      description: '',
      noticedTimeKnown: false,
      noticedTime: '',
      ...(this.initialFollowUp ? { followUp: structuredClone(this.initialFollowUp) } : {}),
    };
    try {
      this.retainDraft(draft);
      this.publish({ kind: 'editing' }, draft);
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  async preview(
    original?: InventoryEquipmentIncidentSummary | InventoryEquipmentIncidentActionSummary
  ) {
    if ((this.busy() || !this.writable) && !original) return;
    this.invalidate();
    const generation = this.generation,
      started = performance.now();
    try {
      this.retainDraft();
      const choices = original?.actionProof.choices ?? this.choices();
      this.publish({ kind: 'previewing' });
      const state = await this.client.inspect(this.scope);
      if (!this.current(generation)) return;
      const revision = state?.revision ?? 0;
      const preview = inventoryEquipmentIncidentActionPreviewSnapshotSchema.parse(
        await this.client.previewEquipmentIncidentAction({
          ...this.scope,
          expectedRevision: revision,
          choices,
        })
      );
      if (!this.current(generation)) return;
      if (
        preview.projectId !== this.scope.project ||
        preview.inventoryId !== this.scope.inventoryId ||
        preview.target.projectId !== this.scope.project ||
        preview.target.inventoryId !== this.scope.inventoryId ||
        (preview.kind === 'ready' && preview.revision !== revision) ||
        (this.principalKey !== null &&
          inventoryTableCanonicalJson(preview.principal) !== this.principalKey)
      )
        throw Error('The outage preview no longer matches this inventory.');
      if (preview.kind !== 'blocked') {
        this.assertProof(preview.record.actionProof, choices);
        if (
          preview.actionId !== preview.record.actionProof.actionId ||
          preview.intentSha256 !== preview.record.actionProof.intentSha256 ||
          preview.incidentId !== preview.record.incident.incidentId ||
          preview.record.kind !== choices.action.kind ||
          (preview.kind === 'ready' &&
            inventoryTableCanonicalJson(preview.effectCounts) !==
              inventoryTableCanonicalJson(preview.record.effectCounts))
        )
          throw Error('The preview pins and counts do not match the original outage action.');
      }
      if (original && preview.kind !== 'no-change')
        throw Error('The original outage could not be confirmed. No new report will be sent.');
      const delay =
        preview.nextBoundaryAt === null
          ? null
          : preview.nextBoundaryAt - preview.asOf - (performance.now() - started);
      if (preview.kind === 'ready' && delay !== null && delay <= 0)
        throw Error('The inventory changed while previewing. Preview again.');
      const request =
        preview.kind === 'ready'
          ? inventoryApplyEquipmentIncidentActionRequestSchema.parse({
              ...this.scope,
              kind: 'record-equipment-incident-action',
              expectedRevision: revision,
              operationId:
                this.prepared &&
                this.prepared.expectedRevision === revision &&
                this.prepared.expectedPlanDigest === preview.planDigest &&
                inventoryTableCanonicalJson(this.prepared.choices) ===
                  inventoryTableCanonicalJson(choices)
                  ? this.prepared.operationId
                  : this.operationId(),
              expectedPlanDigest: preview.planDigest,
              choices,
            })
          : undefined;
      this.prepared = request ?? null;
      this.retainDraft();
      this.publish({ kind: 'previewed', preview, ...(request ? { request } : {}) });
      if (delay !== null && delay > 0)
        this.boundary = setTimeout(
          () => {
            if (this.current(generation)) this.invalidate();
          },
          Math.min(delay, 2147483647)
        );
    } catch (cause) {
      if (this.current(generation)) this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  resume(attempt: InventoryAttempt) {
    if (!('kind' in attempt.request) || attempt.request.kind !== 'record-equipment-incident-action')
      throw Error('This saved request is not an equipment incident action.');
    const request = inventoryApplyEquipmentIncidentActionRequestSchema.parse(attempt.request);
    this.assertRequest(request);
    this.invalidate();
    const action = request.choices.action;
    const draft: EquipmentIncidentReportDraft = {
      ...this.snapshot.draft,
      actionId: request.choices.identity.actionId,
      namespace: request.choices.identity.namespace,
      reason: action.reason,
      ...(action.kind === 'report'
        ? {
            configurationRevision: action.equipment.configurationRevision,
            description: action.description,
            noticedTimeKnown: action.noticedAt !== null,
            noticedTime: action.noticedAt === null ? '' : new Date(action.noticedAt).toISOString(),
          }
        : { followUp: equipmentIncidentFollowUpDraft(action) }),
    };
    this.prepared = request;
    const phase: Phase = {
      kind: attempt.receipt ? 'accepted-read-pending' : 'unknown',
      attempt,
      message: 'Confirm this original incident action before starting another action.',
    };
    try {
      this.retainDraft(draft);
      this.publish(phase, draft);
    } catch (cause) {
      this.publish(
        { ...phase, message: `Keep the original pending request. ${message(cause)}` },
        draft
      );
    }
  }

  async submit() {
    const phase = this.snapshot.phase;
    if (
      !this.writable ||
      phase.kind !== 'previewed' ||
      phase.preview.kind !== 'ready' ||
      !phase.request
    )
      return;
    const attempt: InventoryAttempt = {
      request: phase.request,
      summary: equipmentIncidentDraftLabel(phase.request.choices.action.kind),
    };
    try {
      this.pending.retain(attempt);
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
      return;
    }
    await this.send(attempt);
  }
  private async exact(attempt: InventoryAttempt) {
    if (!('kind' in attempt.request) || attempt.request.kind !== 'record-equipment-incident-action')
      throw Error('This saved request is not an equipment incident action.');
    this.assertRequest(attempt.request);
    const choices = attempt.request.choices;
    const action = choices.action;
    const incident =
      action.kind === 'report'
        ? {
            incidentId: inventoryEquipmentIncidentActionId(choices.identity),
            intentSha256: inventoryEquipmentIncidentActionIntentSha256(choices),
          }
        : action.incident;
    const result = inventoryEquipmentIncidentReadSchema.parse(
      await this.client.equipmentIncident({ ...this.scope, ...incident })
    );
    if (result.kind !== 'available') throw Error(result.message);
    if (
      result.projectId !== this.scope.project ||
      result.inventoryId !== this.scope.inventoryId ||
      result.incident.id !== incident.incidentId ||
      result.incident.actionProof.intentSha256 !== incident.intentSha256
    )
      throw Error('The incident record belongs to another inventory or occurrence.');
    if (action.kind === 'report') {
      this.assertProof(result.incident.actionProof, choices);
      return { incident: result.incident };
    }
    const fact = inventoryEquipmentIncidentFactsReadSchema.parse(
      await this.client.equipmentIncidentFacts({
        ...this.scope,
        ...incident,
        query: {
          kind: 'fact',
          fact: {
            factId: inventoryEquipmentIncidentActionId(choices.identity),
            intentSha256: inventoryEquipmentIncidentActionIntentSha256(choices),
          },
        },
      })
    );
    if (fact.kind !== 'available')
      throw Error(
        fact.kind === 'unavailable' ? fact.message : 'The original action fact was not returned.'
      );
    if (
      fact.projectId !== this.scope.project ||
      fact.inventoryId !== this.scope.inventoryId ||
      fact.incident.incidentId !== incident.incidentId ||
      fact.incident.intentSha256 !== incident.intentSha256 ||
      !('choices' in fact.fact)
    )
      throw Error('The saved action belongs to another incident.');
    this.assertProof(fact.fact, choices);
    if (fact.fact.id !== inventoryEquipmentIncidentActionId(choices.identity))
      throw Error('The saved action identity does not match.');
    return {
      incident: result.incident,
      record: inventoryEquipmentIncidentActionSummary(fact.fact),
    };
  }
  private complete(
    attempt: InventoryAttempt,
    recorded: {
      incident: InventoryEquipmentIncidentSummary;
      record?: InventoryEquipmentIncidentActionSummary;
    },
    outcome: 'committed' | 'existing'
  ) {
    this.completed = { kind: 'recorded', outcome, ...recorded };
    this.retainDraft();
    this.pending.clear(this.pending.retain(attempt));
    this.publish(this.completed);
  }
  private async existing(attempt: InventoryAttempt) {
    const recorded = await this.exact(attempt);
    this.complete(attempt, recorded, 'existing');
  }
  private async committed(
    attempt: InventoryAttempt & { receipt: NonNullable<InventoryAttempt['receipt']> }
  ) {
    assertInventoryReceiptForAttempt(attempt, attempt.receipt);
    this.pending.confirm(this.pending.retain(attempt), attempt.receipt);
    this.publish({
      kind: 'accepted-read-pending',
      attempt,
      message: 'The incident action was recorded. Loading its original saved facts…',
    });
    try {
      const recorded = await this.exact(attempt);
      this.complete(attempt, recorded, 'committed');
    } catch (cause) {
      this.publish({
        kind: 'accepted-read-pending',
        attempt,
        message: `The incident action was recorded. ${message(cause)}`,
      });
    }
  }
  private async send(attempt: InventoryAttempt) {
    let release: (() => void) | undefined;
    try {
      const token = this.pending.retain(attempt);
      release = this.pending.acquire(token, 'send');
      this.publish({ kind: 'sending' });
      const result = await executeInventoryAcceptedRequest(this.client, attempt.request);
      if (result?.status === 'committed') await this.committed({ ...attempt, receipt: result });
      else if (
        result?.status === 'rejected' &&
        result.inventoryId === attempt.request.inventoryId &&
        result.operationId === attempt.request.operationId &&
        typeof result.code === 'string' &&
        typeof result.message === 'string'
      ) {
        if (result.code === 'INVENTORY_EQUIPMENT_INCIDENT_NO_CHANGES') await this.existing(attempt);
        else {
          this.pending.clear(token);
          this.publish({ kind: 'failed', message: result.message });
        }
      } else throw Error('The acknowledgement does not match the original outage request.');
    } catch (cause) {
      this.publish({
        kind: 'unknown',
        attempt,
        message: `Keep the original incident action. ${message(cause)}`,
      });
    } finally {
      release?.();
    }
  }
  async checkStatus() {
    const phase = this.snapshot.phase;
    if (phase.kind !== 'unknown' && phase.kind !== 'accepted-read-pending') return;
    const attempt = phase.attempt;
    let release: (() => void) | undefined;
    try {
      release = this.pending.acquire(this.pending.retain(attempt), 'inspect');
      if (attempt.receipt) {
        await this.committed({ ...attempt, receipt: attempt.receipt });
        return;
      }
      const receipt = await this.client.operation({
        ...this.scope,
        operationId: attempt.request.operationId,
      });
      if (receipt) await this.committed({ ...attempt, receipt });
      else await this.existing(attempt);
    } catch (cause) {
      this.publish({
        kind: attempt.receipt ? 'accepted-read-pending' : 'unknown',
        attempt,
        message: message(cause),
      });
    } finally {
      release?.();
    }
  }
  async retry() {
    const phase = this.snapshot.phase;
    if (phase.kind === 'unknown') await this.send(phase.attempt);
    else if (phase.kind === 'accepted-read-pending') await this.checkStatus();
  }
  detach() {
    this.active = false;
    ++this.generation;
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The outage report could not be confirmed.';
}

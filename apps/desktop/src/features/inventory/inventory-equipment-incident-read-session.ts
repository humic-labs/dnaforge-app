import {
  inventoryTableCanonicalJson,
  type InventoryEquipmentIncidentPin,
  type InventoryEquipmentIncidentFactPin,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryEquipmentIncidentsReadSchema,
  inventoryEquipmentIncidentReadSchema,
  inventoryEquipmentIncidentSubjectsReadSchema,
  inventoryEquipmentIncidentFactsReadSchema,
  type InventoryEquipmentIncidentsRead,
  type InventoryEquipmentIncidentRead,
  type InventoryEquipmentIncidentSubjectsRead,
  type InventoryEquipmentIncidentFactsRead,
} from '../../shared/inventory-equipment-incidents';
import type { EquipmentIncidentScope } from './inventory-equipment-incident-session';
type List = Extract<InventoryEquipmentIncidentsRead, { kind: 'ready' }>;
type Subjects = Extract<InventoryEquipmentIncidentSubjectsRead, { kind: 'ready' }>;
type Facts = Extract<InventoryEquipmentIncidentFactsRead, { kind: 'ready' }>;
type Fact = Extract<InventoryEquipmentIncidentFactsRead, { kind: 'available' }>;
type Idle = { kind: 'idle' | 'loading' };
type Failed = { kind: 'unavailable'; message: string };
export class InventoryEquipmentIncidentReadSession {
  private snapshot: {
    list: InventoryEquipmentIncidentsRead | { kind: 'loading' };
    listCursor: List['nextCursor'];
    detail: InventoryEquipmentIncidentRead | Idle;
    subjects: InventoryEquipmentIncidentSubjectsRead | Idle;
    view: 'initial' | 'current' | 'review';
    subjectCursor: Subjects['nextCursor'];
    facts: InventoryEquipmentIncidentFactsRead | Idle;
    factCursor: Facts['nextCursor'];
    fact: Fact | Idle | Failed;
    freshnessMaxAgeMs: number | null;
  } = {
    list: { kind: 'loading' },
    listCursor: null,
    detail: { kind: 'idle' },
    subjects: { kind: 'idle' },
    view: 'initial',
    subjectCursor: null,
    facts: { kind: 'idle' },
    factCursor: null,
    fact: { kind: 'idle' },
    freshnessMaxAgeMs: null,
  };
  private active = true;
  private generations = { list: 0, detail: 0, subjects: 0, facts: 0, fact: 0 };
  private pin: InventoryEquipmentIncidentPin | null = null;
  private factPin: InventoryEquipmentIncidentFactPin | null = null;
  private boundary: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private readonly client: InventoryClient,
    readonly scope: EquipmentIncidentScope,
    readonly equipmentId?: string
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(next: Partial<typeof this.snapshot>) {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  private valid(kind: keyof typeof this.generations, generation: number) {
    return this.active && this.generations[kind] === generation;
  }
  private samePin(value: InventoryEquipmentIncidentPin) {
    return (
      this.pin !== null &&
      inventoryTableCanonicalJson(value) === inventoryTableCanonicalJson(this.pin)
    );
  }
  private assertScope(value: { projectId: string; inventoryId: string }) {
    if (value.projectId !== this.scope.project || value.inventoryId !== this.scope.inventoryId)
      throw Error('The incident read belongs to another inventory.');
  }
  async open() {
    this.active = true;
    this.unsubscribe?.();
    this.unsubscribe = this.client.onChanged((event) => {
      if (event.projectId === this.scope.project && event.inventoryId === this.scope.inventoryId)
        void this.refresh();
    });
    await this.refresh();
  }
  async refresh() {
    const pin = this.pin,
      generation = this.generations.detail;
    await this.listPage(null);
    if (pin && this.active && this.samePin(pin) && generation === this.generations.detail)
      await this.select(pin);
  }
  async next() {
    const list = this.snapshot.list;
    if (list.kind === 'ready' && list.nextCursor) await this.listPage(list.nextCursor);
  }
  private async listPage(cursor: List['nextCursor']) {
    const generation = ++this.generations.list;
    this.set({ list: { kind: 'loading' }, listCursor: cursor });
    try {
      const result = inventoryEquipmentIncidentsReadSchema.parse(
        await this.client.equipmentIncidents({
          ...this.scope,
          ...(this.equipmentId ? { equipmentId: this.equipmentId } : {}),
          limit: 20,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!this.valid('list', generation)) return;
      if (result.kind === 'unavailable') {
        if (cursor && result.code === 'INVENTORY_QUERY_STALE') {
          await this.listPage(null);
          return;
        }
        this.set({ list: result });
        return;
      }
      this.assertScope(result);
      if (
        result.kind === 'ready' &&
        (result.incidents.length > 20 || (cursor && result.revision !== cursor.revision))
      )
        throw Error('The incident page does not match its requested boundary.');
      if (
        inventoryTableCanonicalJson(result.filters) !==
        inventoryTableCanonicalJson({ equipmentId: this.equipmentId ?? null, status: null })
      )
        throw Error('The incident list does not match this equipment filter.');
      this.set({ list: result });
    } catch (cause) {
      if (this.valid('list', generation))
        this.set({
          list: {
            kind: 'unavailable',
            code: 'EQUIPMENT_INCIDENTS_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
        });
    }
  }
  async select(pin: InventoryEquipmentIncidentPin) {
    const changed = !this.samePin(pin);
    this.pin = pin;
    if (changed) {
      this.factPin = null;
      this.set({ view: 'initial', fact: { kind: 'idle' } });
    }
    const generation = ++this.generations.detail;
    ++this.generations.subjects;
    ++this.generations.facts;
    ++this.generations.fact;
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
    this.set({
      detail: { kind: 'loading' },
      subjects: { kind: 'loading' },
      facts: { kind: 'loading' },
    });
    try {
      const result = inventoryEquipmentIncidentReadSchema.parse(
        await this.client.equipmentIncident({ ...this.scope, ...pin })
      );
      if (!this.valid('detail', generation) || !this.samePin(pin)) return;
      if (result.kind !== 'available') throw Error(result.message);
      this.assertScope(result);
      if (
        result.incident.id !== pin.incidentId ||
        result.incident.actionProof.intentSha256 !== pin.intentSha256
      )
        throw Error('The selected outage does not match the original report.');
      this.set({ detail: result });
      await Promise.all([
        this.subjectsPage(null),
        this.factsPage(null),
        ...(this.factPin ? [this.readFact(this.factPin)] : []),
      ]);
    } catch (cause) {
      if (this.valid('detail', generation))
        this.set({
          detail: {
            kind: 'unavailable',
            code: 'EQUIPMENT_INCIDENT_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
          subjects: { kind: 'idle' },
          facts: { kind: 'idle' },
        });
    }
  }
  async setView(view: 'initial' | 'current' | 'review') {
    this.set({ view });
    await this.subjectsPage(null);
  }
  async nextSubjects() {
    const value = this.snapshot.subjects;
    if (value.kind === 'ready' && value.nextCursor) await this.subjectsPage(value.nextCursor);
  }
  async firstSubjects() {
    await this.subjectsPage(null);
  }
  private async subjectsPage(cursor: Subjects['nextCursor']) {
    const pin = this.pin;
    if (!pin) return;
    const view = this.snapshot.view,
      policy = this.snapshot.freshnessMaxAgeMs,
      generation = ++this.generations.subjects;
    this.set({ subjects: { kind: 'loading' }, subjectCursor: cursor });
    try {
      const result = inventoryEquipmentIncidentSubjectsReadSchema.parse(
        await this.client.equipmentIncidentSubjects({
          ...this.scope,
          ...pin,
          view,
          freshnessMaxAgeMs: policy,
          limit: 20,
          ...(cursor ? { cursor } : {}),
        })
      );
      if (!this.valid('subjects', generation) || !this.samePin(pin)) return;
      if (result.kind === 'unavailable') {
        if (cursor && result.code === 'INVENTORY_QUERY_STALE') {
          await this.subjectsPage(null);
          return;
        }
        this.set({ subjects: result });
        return;
      }
      this.assertScope(result);
      if (
        !this.samePin(result.incident) ||
        result.view !== view ||
        result.freshnessMaxAgeMs !== policy ||
        result.subjects.length > 20 ||
        (cursor && result.revision !== cursor.revision) ||
        result.subjects.some((row) => row.view !== view)
      )
        throw Error('The contents page does not match this incident view.');
      this.set({ subjects: result });
    } catch (cause) {
      if (this.valid('subjects', generation))
        this.set({
          subjects: {
            kind: 'unavailable',
            code: 'EQUIPMENT_INCIDENT_SUBJECTS_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
        });
    }
  }
  async nextFacts() {
    const value = this.snapshot.facts;
    if (value.kind === 'ready' && value.nextCursor) await this.factsPage(value.nextCursor);
  }
  async firstFacts() {
    await this.factsPage(null);
  }
  private async factsPage(cursor: Facts['nextCursor']) {
    const pin = this.pin;
    if (!pin) return;
    const policy = this.snapshot.freshnessMaxAgeMs,
      generation = ++this.generations.facts;
    this.set({ facts: { kind: 'loading' }, factCursor: cursor });
    try {
      const result = inventoryEquipmentIncidentFactsReadSchema.parse(
        await this.client.equipmentIncidentFacts({
          ...this.scope,
          ...pin,
          query: {
            kind: 'page',
            freshnessMaxAgeMs: policy,
            limit: 20,
            ...(cursor ? { cursor } : {}),
          },
        })
      );
      if (!this.valid('facts', generation) || !this.samePin(pin)) return;
      if (result.kind === 'unavailable') {
        if (cursor && result.code === 'INVENTORY_QUERY_STALE') {
          await this.factsPage(null);
          return;
        }
        this.set({ facts: result });
        return;
      }
      if (result.kind !== 'ready') throw Error('Expected an incident history page.');
      this.assertScope(result);
      if (
        !this.samePin(result.incident) ||
        result.query.kind !== 'page' ||
        result.query.factKind !== null ||
        result.query.freshnessMaxAgeMs !== policy ||
        result.facts.length > 20 ||
        (cursor && result.revision !== cursor.revision)
      )
        throw Error('The history page does not match this incident or policy.');
      this.set({ facts: result });
    } catch (cause) {
      if (this.valid('facts', generation))
        this.set({
          facts: {
            kind: 'unavailable',
            code: 'EQUIPMENT_INCIDENT_FACTS_UNAVAILABLE',
            message: message(cause),
            retryable: true,
          },
        });
    }
  }
  async setFreshness(policy: number | null) {
    if (policy !== null && (!Number.isSafeInteger(policy) || policy < 0)) return;
    this.set({ freshnessMaxAgeMs: policy });
    const pin = this.factPin;
    await Promise.all([
      this.factsPage(null),
      this.subjectsPage(null),
      ...(pin ? [this.readFact(pin)] : []),
    ]);
  }
  async readFact(fact: InventoryEquipmentIncidentFactPin) {
    const pin = this.pin;
    if (!pin) return;
    this.factPin = fact;
    const policy = this.snapshot.freshnessMaxAgeMs,
      generation = ++this.generations.fact,
      started = performance.now();
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
    this.set({ fact: { kind: 'loading' } });
    try {
      const result = inventoryEquipmentIncidentFactsReadSchema.parse(
        await this.client.equipmentIncidentFacts({
          ...this.scope,
          ...pin,
          query: { kind: 'fact', fact, freshnessMaxAgeMs: policy },
        })
      );
      if (!this.valid('fact', generation) || !this.samePin(pin)) return;
      if (result.kind !== 'available')
        throw Error(
          result.kind === 'unavailable' ? result.message : 'Expected one exact incident fact.'
        );
      this.assertScope(result);
      if (
        !this.samePin(result.incident) ||
        result.fact.id !== fact.factId ||
        result.fact.intentSha256 !== fact.intentSha256 ||
        result.freshnessMaxAgeMs !== policy
      )
        throw Error('The incident fact does not match the selected original fact.');
      if (
        result.manual &&
        (inventoryTableCanonicalJson(result.manual.fact) !==
          inventoryTableCanonicalJson(result.fact) ||
          result.manual.asOf !== result.asOf ||
          result.manual.maxAgeMs !== policy)
      )
        throw Error('The temperature assessment does not match this exact selected fact.');
      this.set({ fact: result });
      if (result.nextBoundaryAt !== null) {
        const delay = result.nextBoundaryAt - result.asOf - (performance.now() - started);
        this.boundary = setTimeout(
          () => {
            if (this.valid('fact', generation)) void this.readFact(fact);
          },
          Math.min(Math.max(0, delay), 2147483647)
        );
      }
    } catch (cause) {
      if (this.valid('fact', generation))
        this.set({ fact: { kind: 'unavailable', message: message(cause) } });
    }
  }
  dispose() {
    this.active = false;
    for (const key of Object.keys(this.generations) as (keyof typeof this.generations)[])
      ++this.generations[key];
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Equipment incident evidence is unavailable.';
}

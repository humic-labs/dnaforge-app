export type PresentationInput = 'keyboard' | 'pointer' | 'presentation';
export type PresentationCapture = 'none' | 'keyboard' | 'modal';
export interface PresentationSurfaceState {
  parentId: string | null;
  status: 'active' | 'suspended';
  capture: PresentationCapture;
  generation: number;
  lastFocusId?: string;
  returnFocusId?: string | null;
}
export interface PresentationState {
  surfaces: Readonly<Record<string, PresentationSurfaceState>>;
  overlays: readonly string[];
  focusId: string | null;
  revision: number;
  keyboardRevision: number;
  pointerRevision: number;
  focusIntentRevision: number;
}
export type PresentationEvent =
  | { type: 'attach'; id: string; parentId: string; active: boolean; capture?: PresentationCapture }
  | { type: 'invalidate' }
  | { type: 'focus'; id: string; inputIntent?: boolean }
  | { type: 'activate' | 'suspend' | 'detach' | 'dispose' | 'blur'; id: string };
export interface PresentationLease {
  surfaceId: string;
  input: PresentationInput;
  inputRevision: number;
  focusIntentRevision?: number;
  lineage: ReadonlyArray<{ id: string; generation: number }>;
}

function branch(state: PresentationState, id: string, activeOnly = true): string[] {
  const result: string[] = [];
  let current: string | null = id;
  while (current !== null) {
    const surface: PresentationSurfaceState | undefined = state.surfaces[current];
    if (!surface || (activeOnly && surface.status !== 'active') || result.includes(current))
      return [];
    result.push(current);
    current = surface.parentId;
  }
  return result.at(-1) === 'window' ? result : [];
}

export function presentationAllows(
  state: PresentationState,
  id: string,
  input: PresentationInput
): boolean {
  const lineage = branch(state, id);
  if (!lineage.length) return false;
  if (input === 'presentation') return true;
  const overlay = [...state.overlays].reverse().find((candidate) => {
    const capture = state.surfaces[candidate]?.capture;
    return branch(state, candidate).length > 0 && (input === 'keyboard' || capture === 'modal');
  });
  if (overlay) return lineage.includes(overlay);
  if (input === 'pointer') return true;
  if (!state.focusId) return id === 'window';
  const focus = branch(state, state.focusId);
  return focus.length ? focus.includes(id) || lineage.includes(state.focusId) : id === 'window';
}

export function presentationAllowsFocus(state: PresentationState, id: string): boolean {
  const lineage = branch(state, id);
  if (!lineage.length) return false;
  const overlay = [...state.overlays]
    .reverse()
    .find((candidate) => branch(state, candidate).length > 0);
  return overlay ? lineage.includes(overlay) : true;
}

function reducePresentation(
  state: PresentationState,
  event: Exclude<PresentationEvent, { type: 'invalidate' }>
): PresentationState {
  const current = state.surfaces[event.id];
  if (event.type === 'blur') {
    if (!state.focusId || !branch(state, state.focusId, false).includes(event.id)) return state;
    const surfaces = { ...state.surfaces };
    for (const id of branch(state, state.focusId, false)) {
      const { lastFocusId: _lastFocusId, ...surface } = surfaces[id];
      surfaces[id] = surface;
    }
    return { ...state, surfaces, focusId: null, revision: state.revision + 1 };
  }
  if (event.type === 'focus') {
    if (!branch(state, event.id).length) return state;
    if (state.focusId === event.id)
      return event.inputIntent ? { ...state, revision: state.revision + 1 } : state;
    if (!presentationAllows(state, event.id, 'pointer')) {
      const overlayId = [...state.overlays].reverse().find((id) => branch(state, id).length > 0);
      const overlay = overlayId ? state.surfaces[overlayId] : undefined;
      if (!overlayId || !overlay || overlay.returnFocusId) return state;
      return {
        ...state,
        surfaces: { ...state.surfaces, [overlayId]: { ...overlay, returnFocusId: event.id } },
        revision: state.revision + 1,
      };
    }
    const surfaces = { ...state.surfaces };
    for (const id of branch(state, event.id))
      surfaces[id] = { ...surfaces[id], lastFocusId: event.id };
    return { ...state, surfaces, focusId: event.id, revision: state.revision + 1 };
  }
  if (event.type === 'detach' || event.type === 'dispose') {
    if (!current || event.id === 'window') return state;
    const surfaces = { ...state.surfaces };
    const removed = new Set([event.id]);
    let changed = event.type === 'dispose';
    while (changed) {
      changed = false;
      for (const [id, surface] of Object.entries(surfaces)) {
        if (surface.parentId && removed.has(surface.parentId) && !removed.has(id)) {
          removed.add(id);
          changed = true;
        }
      }
    }
    for (const id of removed) delete surfaces[id];
    const losesFocus =
      state.focusId !== null && branch(state, state.focusId, false).includes(event.id);
    const next = {
      ...state,
      surfaces,
      overlays: state.overlays.filter((id) => !removed.has(id)),
      focusId: losesFocus ? null : state.focusId,
      revision: state.revision + 1,
    };
    if (
      (!state.focusId || losesFocus) &&
      current.returnFocusId &&
      presentationAllows(next, current.returnFocusId, 'pointer')
    ) {
      next.focusId = current.returnFocusId;
    }
    return next;
  }
  const surface: PresentationSurfaceState =
    event.type === 'attach'
      ? {
          parentId: event.parentId,
          status: event.active ? 'active' : 'suspended',
          capture: event.capture ?? 'none',
          generation: state.revision + 1,
          returnFocusId: state.focusId,
        }
      : current
        ? {
            ...current,
            status: event.type === 'activate' ? 'active' : 'suspended',
            returnFocusId:
              event.type === 'activate' && current.status === 'suspended'
                ? state.focusId
                : current.returnFocusId,
            generation: state.revision + 1,
          }
        : { parentId: null, status: 'suspended', capture: 'none', generation: state.revision + 1 };
  if (event.type !== 'attach' && !current) return state;
  if (
    current?.parentId === surface.parentId &&
    current.status === surface.status &&
    current.capture === surface.capture
  )
    return state;
  const overlays = state.overlays.filter((id) => id !== event.id);
  if (surface.status === 'active' && surface.capture !== 'none') overlays.push(event.id);
  const next = {
    ...state,
    surfaces: { ...state.surfaces, [event.id]: surface },
    overlays,
    revision: state.revision + 1,
  };
  if (
    surface.status === 'suspended' &&
    next.focusId &&
    branch(next, next.focusId, false).includes(event.id) &&
    surface.returnFocusId &&
    presentationAllows(next, surface.returnFocusId, 'pointer')
  ) {
    next.focusId = surface.returnFocusId;
  }
  if (
    surface.status === 'active' &&
    surface.lastFocusId &&
    (!next.focusId || !branch(next, next.focusId).length) &&
    presentationAllows(next, surface.lastFocusId, 'pointer')
  ) {
    next.focusId = surface.lastFocusId;
  }
  return next;
}

function activeCaptures(state: PresentationState, input: 'keyboard' | 'pointer'): string {
  return JSON.stringify(
    state.overlays.filter(
      (id) =>
        branch(state, id).length > 0 &&
        (input === 'keyboard' || state.surfaces[id].capture === 'modal')
    )
  );
}

export function transitionPresentation(
  state: PresentationState,
  event: PresentationEvent
): PresentationState {
  if (event.type === 'invalidate')
    return {
      ...state,
      revision: state.revision + 1,
      keyboardRevision: state.keyboardRevision + 1,
      pointerRevision: state.pointerRevision + 1,
      focusIntentRevision: state.focusIntentRevision + 1,
    };
  const next = reducePresentation(state, event);
  if (next === state) return state;
  return {
    ...next,
    keyboardRevision:
      state.keyboardRevision +
      Number(
        state.focusId !== next.focusId ||
          activeCaptures(state, 'keyboard') !== activeCaptures(next, 'keyboard')
      ),
    focusIntentRevision:
      state.focusIntentRevision + Number(event.type === 'focus' && event.inputIntent === true),
    pointerRevision:
      state.pointerRevision +
      Number(activeCaptures(state, 'pointer') !== activeCaptures(next, 'pointer')),
  };
}

function capturePresentation(
  state: PresentationState,
  surfaceId: string,
  input: PresentationInput
): PresentationLease | null {
  if (!presentationAllows(state, surfaceId, input)) return null;
  return {
    surfaceId,
    input,
    inputRevision:
      input === 'keyboard'
        ? state.keyboardRevision
        : input === 'pointer'
          ? state.pointerRevision
          : 0,
    lineage: branch(state, surfaceId).map((id) => ({
      id,
      generation: state.surfaces[id].generation,
    })),
  };
}

export class PresentationOwner {
  private state: PresentationState = {
    surfaces: { window: { parentId: null, status: 'active', capture: 'none', generation: 0 } },
    overlays: [],
    focusId: null,
    revision: 0,
    keyboardRevision: 0,
    pointerRevision: 0,
    focusIntentRevision: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly eventStates = new WeakMap<object, PresentationState>();
  getSnapshot = (event?: object): PresentationState => {
    if (!event) return this.state;
    const state = this.eventStates.get(event) ?? this.state;
    this.eventStates.set(event, state);
    return state;
  };
  allowsEvent = (id: string, input: PresentationInput, event: object): boolean =>
    this.isCurrent(capturePresentation(this.getSnapshot(event), id, input));
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispatch = (event: PresentationEvent): void => {
    const next = transitionPresentation(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  };
  allows = (id: string, input: PresentationInput): boolean =>
    presentationAllows(this.state, id, input);
  allowsFocus = (id: string): boolean => presentationAllowsFocus(this.state, id);
  capture = (surfaceId: string, input: PresentationInput): PresentationLease | null =>
    capturePresentation(this.state, surfaceId, input);
  captureFocus = (surfaceId: string): PresentationLease | null => {
    const lease = this.capture(surfaceId, 'keyboard');
    return lease ? { ...lease, focusIntentRevision: this.state.focusIntentRevision } : null;
  };
  isCurrent = (lease: PresentationLease | null): boolean =>
    lease !== null &&
    (lease.focusIntentRevision === undefined ||
      lease.focusIntentRevision === this.state.focusIntentRevision) &&
    lease.inputRevision ===
      (lease.input === 'keyboard'
        ? this.state.keyboardRevision
        : lease.input === 'pointer'
          ? this.state.pointerRevision
          : 0) &&
    lease.lineage.every(
      ({ id, generation }) => this.state.surfaces[id]?.generation === generation
    ) &&
    this.allows(lease.surfaceId, lease.input);
}

export const presentationOwner = new PresentationOwner();

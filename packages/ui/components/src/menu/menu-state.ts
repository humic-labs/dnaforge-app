export interface MenuItem {
  id: string;
  textValue: string;
  disabled?: boolean;
  submenuId?: string;
  closeOnActivate?: boolean;
}

export type MenuCloseReason =
  | 'escape'
  | 'trigger'
  | 'selection'
  | 'outside-pointer'
  | 'tab'
  | 'window-blur'
  | 'anchor-lost'
  | 'owner-revoked'
  | 'handoff'
  | 'unmount';

export type MenuCollections = Readonly<Record<string, readonly MenuItem[]>>;
export type MenuDirection = 'next' | 'previous' | 'first' | 'last';
export interface MenuMoveOptions {
  wrap?: boolean;
  itemIds?: readonly string[];
}
export interface MenuLevel {
  menuId: string;
  activeId: string | null;
}

export interface MenuState {
  phase: 'closed' | 'positioning' | 'open';
  session: number;
  levels: readonly MenuLevel[];
  intent:
    | { phase: 'idle' }
    | { phase: 'waiting'; request: number; menuId: string; candidateId: string | null };
  closeReason: MenuCloseReason | null;
}

export type MenuEvent =
  | { type: 'open'; menuId: string; preferredId?: string | null }
  | ({ session: number } & (
      | { type: 'positioned' | 'reconcile' | 'intent-cancel' }
      | { type: 'submenu-open' | 'submenu-close'; menuId?: string }
      | ({ type: 'move'; direction: MenuDirection; menuId?: string } & MenuMoveOptions)
      | { type: 'point' | 'activate'; menuId: string; itemId: string }
      | { type: 'intent'; menuId: string; candidateId: string | null; request: number }
      | { type: 'intent-resolve'; request: number }
      | { type: 'close'; reason: MenuCloseReason }
    ));

export type MenuEffect =
  | { type: 'invoke'; session: number; menuId: string; itemId: string }
  | { type: 'close'; reason: MenuCloseReason }
  | { type: 'focus-item'; menuId: string; itemId: string }
  | { type: 'cancel-intent' };

export interface MenuTransition {
  state: MenuState;
  effects: readonly MenuEffect[];
}

export function createMenuState(): MenuState {
  return { phase: 'closed', session: 0, levels: [], intent: { phase: 'idle' }, closeReason: null };
}

export function menuShouldRestoreFocus(reason: MenuCloseReason): boolean {
  return reason === 'escape' || reason === 'trigger' || reason === 'selection';
}

function enabled(collections: MenuCollections, menuId: string): readonly MenuItem[] {
  return (collections[menuId] ?? []).filter((item) => !item.disabled);
}

function focusItem(level: MenuLevel | undefined): MenuEffect[] {
  return level?.activeId !== null && level?.activeId !== undefined
    ? [{ type: 'focus-item', menuId: level.menuId, itemId: level.activeId }]
    : [];
}

function close(state: MenuState, reason: MenuCloseReason): MenuTransition {
  return {
    state: {
      ...state,
      phase: 'closed',
      levels: [],
      intent: { phase: 'idle' },
      closeReason: reason,
    },
    effects: [{ type: 'cancel-intent' }, { type: 'close', reason }],
  };
}

function point(
  state: MenuState,
  menuId: string,
  itemId: string | null,
  collections: MenuCollections
): MenuState {
  const index = state.levels.findIndex((level) => level.menuId === menuId);
  if (index < 0) return state;
  const item = enabled(collections, menuId).find((candidate) => candidate.id === itemId);
  if (itemId !== null && !item) return state;
  const levels = state.levels.slice(0, index + 1);
  levels[index] = { menuId, activeId: itemId };
  if (
    item?.submenuId &&
    collections[item.submenuId] &&
    !levels.some((level) => level.menuId === item.submenuId)
  )
    levels.push({ menuId: item.submenuId, activeId: null });
  return { ...state, levels, intent: { phase: 'idle' } };
}

export function transitionMenu(
  state: MenuState,
  event: MenuEvent,
  collections: MenuCollections
): MenuTransition {
  const unchanged = { state, effects: [] };
  if (event.type === 'open') {
    const items = enabled(collections, event.menuId);
    const activeId =
      items.find((item) => item.id === event.preferredId)?.id ?? items[0]?.id ?? null;
    return {
      state: {
        phase: 'positioning',
        session: state.session + 1,
        levels: [{ menuId: event.menuId, activeId }],
        intent: { phase: 'idle' },
        closeReason: null,
      },
      effects: [{ type: 'cancel-intent' }],
    };
  }
  if (state.phase === 'closed' || event.session !== state.session) return unchanged;
  if (event.type === 'close') return close(state, event.reason);
  if (event.type === 'positioned')
    return state.phase === 'positioning'
      ? {
          state: { ...state, phase: 'open' },
          effects: focusItem(state.levels[state.levels.length - 1]),
        }
      : unchanged;
  if (event.type === 'reconcile') {
    const levels: MenuLevel[] = [];
    for (const level of state.levels) {
      const parent = levels[levels.length - 1];
      if (
        parent &&
        !enabled(collections, parent.menuId).some(
          (item) => item.id === parent.activeId && item.submenuId === level.menuId
        )
      )
        break;
      if (!collections[level.menuId]) break;
      const items = enabled(collections, level.menuId);
      levels.push({
        menuId: level.menuId,
        activeId:
          level.activeId === null && levels.length > 0
            ? null
            : (items.find((item) => item.id === level.activeId)?.id ?? items[0]?.id ?? null),
      });
    }
    const intent = state.intent;
    const validIntent =
      intent.phase === 'idle' ||
      (levels.some((level) => level.menuId === intent.menuId) &&
        (intent.candidateId === null ||
          enabled(collections, intent.menuId).some((item) => item.id === intent.candidateId)));
    if (
      levels.length === state.levels.length &&
      levels.every((level, index) => level.activeId === state.levels[index]?.activeId) &&
      validIntent
    )
      return unchanged;
    return {
      state: { ...state, levels, intent: validIntent ? intent : { phase: 'idle' } },
      effects: [
        ...(validIntent ? [] : [{ type: 'cancel-intent' as const }]),
        ...(levels.length !== state.levels.length ||
        levels[levels.length - 1]?.activeId !== state.levels[state.levels.length - 1]?.activeId
          ? focusItem(levels[levels.length - 1])
          : []),
      ],
    };
  }
  if (event.type === 'intent-cancel')
    return { state: { ...state, intent: { phase: 'idle' } }, effects: [{ type: 'cancel-intent' }] };
  if (event.type === 'intent') {
    if (
      !state.levels.some((level) => level.menuId === event.menuId) ||
      (event.candidateId !== null &&
        !enabled(collections, event.menuId).some((item) => item.id === event.candidateId))
    )
      return unchanged;
    return {
      state: {
        ...state,
        intent: {
          phase: 'waiting',
          menuId: event.menuId,
          candidateId: event.candidateId,
          request: event.request,
        },
      },
      effects: [],
    };
  }
  if (event.type === 'intent-resolve') {
    if (state.intent.phase !== 'waiting' || state.intent.request !== event.request)
      return unchanged;
    const next = point(state, state.intent.menuId, state.intent.candidateId, collections);
    return { state: { ...next, intent: { phase: 'idle' } }, effects: [{ type: 'cancel-intent' }] };
  }
  if (event.type === 'point') {
    const next = point(state, event.menuId, event.itemId, collections);
    return next === state ? unchanged : { state: next, effects: [{ type: 'cancel-intent' }] };
  }
  const levelIndex =
    'menuId' in event && event.menuId
      ? state.levels.findIndex((level) => level.menuId === event.menuId)
      : state.levels.length - 1;
  const current = state.levels[levelIndex];
  if (!current) return unchanged;
  if (event.type === 'move') {
    const available = enabled(collections, current.menuId);
    const items = event.itemIds
      ? event.itemIds.flatMap((id) => available.filter((item) => item.id === id))
      : available;
    const index = items.findIndex((item) => item.id === current.activeId);
    const step = event.direction === 'next' ? 1 : -1;
    const next =
      event.direction === 'first'
        ? 0
        : event.direction === 'last'
          ? items.length - 1
          : event.wrap && items.length > 0
            ? (index + step + items.length) % items.length
            : Math.max(0, Math.min(items.length - 1, index + step));
    return {
      state: {
        ...state,
        levels: [
          ...state.levels.slice(0, levelIndex),
          { ...current, activeId: items[next]?.id ?? null },
        ],
        intent: { phase: 'idle' },
      },
      effects: [
        { type: 'cancel-intent' },
        ...focusItem({ ...current, activeId: items[next]?.id ?? null }),
      ],
    };
  }
  if (event.type === 'submenu-close') {
    const parent = state.levels[levelIndex - 1];
    if (!parent) return unchanged;
    return {
      state: { ...state, levels: state.levels.slice(0, levelIndex), intent: { phase: 'idle' } },
      effects: [
        { type: 'cancel-intent' },
        ...(parent.activeId !== null
          ? [{ type: 'focus-item' as const, menuId: parent.menuId, itemId: parent.activeId }]
          : []),
      ],
    };
  }
  const menuId = event.type === 'activate' ? event.menuId : current.menuId;
  const itemId = event.type === 'activate' ? event.itemId : current.activeId;
  if (!state.levels.some((level) => level.menuId === menuId)) return unchanged;
  const item = enabled(collections, menuId).find((candidate) => candidate.id === itemId);
  if (!item) return unchanged;
  if (item.submenuId) {
    if (
      !collections[item.submenuId] ||
      state.levels.slice(0, levelIndex + 1).some((level) => level.menuId === item.submenuId)
    )
      return unchanged;
    const index = state.levels.findIndex((level) => level.menuId === menuId);
    const childId = enabled(collections, item.submenuId)[0]?.id ?? null;
    return {
      state: {
        ...state,
        levels: [
          ...state.levels.slice(0, index),
          { menuId, activeId: item.id },
          { menuId: item.submenuId, activeId: childId },
        ],
        intent: { phase: 'idle' },
      },
      effects: [
        { type: 'cancel-intent' },
        ...(childId !== null
          ? [{ type: 'focus-item' as const, menuId: item.submenuId, itemId: childId }]
          : []),
      ],
    };
  }
  if (event.type !== 'activate') return unchanged;
  const next = item.closeOnActivate === false ? { state, effects: [] } : close(state, 'selection');
  return {
    state: next.state,
    effects: [...next.effects, { type: 'invoke', session: state.session, menuId, itemId: item.id }],
  };
}

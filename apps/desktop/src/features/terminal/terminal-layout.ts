export function terminalPaneSizes(
  ids: string[],
  saved?: Record<string, number>
): Record<string, number> {
  const values = ids.map((id) => {
    const value = saved?.[id];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : 100 / ids.length;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(ids.map((id, index) => [id, (values[index]! * 100) / total]));
}
export interface TerminalGroup {
  id: string;
  sessions: string[];
  viewId?: string;
  placement?: 'panel' | 'editor';
  direction?: 'horizontal' | 'vertical';
  sizes?: Record<string, number>;
}

export type TerminalPresentation = 'tabs' | 'sessions' | 'panel';
export const TERMINAL_WORKSPACE_TAB_ID = 'terminal-workspace';

export function terminalGroupViewId(group: TerminalGroup): string {
  return group.viewId || group.id;
}

export function migrateTerminalGroupViews(
  groups: TerminalGroup[],
  previous: TerminalPresentation | 'workspace' = 'tabs',
  floatingWindow = false
): TerminalGroup[] {
  return groups.map((group) => ({
    ...group,
    viewId: group.viewId || (previous === 'sessions' ? TERMINAL_WORKSPACE_TAB_ID : group.id),
    placement: floatingWindow
      ? 'panel'
      : (group.placement ?? (previous === 'panel' ? 'panel' : 'editor')),
  }));
}

export function moveTerminalGroupToView(
  groups: TerminalGroup[],
  sessionId: string,
  viewId: string
): TerminalGroup[] {
  return groups.map((group) =>
    group.sessions.includes(sessionId) ? { ...group, viewId, placement: 'editor' } : group
  );
}

export const TERMINAL_DRAG_TYPE = 'application/x-dnaforge-terminal';
export const TERMINAL_PANE_MINIMUM_PX = 80;

export function resizeTerminalPaneSizes(
  ids: string[],
  saved: Record<string, number>,
  id: string,
  backward: boolean,
  pixels: number,
  availablePixels: number
): Record<string, number> | null {
  const index = ids.indexOf(id);
  if (
    index < 0 ||
    ids.length < 2 ||
    !Number.isFinite(pixels) ||
    pixels <= 0 ||
    !Number.isFinite(availablePixels) ||
    availablePixels < ids.length * TERMINAL_PANE_MINIMUM_PX
  )
    return null;
  const sizes = terminalPaneSizes(ids, saved);
  const last = index === ids.length - 1;
  const neighbor = ids[last ? index - 1 : index + 1];
  if (neighbor === undefined) return null;
  const currentSize = sizes[id] ?? 0;
  const neighborSize = sizes[neighbor] ?? 0;
  const minimum = (TERMINAL_PANE_MINIMUM_PX * 100) / availablePixels;
  const requested = ((pixels * 100) / availablePixels) * (backward === last ? 1 : -1);
  const delta = Math.max(minimum - currentSize, Math.min(neighborSize - minimum, requested));
  if (Math.abs(delta) < 0.000001) return null;
  return { ...sizes, [id]: currentSize + delta, [neighbor]: neighborSize - delta };
}

export function splitTerminalPane(
  groups: TerminalGroup[],
  parentId: string,
  sessionId: string
): TerminalGroup[] {
  const parent = groups.find((group) => group.sessions.includes(parentId));
  if (!parent || groups.some((group) => group.sessions.includes(sessionId))) return groups;
  const sessions = [...parent.sessions];
  sessions.splice(sessions.indexOf(parentId) + 1, 0, sessionId);
  return groups.map((group) =>
    group === parent ? { ...group, sessions, sizes: terminalPaneSizes(sessions) } : group
  );
}

export function reorderTerminalGroups(
  groups: TerminalGroup[],
  sourceId: string,
  targetId: string,
  side: 'before' | 'after' = 'before'
): TerminalGroup[] {
  const source = groups.find((group) => group.sessions.includes(sourceId));
  const target = groups.find((group) => group.sessions.includes(targetId));
  if (!source || !target) return groups;
  if (source === target) return moveTerminalPane(groups, sourceId, targetId, side);
  const result = groups.filter((group) => group !== source);
  result.splice(result.indexOf(target) + (side === 'after' ? 1 : 0), 0, source);
  return result;
}

export function moveTerminalPane(
  groups: TerminalGroup[],
  sourceId: string,
  targetId: string,
  side: 'before' | 'after'
): TerminalGroup[] {
  const source = groups.find((group) => group.sessions.includes(sourceId));
  const target = groups.find((group) => group.sessions.includes(targetId));
  if (!source || !target || sourceId === targetId) return groups;
  return groups.flatMap((group) => {
    if (group !== source && group !== target) return [group];
    const sessions = group.sessions.filter((id) => id !== sourceId);
    if (group === target)
      sessions.splice(sessions.indexOf(targetId) + (side === 'after' ? 1 : 0), 0, sourceId);
    return sessions.length
      ? [{ ...group, sessions, sizes: terminalPaneSizes(sessions, group.sizes) }]
      : [];
  });
}

export function unsplitTerminalPane(
  groups: TerminalGroup[],
  id: string,
  groupId: string
): TerminalGroup[] {
  const source = groups.find((group) => group.sessions.includes(id));
  if (!source || source.sessions.length < 2 || groups.some((group) => group.id === groupId))
    return groups;
  return [
    ...groups.map((group) => {
      if (group !== source) return group;
      const sessions = group.sessions.filter((entry) => entry !== id);
      return { ...group, sessions, sizes: terminalPaneSizes(sessions, group.sizes) };
    }),
    {
      id: groupId,
      sessions: [id],
      placement: source.placement ?? 'panel',
      ...(source.viewId ? { viewId: source.viewId } : {}),
      ...(source.direction ? { direction: source.direction } : {}),
    },
  ];
}

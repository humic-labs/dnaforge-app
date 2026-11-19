export interface TerminalListGroup {
  id: string;
  name: string;
  collapsed: boolean;
  sessions: string[];
}

export type TerminalListEntry = string | TerminalListGroup;

export function normalizeSessionList(value: unknown, sessionIds: string[]): TerminalListEntry[] {
  const remaining = new Set(sessionIds);
  const groupIds = new Set<string>();
  const entries: TerminalListEntry[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === 'string') {
      if (remaining.delete(item)) entries.push(item);
    } else if (
      item &&
      typeof item.id === 'string' &&
      !groupIds.has(item.id) &&
      typeof item.name === 'string' &&
      item.name.trim() &&
      Array.isArray(item.sessions)
    ) {
      groupIds.add(item.id);
      entries.push({
        id: item.id,
        name: item.name,
        collapsed: item.collapsed === true,
        sessions: item.sessions.filter(
          (id: unknown) => typeof id === 'string' && remaining.delete(id)
        ),
      });
    }
  }
  return [...entries, ...remaining];
}

export function moveListSession(
  entries: TerminalListEntry[],
  sessionId: string,
  groupId: string | null,
  anchor?: string,
  side: 'before' | 'after' = 'after'
): TerminalListEntry[] {
  if (
    anchor === sessionId ||
    (groupId && !entries.some((item) => typeof item !== 'string' && item.id === groupId))
  )
    return entries;
  const result = entries
    .filter((item) => item !== sessionId)
    .map((item) =>
      typeof item === 'string'
        ? item
        : { ...item, sessions: item.sessions.filter((id) => id !== sessionId) }
    );
  const group = result.find(
    (item): item is TerminalListGroup => typeof item !== 'string' && item.id === groupId
  );
  const target = group ? group.sessions : result;
  const index = anchor ? target.indexOf(anchor) : -1;
  target.splice(index < 0 ? target.length : index + Number(side === 'after'), 0, sessionId);
  return result;
}

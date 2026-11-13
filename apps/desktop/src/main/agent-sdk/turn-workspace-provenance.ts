import { toolCallGroundsWorkspace } from './required-workspace-tools';

export interface TurnWorkspaceProvenance {
  completedWorkspaceTools: string[];
  completedWorkspaceResources: string[];
  grounded: boolean;
}

interface TurnWorkspaceReads {
  completedTools: string[];
  tools: string[];
  resources: string[];
}

const workspaceReadsByTurn = new Map<string, TurnWorkspaceReads>();
const openProvenanceTurns = new Set<string>();

const MAX_TRACKED_TURNS = 512;

export function openWorkspaceProvenanceForTurn(turnId: string): void {
  if (openProvenanceTurns.has(turnId)) return;
  if (openProvenanceTurns.size >= MAX_TRACKED_TURNS) {
    const oldest = openProvenanceTurns.values().next().value;
    if (oldest !== undefined) {
      openProvenanceTurns.delete(oldest);
      workspaceReadsByTurn.delete(oldest);
    }
  }
  workspaceReadsByTurn.delete(turnId);
  openProvenanceTurns.add(turnId);
}

export function recordCompletedToolCall(
  turnId: string | undefined,
  toolName: string,
  rawArgs: unknown = undefined
): void {
  if (!turnId || !openProvenanceTurns.has(turnId)) return;

  if (!workspaceReadsByTurn.has(turnId) && workspaceReadsByTurn.size >= MAX_TRACKED_TURNS) {
    const oldest = workspaceReadsByTurn.keys().next().value;
    if (oldest !== undefined) workspaceReadsByTurn.delete(oldest);
  }

  const existing = workspaceReadsByTurn.get(turnId) ?? {
    completedTools: [],
    tools: [],
    resources: [],
  };
  existing.completedTools.push(toolName);
  if (toolCallGroundsWorkspace(toolName, rawArgs)) existing.tools.push(toolName);
  workspaceReadsByTurn.set(turnId, existing);
}

export function completedToolCallsForTurn(turnId: string | undefined): string[] {
  return [...(turnId ? (workspaceReadsByTurn.get(turnId)?.completedTools ?? []) : [])];
}

export function recordCompletedResourceRead(turnId: string | undefined, referenceId: string): void {
  if (!turnId || !openProvenanceTurns.has(turnId) || !referenceId.trim()) return;
  if (!workspaceReadsByTurn.has(turnId) && workspaceReadsByTurn.size >= MAX_TRACKED_TURNS) {
    const oldest = workspaceReadsByTurn.keys().next().value;
    if (oldest !== undefined) workspaceReadsByTurn.delete(oldest);
  }
  const existing = workspaceReadsByTurn.get(turnId) ?? {
    completedTools: [],
    tools: [],
    resources: [],
  };
  existing.resources.push(`waypoint://selection/${referenceId}`);
  workspaceReadsByTurn.set(turnId, existing);
}

export function workspaceProvenanceForTurn(turnId: string | undefined): TurnWorkspaceProvenance {
  const completed = turnId ? workspaceReadsByTurn.get(turnId) : undefined;
  const completedWorkspaceTools = completed?.tools ?? [];
  const completedWorkspaceResources = completed?.resources ?? [];
  return {
    completedWorkspaceTools: [...completedWorkspaceTools],
    completedWorkspaceResources: [...completedWorkspaceResources],
    grounded: completedWorkspaceTools.length > 0 || completedWorkspaceResources.length > 0,
  };
}

export function consumeWorkspaceProvenanceForTurn(
  turnId: string | undefined
): TurnWorkspaceProvenance {
  const provenance = workspaceProvenanceForTurn(turnId);
  clearWorkspaceProvenanceForTurn(turnId);
  return provenance;
}

export function clearWorkspaceProvenanceForTurn(turnId: string | undefined): void {
  if (turnId) {
    workspaceReadsByTurn.delete(turnId);
    openProvenanceTurns.delete(turnId);
  }
}

export function __resetWorkspaceProvenanceForTests(): void {
  workspaceReadsByTurn.clear();
  openProvenanceTurns.clear();
}

export interface HostedWorkspaceRosterEntry {
  workspaceId: string;
  clientWorkspaceId: string;
  displayName: string;
}

let roster: readonly HostedWorkspaceRosterEntry[] = [];

export function rememberHostedWorkspaces(next: readonly HostedWorkspaceRosterEntry[]): void {
  roster = next;
}

export function hostedWorkspaceById(workspaceId: string): HostedWorkspaceRosterEntry | undefined {
  return roster.find((workspace) => workspace.workspaceId === workspaceId);
}

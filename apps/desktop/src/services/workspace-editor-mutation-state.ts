import { withUserMessage } from '@waypoint/user-messages';
import { pathIsAtOrUnder } from '../shared/path-boundary';

export interface WorkspaceEditorScope {
  entityId: string;
  path?: string;
}
export interface WorkspaceEditorBlocker extends WorkspaceEditorScope {
  state: 'clean' | 'dirty' | 'saving';
}
export interface WorkspaceEditorMutationScope {
  workspaceRoot: string;
  affectedEntityIds: readonly string[];
}
const blockers = new Set<() => WorkspaceEditorBlocker>();
const freezes = new Set<WorkspaceEditorMutationScope>();

function affects(scope: WorkspaceEditorMutationScope, editor: WorkspaceEditorScope): boolean {
  return (
    scope.affectedEntityIds.includes(editor.entityId) ||
    (editor.path ? pathIsAtOrUnder(editor.path, scope.workspaceRoot) : true)
  );
}

export function registerWorkspaceEditorBlocker(read: () => WorkspaceEditorBlocker): () => void {
  blockers.add(read);
  return () => {
    blockers.delete(read);
  };
}
export function getWorkspaceEditorBlockers(
  scope: WorkspaceEditorMutationScope
): WorkspaceEditorBlocker[] {
  return [...blockers].map((read) => read()).filter((editor) => affects(scope, editor));
}
export function assertWorkspaceEditorsSettled(scope: WorkspaceEditorMutationScope): void {
  for (const editor of getWorkspaceEditorBlockers(scope)) {
    if (editor.state === 'clean') continue;
    throw withUserMessage(
      new Error(
        editor.state === 'saving'
          ? 'An editor is still saving. Wait for it to finish before changing this project.'
          : 'An editor has unsaved changes. Save or cancel them before changing this project.'
      ),
      editor.state === 'saving' ? 'workspace.editorSaving' : 'workspace.editorUnsaved'
    );
  }
}
export function freezeWorkspaceEditorWrites(scope: WorkspaceEditorMutationScope): () => void {
  const frozen = {
    workspaceRoot: scope.workspaceRoot,
    affectedEntityIds: [...scope.affectedEntityIds],
  };
  freezes.add(frozen);
  return () => {
    freezes.delete(frozen);
  };
}
export function beginWorkspaceEditorWrite(editor: WorkspaceEditorScope): () => void {
  if ([...freezes].some((scope) => affects(scope, editor)))
    throw withUserMessage(
      new Error('A project update is in progress. Your changes have not been saved yet.'),
      'workspace.updateInProgress'
    );
  return registerWorkspaceEditorBlocker(() => ({ ...editor, state: 'saving' }));
}

export function isWorkspaceEditorInputFrozen(entityId: string): boolean {
  return (
    [...freezes].some((scope) => scope.affectedEntityIds.includes(entityId)) ||
    [...blockers].some((read) => {
      const editor = read();
      return editor.entityId === entityId && [...freezes].some((scope) => affects(scope, editor));
    })
  );
}

export function assertWorkspaceEditorInputAllowed(entityId: string): void {
  if (isWorkspaceEditorInputFrozen(entityId))
    throw new Error('A workspace update is in progress. Wait before editing this document.');
}

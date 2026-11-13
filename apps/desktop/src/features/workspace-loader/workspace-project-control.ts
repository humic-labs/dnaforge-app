import type { WorkspaceSource, OpenWorkspaceOptions } from './types';

export interface WorkspaceProjectControl {
  open(source: WorkspaceSource, options?: OpenWorkspaceOptions): Promise<boolean>;
  unmount(path: string): Promise<void>;
  refresh(): Promise<unknown>;
}
let current: WorkspaceProjectControl | null = null;
export function registerWorkspaceProjectControl(control: WorkspaceProjectControl) {
  current = control;
  return () => {
    if (current === control) current = null;
  };
}
export function getWorkspaceProjectControl() {
  return current;
}

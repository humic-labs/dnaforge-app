import { basename } from 'node:path';
import type { AgentProjectScope } from '../../shared/agent-project-scope';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import type {
  RegisteredProject,
  RegisteredProjectAuthority,
} from '../registered-project-authority';
import { workspaceMutationRootIdentity } from '../workspace-sync-mutation-lease';

export function createRegisteredProjectAuthorityFixture(initialRoots: readonly string[] = []) {
  const projects = new Map<string, RegisteredProject>();
  let identity = 0;
  const register = (root: string, pinned = false): RegisteredProject => {
    const path = workspaceMutationRootIdentity(root);
    const current = projects.get(path);
    if (current && current.pinned === pinned) return current;
    const id = ++identity;
    const project: RegisteredProject = {
      id,
      projectId: `fixture-project-${id}`,
      name: basename(path),
      path,
      accessMode: pinned ? 'reference' : 'writable',
      pinned,
    };
    projects.set(path, project);
    return project;
  };
  initialRoots.forEach((root) => register(root));
  const list = (scope?: AgentProjectScope): RegisteredProject[] => {
    const roots =
      scope?.kind === 'project-roots'
        ? new Set(scope.roots.map((root) => normalizePathForBoundary(root)))
        : null;
    return [...projects.values()].filter(
      (project) => !roots || roots.has(normalizePathForBoundary(project.path))
    );
  };
  const authority: RegisteredProjectAuthority = {
    list,
    resolve(reference, scope) {
      const matches = list(scope).filter(
        (project) =>
          project.projectId === reference ||
          project.path === workspaceMutationRootIdentity(reference)
      );
      return matches.length === 1 ? matches[0] : null;
    },
    capture(projectId, mutating = false) {
      const project = list().find((entry) => entry.projectId === projectId);
      if (!project || (mutating && project.pinned))
        throw new Error('The registered project is unavailable.');
      return () => {
        if (projects.get(project.path) !== project)
          throw new Error('PROJECT_ACCESS_CHANGED: The registered project authority changed.');
      };
    },
    folders(scope) {
      return list(scope).map((project) => ({
        path: project.path,
        name: project.name,
        addedAt: 0,
        pinned: project.pinned,
      }));
    },
  };
  return {
    authority,
    register,
    remove: (root: string) => projects.delete(workspaceMutationRootIdentity(root)),
  };
}

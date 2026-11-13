import type { AuthorizedProjectFolder } from '../../shared/agent-project-scope';

export function createRegisteredProjectPlatformFixture(paths: readonly string[] = ['/workspace']) {
  const projects: AuthorizedProjectFolder[] = paths.map((path, index) => ({
    path,
    name: `Registered project ${index + 1}`,
    addedAt: index,
    pinned: false,
  }));
  return {
    resolveRegisteredProject: async (reference: string) =>
      projects.find((project) => project.path === reference) ?? null,
    listRegisteredProjects: async () => [...projects],
  };
}

const admittedProjectRoots = new Set<string>();

export function registerAdmittedProjectRoot(canonicalRoot: string): void {
  admittedProjectRoots.add(canonicalRoot);
}

export function getAdmittedProjectRoots(): string[] {
  return [...admittedProjectRoots];
}

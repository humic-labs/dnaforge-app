export function isRecoveredComputeResultDirectory(name: string): boolean {
  return /^Recovered compute [a-f0-9]{12}$/u.test(name);
}

export function isComputeRecoveryBackingPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith('.dnaforge/compute-results/');
}

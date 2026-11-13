const CAPABILITY_IMPLICATIONS: Readonly<Record<string, readonly string[]>> = {
  'write-workspace': ['edit-primers', 'edit-protocols'],
};

function expandCapabilities(provided: readonly string[]): Set<string> {
  const expanded = new Set(provided);
  const pending = [...provided];
  while (pending.length > 0) {
    const capability = pending.pop();
    if (!capability) continue;
    for (const implied of CAPABILITY_IMPLICATIONS[capability] ?? []) {
      if (expanded.has(implied)) continue;
      expanded.add(implied);
      pending.push(implied);
    }
  }
  return expanded;
}

export function hasRequiredCapabilities(
  provided: readonly string[],
  required: readonly string[]
): boolean {
  if (provided.includes('*')) return true;
  const expanded = expandCapabilities(provided);
  return required.every((capability) => expanded.has(capability));
}

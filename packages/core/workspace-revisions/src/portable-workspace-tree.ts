import { parseWorkspacePath, validateMaterializedTree, type MaterializedPathEntry } from './path';

export function validatePortableWorkspaceTree(manifest: {
  readonly files: readonly { readonly path: string }[];
}): { ok: true } | { ok: false; errors: string[] } {
  const entries: MaterializedPathEntry[] = [];
  const directories = new Set<string>();
  const errors: string[] = [];
  for (const [index, file] of manifest.files.entries()) {
    const parsed = parseWorkspacePath(file.path);
    if (!parsed.ok) {
      errors.push(`files[${index}].path is not portable: ${parsed.error.kind}`);
    } else if (parsed.value !== file.path) {
      errors.push(`files[${index}].path must use its exact NFC spelling`);
    } else {
      entries.push({ owner: String(index), kind: 'file', path: parsed.value });
      let separator = parsed.value.indexOf('/');
      while (separator >= 0) {
        const directory = parsed.value.slice(0, separator);
        if (!directories.has(directory)) {
          directories.add(directory);
          const parent = parseWorkspacePath(directory);
          if (parent.ok)
            entries.push({
              owner: `directory:${directory}`,
              kind: 'directory',
              path: parent.value,
            });
        }
        separator = parsed.value.indexOf('/', separator + 1);
      }
    }
  }
  const tree = validateMaterializedTree(entries);
  if (!tree.ok) {
    errors.push(
      tree.error.kind === 'path-collision'
        ? `portable paths collide: ${tree.error.paths.join(' and ')}`
        : `file ${tree.error.ancestor} is an ancestor of ${tree.error.descendant}`
    );
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

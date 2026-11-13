function requireName(value: unknown, location: string): void {
  const name = typeof value === 'string' ? value.trim().normalize('NFKC') : '';
  const generic =
    /^(?:(?:view|scene|step|snapshot)(?:[\s_:#-]*(?:\d+|[ivxlcdm]+))?|untitled|unnamed)[.!]?$/i;
  if (!name || !/\p{L}/u.test(name) || generic.test(name))
    throw Object.assign(
      new Error(
        `Give ${location} an explicit descriptive name explaining what it shows. Missing names and generic numbered placeholders do not qualify. Set each story snapshot's metadata.title and provide a descriptive saved title before retrying.`
      ),
      { code: 'MVS_VIEW_NAME_REQUIRED' }
    );
}

export function requireNamedMolecularViews(scene: string, savedTitle: string): void {
  requireName(savedTitle, 'the saved view or story');
  const document = JSON.parse(scene);
  if (document.kind === 'multiple') {
    for (const [index, snapshot] of document.snapshots.entries())
      requireName(
        snapshot.metadata?.title,
        `story step ${index + 1} (snapshots[${index}].metadata.title)`
      );
  } else if (document.metadata?.title !== undefined) {
    requireName(document.metadata.title, 'the single scene metadata.title');
  }
}

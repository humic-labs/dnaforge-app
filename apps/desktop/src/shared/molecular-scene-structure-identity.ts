export type StructureIdentityNode = {
  kind?: unknown;
  ref?: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: StructureIdentityNode[];
};

export type Node = StructureIdentityNode;

export const prefix = 'dnaforge:structure:';

export function assignStructureRefsInRoot(root: Node): void {
  const references = new Map<string, number>();
  const structures: Array<{
    node: Node;
    path: string;
  }> = [];
  const visit = (node: Node, path: string) => {
    if (typeof node.ref === 'string') references.set(node.ref, (references.get(node.ref) ?? 0) + 1);
    if (node.kind === 'structure') structures.push({ node, path });
    for (const [index, child] of (node.children ?? []).entries()) visit(child, `${path}.${index}`);
  };
  visit(root, 'root');
  for (const { node, path } of structures) {
    if (node.ref !== undefined) {
      if (!node.ref.trim() || references.get(node.ref) !== 1)
        throw Object.assign(
          new Error('MVS structure references must be nonempty and unambiguous within each view.'),
          { code: 'MVS_STRUCTURE_IDENTITY_AMBIGUOUS' }
        );
      continue;
    }
    let ref = `${prefix}${path}`;
    while (references.has(ref)) ref += ':structure';
    node.ref = ref;
    references.set(ref, 1);
  }
}

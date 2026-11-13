import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';

type Node = {
  kind: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: Node[];
};
type DisplayRecord = { version: 1; visibility: 'shown'; userRequest: string };

function recordedRequest(value: unknown): DisplayRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as DisplayRecord;
  return record.version === 1 &&
    record.visibility === 'shown' &&
    typeof record.userRequest === 'string' &&
    record.userRequest.length > 0 &&
    record.userRequest.length <= 500
    ? record
    : undefined;
}

export function resolveMolecularHydrogenDisplay(
  input: MVSData,
  authority: { kind: 'author'; userRequest?: string } | { kind: 'replay' }
): MVSData {
  const document = structuredClone(input);
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((s) => s.root) : [document.root];
  for (const root of roots) {
    const record =
      authority.kind === 'author'
        ? authority.userRequest
          ? {
              version: 1 as const,
              visibility: 'shown' as const,
              userRequest: authority.userRequest,
            }
          : undefined
        : recordedRequest(root.custom?.dnaforge_hydrogen_atoms);
    root.custom = { ...root.custom };
    if (record) root.custom.dnaforge_hydrogen_atoms = record;
    else delete root.custom.dnaforge_hydrogen_atoms;
    const pending: Node[] = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === 'representation') {
        const hide = !record;
        if (['ball_and_stick', 'spacefill', 'line', 'surface'].includes(String(node.params?.type)))
          node.params = { ...node.params, ignore_hydrogens: hide };
        node.custom = {
          ...node.custom,
          molstar_representation_params: {
            ...(node.custom?.molstar_representation_params as Record<string, unknown> | undefined),
            ignoreHydrogens: hide,
            ignoreHydrogensVariant: 'all',
          },
        };
      }
      pending.push(...(node.children ?? []));
    }
  }
  return document;
}

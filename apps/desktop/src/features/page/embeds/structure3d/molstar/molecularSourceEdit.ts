import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import type { MolecularProfileNode as Node } from './nucleotidePresentationSettings';

export function normalizeActiveMolecularSource(
  document: MVSData,
  activeIndex: number,
  structureRef: string | undefined,
  normalize: (sourceDocument: MVSData) => MVSData
): MVSData {
  const root = (
    document.kind === 'multiple' ? document.snapshots[activeIndex]?.root : document.root
  ) as Node | undefined;
  if (!root)
    throw Object.assign(new Error('The active molecular story step is unavailable.'), {
      code: 'MVS_STORY_STEP_INVALID',
    });
  const matches: Array<{ node: Node; path: number[] }> = [];
  const visit = (node: Node, path: number[]): void => {
    if (node.kind === 'structure' && (structureRef === undefined || node.ref === structureRef))
      matches.push({ node, path });
    for (const [index, child] of (node.children ?? []).entries()) visit(child, [...path, index]);
  };
  visit(root, []);
  if (matches.length !== 1)
    throw Object.assign(new Error('A molecular source edit requires one exact active structure.'), {
      code: 'MVS_STRUCTURE_SOURCE_REQUIRED',
    });
  const { node: structure, path } = matches[0];
  let branch = structuredClone(structure);
  const ancestors: Node[] = [];
  let cursor = root;
  for (const index of path) {
    ancestors.push(cursor);
    cursor = cursor.children![index];
  }
  for (const ancestor of ancestors.reverse())
    branch = { ...structuredClone(ancestor), children: [branch] };
  const normalized = normalize({
    kind: 'single',
    metadata: structuredClone(document.metadata),
    root: branch as never,
  });
  if (normalized.kind === 'multiple')
    throw new Error('A molecular source normalizer must retain its single source branch.');
  const normalizedStructures: Node[] = [];
  const collect = (node: Node): void => {
    if (node.kind === 'structure') normalizedStructures.push(node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(normalized.root as Node);
  if (normalizedStructures.length !== 1 || normalizedStructures[0].ref !== structure.ref)
    throw new Error('A molecular source normalizer changed its declared structure identity.');
  const result = structuredClone(document);
  const resultRoot = (
    result.kind === 'multiple' ? result.snapshots[activeIndex].root : result.root
  ) as Node;
  resultRoot.custom = structuredClone((normalized.root as Node).custom);
  let parent = resultRoot;
  for (const index of path.slice(0, -1)) parent = parent.children![index];
  parent.children![path[path.length - 1]] = normalizedStructures[0];
  return result;
}

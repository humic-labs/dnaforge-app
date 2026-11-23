import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { ComponentExpressionT } from 'molstar/lib/extensions/mvs/tree/mvs/param-types';

export class MolViewSpecSceneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stateChanged: boolean | 'unknown' = false,
    readonly missingResource = false
  ) {
    super(message);
    this.name = 'MolViewSpecSceneError';
  }
}

export function molViewSpecPrimaryResourceName(format: 'pdb' | 'mmcif' | 'cif' | 'bcif'): string {
  return format === 'mmcif' ? 'structure.cif' : `structure.${format}`;
}

export function assertMolViewSpecSnapshotIndex(document: MVSData, index: number): void {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    (document.kind === 'multiple' ? index >= document.snapshots.length : index !== 0)
  ) {
    throw new MolViewSpecSceneError(
      'MVS_STORY_STEP_INVALID',
      'The requested opening story step does not exist.'
    );
  }
}

const expressionFields = new Set(
  Object.keys((ComponentExpressionT as unknown as { props: Record<string, unknown> }).props)
);

export function validateMolViewSpecScene(
  scene: string,
  resourceNames: string | readonly string[]
): MVSData {
  const allowedResources = new Set(
    typeof resourceNames === 'string' ? [resourceNames] : resourceNames
  );
  let document: MVSData;
  try {
    document = JSON.parse(scene) as MVSData;
    if (!document || typeof document !== 'object' || !document.metadata)
      throw new Error('Missing MolViewSpec metadata.');
    const version = document.metadata.version;
    if (typeof version !== 'string' || Number(version.split('.')[0]) !== MVSData.SupportedVersion) {
      throw new MolViewSpecSceneError(
        'MVS_UNSUPPORTED_VERSION',
        `This Molstar runtime supports MolViewSpec major version ${MVSData.SupportedVersion}.`
      );
    }
    const issues = MVSData.validationIssues(document, { noExtra: true });
    if (issues?.length) throw new Error(issues.slice(0, 12).join('\n'));
  } catch (error) {
    if (error instanceof MolViewSpecSceneError) throw error;
    throw new MolViewSpecSceneError(
      'MVS_INVALID_SCENE',
      error instanceof Error ? error.message : 'Invalid MVSJ document.'
    );
  }
  if (document.kind === 'multiple' && !document.snapshots.length)
    throw new MolViewSpecSceneError('MVS_INVALID_SCENE', 'A story must contain at least one view.');
  type SceneNode = { kind: string; params?: unknown; children?: SceneNode[] };
  const pending: SceneNode[] =
    document.kind === 'multiple'
      ? document.snapshots.map((snapshot) => snapshot.root)
      : [document.root];
  let nodes = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++nodes > 2_000)
      throw new MolViewSpecSceneError(
        'MVS_INVALID_SCENE',
        'The scene exceeds the 2,000-node limit.'
      );
    const params = node.params as Record<string, unknown> | undefined;
    if (node.kind === 'component' && typeof params?.selector === 'object' && params.selector) {
      const expressions = Array.isArray(params.selector) ? params.selector : [params.selector];
      for (const expression of expressions) {
        const unknown = Object.keys(expression).filter((key) => !expressionFields.has(key));
        if (unknown.length)
          throw new MolViewSpecSceneError(
            'MVS_INVALID_SCENE',
            `Unknown MolViewSpec selector fields: ${unknown.join(', ')}. Use the installed official component expression schema; unsupported fields are not silently ignored.`
          );
      }
    }
    for (const key of ['url', 'uri']) {
      const uri = params?.[key];
      if (uri !== undefined && !allowedResources.has(String(uri))) {
        throw new MolViewSpecSceneError(
          'MVS_UNSUPPORTED_RESOURCE',
          `Scene resource ${String(uri)} is not pinned to this view. Available resources: ${[...allowedResources].join(', ')}.`,
          false,
          true
        );
      }
    }
    pending.push(...(node.children ?? []));
  }
  return document;
}

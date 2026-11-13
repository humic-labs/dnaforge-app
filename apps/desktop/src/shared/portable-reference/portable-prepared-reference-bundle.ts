import { sha256Hex } from '../sha256-sync';

export const PORTABLE_PREPARED_REFERENCE_BUNDLE_V1 =
  'dnaforge-portable-prepared-reference-bundle.v1' as const;

export const PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1 = [
  'shell',
  'view',
  'detail',
  'search',
] as const;

export type PortablePreparedReferenceReadinessTierV1 =
  (typeof PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1)[number];

export const PORTABLE_PREPARED_REFERENCE_OBJECT_ROLES_V1 = [
  'prepared-reference-definition',
  'prepared-source-receipt',
  'view-catalog',
  'broad-raster-manifest',
  'fasta',
  'fasta-index',
  'fasta-gzi',
  'gff3-bgzf',
  'gff3-tabix',
  'annotation-overview',
  'annotation-scene-manifest',
  'annotation-scene-payload',
  'annotation-role-sidecar',
  'compiled-broad-interaction-payload',
  'annotation-product-set-manifest',
  'annotation-search-manifest',
  'annotation-search-payload',
  'protein-search-manifest',
  'protein-search-payload',
] as const;

export type PortablePreparedReferenceObjectRoleV1 =
  (typeof PORTABLE_PREPARED_REFERENCE_OBJECT_ROLES_V1)[number];

export interface PortablePreparedReferenceObjectV1 {
  readonly id: string;
  readonly role: PortablePreparedReferenceObjectRoleV1;
  readonly objectKey: string;
  readonly installPath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly contractToken: string;
  readonly dependsOn: readonly string[];
}

export interface PortablePreparedReferenceReadinessStageV1 {
  readonly dependsOn: readonly PortablePreparedReferenceReadinessTierV1[];
  readonly objectIds: readonly string[];
}

export interface PortablePreparedReferenceBundleV1 {
  readonly contract: typeof PORTABLE_PREPARED_REFERENCE_BUNDLE_V1;
  readonly bundleFingerprint: string;
  readonly assembly: Readonly<{
    id: string;
    assetCacheKey: string;
    preparationPipelineRevision: number;
    assemblyLengthBp: number;
    contigCount: number;
    source: Readonly<{
      fastaSha256: string;
      gffSha256: string;
    }>;
  }>;
  readonly objects: readonly PortablePreparedReferenceObjectV1[];
  readonly readiness: Readonly<
    Record<PortablePreparedReferenceReadinessTierV1, PortablePreparedReferenceReadinessStageV1>
  >;
}

export type PortablePreparedReferenceBundleDraftV1 = Omit<
  PortablePreparedReferenceBundleV1,
  'contract' | 'bundleFingerprint'
>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTRACT_TOKEN = /^[\x21-\x7e]{1,512}$/;
const ROLE_SET = new Set<string>(PORTABLE_PREPARED_REFERENCE_OBJECT_ROLES_V1);
const TIER_SET = new Set<string>(PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1);
const REQUIRED_ROLES_BY_TIER: Readonly<
  Record<PortablePreparedReferenceReadinessTierV1, readonly PortablePreparedReferenceObjectRoleV1[]>
> = Object.freeze({
  shell: ['prepared-reference-definition'],
  view: ['view-catalog', 'broad-raster-manifest'],
  detail: [
    'fasta',
    'fasta-index',
    'gff3-bgzf',
    'gff3-tabix',
    'annotation-scene-manifest',
    'annotation-scene-payload',
  ],
  search: [
    'annotation-search-manifest',
    'annotation-search-payload',
    'protein-search-manifest',
    'protein-search-payload',
  ],
});
const EXPECTED_TIER_DEPENDENCIES: Readonly<
  Record<
    PortablePreparedReferenceReadinessTierV1,
    readonly PortablePreparedReferenceReadinessTierV1[]
  >
> = Object.freeze({
  shell: [],
  view: ['shell'],
  detail: ['view'],
  search: ['shell'],
});

export function buildPortablePreparedReferenceBundleV1(
  draft: PortablePreparedReferenceBundleDraftV1
): PortablePreparedReferenceBundleV1 {
  const body = {
    contract: PORTABLE_PREPARED_REFERENCE_BUNDLE_V1,
    assembly: draft.assembly,
    objects: draft.objects,
    readiness: draft.readiness,
  };
  return parsePortablePreparedReferenceBundleV1({
    ...body,
    bundleFingerprint: sha256Canonical(body),
  });
}

export function parsePortablePreparedReferenceBundleV1(
  value: unknown,
  expected?: Readonly<{
    assemblyId?: string;
    assetCacheKey?: string;
    preparationPipelineRevision?: number;
    assemblyLengthBp?: number;
    contigCount?: number;
    source?: Readonly<{ fastaSha256: string; gffSha256: string }>;
  }>
): PortablePreparedReferenceBundleV1 {
  const root = requireRecord(value, 'portable prepared reference bundle');
  assertOnlyKeys(
    root,
    ['contract', 'bundleFingerprint', 'assembly', 'objects', 'readiness'],
    'portable prepared reference bundle'
  );
  if (root.contract !== PORTABLE_PREPARED_REFERENCE_BUNDLE_V1) {
    throw new Error(
      `portable prepared reference bundle.contract must be "${PORTABLE_PREPARED_REFERENCE_BUNDLE_V1}".`
    );
  }
  const bundleFingerprint = requireSha256(
    root.bundleFingerprint,
    'portable prepared reference bundle.bundleFingerprint'
  );
  const assembly = parseAssembly(root.assembly);
  if (expected?.assemblyId !== undefined && assembly.id !== expected.assemblyId) {
    throw new Error('portable prepared reference bundle assembly ID does not match its catalog.');
  }
  if (expected?.assetCacheKey !== undefined && assembly.assetCacheKey !== expected.assetCacheKey) {
    throw new Error(
      'portable prepared reference bundle cache identity does not match its catalog.'
    );
  }
  if (
    expected?.preparationPipelineRevision !== undefined &&
    assembly.preparationPipelineRevision !== expected.preparationPipelineRevision
  ) {
    throw new Error(
      'portable prepared reference bundle pipeline revision is incompatible with this client.'
    );
  }
  if (
    expected?.assemblyLengthBp !== undefined &&
    assembly.assemblyLengthBp !== expected.assemblyLengthBp
  ) {
    throw new Error(
      'portable prepared reference bundle assembly length does not match its catalog.'
    );
  }
  if (expected?.contigCount !== undefined && assembly.contigCount !== expected.contigCount) {
    throw new Error('portable prepared reference bundle contig count does not match its catalog.');
  }
  if (
    expected?.source !== undefined &&
    (assembly.source.fastaSha256 !== expected.source.fastaSha256 ||
      assembly.source.gffSha256 !== expected.source.gffSha256)
  ) {
    throw new Error(
      'portable prepared reference bundle source identity does not match its catalog.'
    );
  }

  if (!Array.isArray(root.objects) || root.objects.length === 0) {
    throw new Error('portable prepared reference bundle.objects must not be empty.');
  }
  const objects = root.objects.map((object, index) => parseObject(object, index));
  const objectsById = new Map<string, PortablePreparedReferenceObjectV1>();
  const installPaths = new Set<string>();
  for (const object of objects) {
    if (objectsById.has(object.id)) {
      throw new Error(
        `portable prepared reference bundle contains duplicate object "${object.id}".`
      );
    }
    if (installPaths.has(object.installPath)) {
      throw new Error(
        `portable prepared reference bundle contains duplicate install path "${object.installPath}".`
      );
    }
    objectsById.set(object.id, object);
    installPaths.add(object.installPath);
  }
  validateObjectDependencies(objects, objectsById);

  const readiness = parseReadiness(root.readiness, objectsById);
  validateReadinessCoverage(objects, readiness);
  validateTierDependencyDirection(objectsById, readiness);
  validateRequiredTierRoles(objectsById, readiness);

  const canonicalBody = {
    contract: PORTABLE_PREPARED_REFERENCE_BUNDLE_V1,
    assembly,
    objects,
    readiness,
  };
  if (sha256Canonical(canonicalBody) !== bundleFingerprint) {
    throw new Error('portable prepared reference bundle fingerprint does not match its contents.');
  }
  return Object.freeze({
    ...canonicalBody,
    bundleFingerprint,
    assembly: Object.freeze({
      ...assembly,
      source: Object.freeze({ ...assembly.source }),
    }),
    objects: Object.freeze(
      objects.map((object) =>
        Object.freeze({ ...object, dependsOn: Object.freeze(object.dependsOn) })
      )
    ),
    readiness: Object.freeze(
      Object.fromEntries(
        PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1.map((tier) => [
          tier,
          Object.freeze({
            dependsOn: Object.freeze(readiness[tier].dependsOn),
            objectIds: Object.freeze(readiness[tier].objectIds),
          }),
        ])
      ) as Record<
        PortablePreparedReferenceReadinessTierV1,
        PortablePreparedReferenceReadinessStageV1
      >
    ),
  });
}

export function portablePreparedReferenceObjectsForTierV1(
  bundle: PortablePreparedReferenceBundleV1,
  tier: PortablePreparedReferenceReadinessTierV1
): readonly PortablePreparedReferenceObjectV1[] {
  if (!TIER_SET.has(tier)) throw new Error(`Unknown portable readiness tier: ${tier}`);
  const byId = new Map(bundle.objects.map((object) => [object.id, object]));
  const tierIds = new Set<string>();
  const visitTier = (candidate: PortablePreparedReferenceReadinessTierV1): void => {
    for (const dependency of bundle.readiness[candidate].dependsOn) visitTier(dependency);
    for (const objectId of bundle.readiness[candidate].objectIds) tierIds.add(objectId);
  };
  visitTier(tier);

  const ordered: PortablePreparedReferenceObjectV1[] = [];
  const visited = new Set<string>();
  const visitObject = (objectId: string): void => {
    if (visited.has(objectId)) return;
    const object = byId.get(objectId);
    if (!object) throw new Error(`Portable bundle object "${objectId}" is unavailable.`);
    for (const dependency of object.dependsOn) visitObject(dependency);
    visited.add(objectId);
    ordered.push(object);
  };
  for (const objectId of tierIds) visitObject(objectId);
  return Object.freeze(ordered);
}

function parseAssembly(value: unknown): PortablePreparedReferenceBundleV1['assembly'] {
  const assembly = requireRecord(value, 'portable prepared reference bundle.assembly');
  assertOnlyKeys(
    assembly,
    [
      'id',
      'assetCacheKey',
      'preparationPipelineRevision',
      'assemblyLengthBp',
      'contigCount',
      'source',
    ],
    'portable prepared reference bundle.assembly'
  );
  const source = requireRecord(
    assembly.source,
    'portable prepared reference bundle.assembly.source'
  );
  assertOnlyKeys(
    source,
    ['fastaSha256', 'gffSha256'],
    'portable prepared reference bundle.assembly.source'
  );
  return {
    id: requireSafeId(assembly.id, 'portable prepared reference bundle.assembly.id'),
    assetCacheKey: requireSafeId(
      assembly.assetCacheKey,
      'portable prepared reference bundle.assembly.assetCacheKey'
    ),
    preparationPipelineRevision: requirePositiveInteger(
      assembly.preparationPipelineRevision,
      'portable prepared reference bundle.assembly.preparationPipelineRevision'
    ),
    assemblyLengthBp: requirePositiveInteger(
      assembly.assemblyLengthBp,
      'portable prepared reference bundle.assembly.assemblyLengthBp'
    ),
    contigCount: requirePositiveInteger(
      assembly.contigCount,
      'portable prepared reference bundle.assembly.contigCount'
    ),
    source: {
      fastaSha256: requireSha256(
        source.fastaSha256,
        'portable prepared reference bundle.assembly.source.fastaSha256'
      ),
      gffSha256: requireSha256(
        source.gffSha256,
        'portable prepared reference bundle.assembly.source.gffSha256'
      ),
    },
  };
}

function parseObject(value: unknown, index: number): PortablePreparedReferenceObjectV1 {
  const label = `portable prepared reference bundle.objects[${index}]`;
  const object = requireRecord(value, label);
  assertOnlyKeys(
    object,
    [
      'id',
      'role',
      'objectKey',
      'installPath',
      'byteLength',
      'sha256',
      'contractToken',
      'dependsOn',
    ],
    label
  );
  const id = requireSafeId(object.id, `${label}.id`);
  if (typeof object.role !== 'string' || !ROLE_SET.has(object.role)) {
    throw new Error(`${label}.role is unsupported.`);
  }
  const sha256 = requireSha256(object.sha256, `${label}.sha256`);
  const objectKey = requireText(object.objectKey, `${label}.objectKey`);
  const expectedObjectKey = contentAddressedObjectKeyV1(sha256);
  if (objectKey !== expectedObjectKey) {
    throw new Error(`${label}.objectKey must be "${expectedObjectKey}".`);
  }
  const installPath = requireSafeRelativePath(object.installPath, `${label}.installPath`);
  if (typeof object.contractToken !== 'string' || !CONTRACT_TOKEN.test(object.contractToken)) {
    throw new Error(`${label}.contractToken must be printable non-whitespace ASCII.`);
  }
  if (!Array.isArray(object.dependsOn)) {
    throw new Error(`${label}.dependsOn must be an array.`);
  }
  const dependencies = object.dependsOn.map((dependency, dependencyIndex) =>
    requireSafeId(dependency, `${label}.dependsOn[${dependencyIndex}]`)
  );
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error(`${label}.dependsOn contains duplicates.`);
  }
  if (dependencies.includes(id)) throw new Error(`${label} cannot depend on itself.`);
  return {
    id,
    role: object.role as PortablePreparedReferenceObjectRoleV1,
    objectKey,
    installPath,
    byteLength: requirePositiveInteger(object.byteLength, `${label}.byteLength`),
    sha256,
    contractToken: object.contractToken,
    dependsOn: dependencies,
  };
}

function parseReadiness(
  value: unknown,
  objectsById: ReadonlyMap<string, PortablePreparedReferenceObjectV1>
): PortablePreparedReferenceBundleV1['readiness'] {
  const readiness = requireRecord(value, 'portable prepared reference bundle.readiness');
  assertOnlyKeys(
    readiness,
    [...PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1],
    'portable prepared reference bundle.readiness'
  );
  const parsed = {} as Record<
    PortablePreparedReferenceReadinessTierV1,
    PortablePreparedReferenceReadinessStageV1
  >;
  for (const tier of PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1) {
    const stage = requireRecord(
      readiness[tier],
      `portable prepared reference bundle.readiness.${tier}`
    );
    assertOnlyKeys(
      stage,
      ['dependsOn', 'objectIds'],
      `portable prepared reference bundle.readiness.${tier}`
    );
    if (!Array.isArray(stage.dependsOn) || !Array.isArray(stage.objectIds)) {
      throw new Error(`portable prepared reference bundle.readiness.${tier} is malformed.`);
    }
    const dependsOn = stage.dependsOn.map((dependency, index) => {
      if (typeof dependency !== 'string' || !TIER_SET.has(dependency)) {
        throw new Error(
          `portable prepared reference bundle.readiness.${tier}.dependsOn[${index}] is unsupported.`
        );
      }
      return dependency as PortablePreparedReferenceReadinessTierV1;
    });
    if (!sameStringArray(dependsOn, EXPECTED_TIER_DEPENDENCIES[tier])) {
      throw new Error(
        `portable prepared reference bundle.readiness.${tier}.dependsOn must be ` +
          JSON.stringify(EXPECTED_TIER_DEPENDENCIES[tier]) +
          '.'
      );
    }
    const objectIds = stage.objectIds.map((objectId, index) => {
      const parsedId = requireSafeId(
        objectId,
        `portable prepared reference bundle.readiness.${tier}.objectIds[${index}]`
      );
      if (!objectsById.has(parsedId)) {
        throw new Error(
          `portable prepared reference bundle readiness references unknown object "${parsedId}".`
        );
      }
      return parsedId;
    });
    if (objectIds.length === 0 || new Set(objectIds).size !== objectIds.length) {
      throw new Error(
        `portable prepared reference bundle.readiness.${tier}.objectIds must be non-empty and unique.`
      );
    }
    parsed[tier] = { dependsOn, objectIds };
  }
  return parsed;
}

function validateObjectDependencies(
  objects: readonly PortablePreparedReferenceObjectV1[],
  objectsById: ReadonlyMap<string, PortablePreparedReferenceObjectV1>
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(
        `portable prepared reference bundle object dependency cycle includes "${id}".`
      );
    }
    const object = objectsById.get(id);
    if (!object) {
      throw new Error(`portable prepared reference bundle references unknown object "${id}".`);
    }
    visiting.add(id);
    for (const dependency of object.dependsOn) {
      if (!objectsById.has(dependency)) {
        throw new Error(
          `portable prepared reference bundle object "${id}" depends on unknown object "${dependency}".`
        );
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const object of objects) visit(object.id);
}

function validateReadinessCoverage(
  objects: readonly PortablePreparedReferenceObjectV1[],
  readiness: PortablePreparedReferenceBundleV1['readiness']
): void {
  const assignments = new Map<string, PortablePreparedReferenceReadinessTierV1>();
  for (const tier of PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1) {
    for (const objectId of readiness[tier].objectIds) {
      const previous = assignments.get(objectId);
      if (previous) {
        throw new Error(
          `portable prepared reference bundle object "${objectId}" is assigned to both ${previous} and ${tier}.`
        );
      }
      assignments.set(objectId, tier);
    }
  }
  const unassigned = objects.filter((object) => !assignments.has(object.id));
  if (unassigned.length > 0) {
    throw new Error(
      `portable prepared reference bundle has unassigned objects: ${unassigned
        .map((object) => object.id)
        .join(', ')}.`
    );
  }
}

function validateTierDependencyDirection(
  objectsById: ReadonlyMap<string, PortablePreparedReferenceObjectV1>,
  readiness: PortablePreparedReferenceBundleV1['readiness']
): void {
  const assignedTier = new Map<string, PortablePreparedReferenceReadinessTierV1>();
  for (const tier of PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1) {
    for (const objectId of readiness[tier].objectIds) assignedTier.set(objectId, tier);
  }
  const allowedDependencies: Readonly<
    Record<
      PortablePreparedReferenceReadinessTierV1,
      ReadonlySet<PortablePreparedReferenceReadinessTierV1>
    >
  > = {
    shell: new Set(['shell']),
    view: new Set(['shell', 'view']),
    detail: new Set(['shell', 'view', 'detail']),
    search: new Set(['shell', 'search']),
  };
  for (const object of objectsById.values()) {
    const tier = assignedTier.get(object.id)!;
    for (const dependency of object.dependsOn) {
      const dependencyTier = assignedTier.get(dependency)!;
      if (!allowedDependencies[tier].has(dependencyTier)) {
        throw new Error(
          `portable prepared reference bundle ${tier} object "${object.id}" cannot depend on ${dependencyTier} object "${dependency}".`
        );
      }
    }
  }
}

function validateRequiredTierRoles(
  objectsById: ReadonlyMap<string, PortablePreparedReferenceObjectV1>,
  readiness: PortablePreparedReferenceBundleV1['readiness']
): void {
  for (const tier of PORTABLE_PREPARED_REFERENCE_READINESS_TIERS_V1) {
    const closure = tierObjectIdClosure(tier, readiness, objectsById);
    const roles = new Set([...closure].map((id) => objectsById.get(id)!.role));
    const missing = REQUIRED_ROLES_BY_TIER[tier].filter((role) => !roles.has(role));
    if (missing.length > 0) {
      throw new Error(
        `portable prepared reference bundle ${tier} readiness is missing roles: ${missing.join(', ')}.`
      );
    }
  }
}

function tierObjectIdClosure(
  tier: PortablePreparedReferenceReadinessTierV1,
  readiness: PortablePreparedReferenceBundleV1['readiness'],
  objectsById: ReadonlyMap<string, PortablePreparedReferenceObjectV1>
): ReadonlySet<string> {
  const ids = new Set<string>();
  const visitedTiers = new Set<PortablePreparedReferenceReadinessTierV1>();
  const addObject = (id: string): void => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const dependency of objectsById.get(id)!.dependsOn) addObject(dependency);
  };
  const addTier = (candidate: PortablePreparedReferenceReadinessTierV1): void => {
    if (visitedTiers.has(candidate)) return;
    visitedTiers.add(candidate);
    for (const dependency of readiness[candidate].dependsOn) addTier(dependency);
    for (const objectId of readiness[candidate].objectIds) addObject(objectId);
  };
  addTier(tier);
  return ids;
}

export function portablePreparedReferenceContentObjectKeyV1(sha256: string): string {
  return contentAddressedObjectKeyV1(requireSha256(sha256, 'portable object SHA-256'));
}

function contentAddressedObjectKeyV1(sha256: string): string {
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unsupported.sort().join(', ')}.`);
  }
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing required fields: ${missing.join(', ')}.`);
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be non-empty canonical text.`);
  }
  return value;
}

function requireSafeId(value: unknown, label: string): string {
  const id = requireText(value, label);
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new Error(`${label} must be a safe identifier.`);
  }
  return id;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireSafeRelativePath(value: unknown, label: string): string {
  const path = requireText(value, label);
  if (
    path.length > 2_048 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    }) ||
    path.includes('?') ||
    path.includes('#') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a safe generation-relative path.`);
  }
  return path;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

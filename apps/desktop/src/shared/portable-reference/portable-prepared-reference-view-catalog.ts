import { sha256Hex } from '../sha256-sync';

import {
  COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1,
  type CompiledBroadAnnotationInteractionBinaryManifestV1,
} from '@waypoint/genome-renderer/pure';

import type { PortablePreparedReferenceBundleV1 } from './portable-prepared-reference-bundle';

export const PORTABLE_PREPARED_REFERENCE_VIEW_CATALOG_V1 =
  'dnaforge-portable-prepared-reference-view-catalog.v1' as const;

export interface PortablePreparedReferenceViewCatalogEntryV1 {
  readonly themeMode: 'dark' | 'light';
  readonly trackType: string;
  readonly sourceFingerprint: string;
  readonly surfaceManifestFingerprint: string;
  readonly catalogFingerprint: string;
  readonly placementFingerprint: string;
  readonly scenePayloadSha256: string;
  readonly sceneContractSha256: string;
  readonly sceneCompilerContractFingerprint: string;
  readonly sceneArtifactKey: string;
  readonly sceneManifestObjectId: string;
  readonly scenePayloadObjectId: string;
  readonly compiledBroadInteractionPayloadSha256?: string;
  readonly compiledBroadInteractionPayloadObjectId?: string;
  readonly compiledBroadInteractionManifest?: CompiledBroadAnnotationInteractionBinaryManifestV1;
  readonly broadManifestObjectId: string;
}

export interface PortablePreparedReferenceViewCatalogV1 {
  readonly contract: typeof PORTABLE_PREPARED_REFERENCE_VIEW_CATALOG_V1;
  readonly assemblyId: string;
  readonly sourceFingerprint: string;
  readonly entries: readonly PortablePreparedReferenceViewCatalogEntryV1[];
  readonly catalogFingerprint: string;
}

export function assertPortableCatalogThemeRosterCoherence(
  catalog: Readonly<{
    entries: readonly Pick<
      PortablePreparedReferenceViewCatalogEntryV1,
      | 'themeMode'
      | 'trackType'
      | 'placementFingerprint'
      | 'sceneContractSha256'
      | 'compiledBroadInteractionPayloadSha256'
      | 'compiledBroadInteractionPayloadObjectId'
    >[];
  }>
): void {
  const lightEntries = catalog.entries.filter((entry) => entry.themeMode === 'light');
  const darkEntries = catalog.entries.filter((entry) => entry.themeMode === 'dark');
  const lightByTrack = new Map(lightEntries.map((entry) => [entry.trackType, entry]));
  const darkByTrack = new Map(darkEntries.map((entry) => [entry.trackType, entry]));
  if (
    lightEntries.length === 0 ||
    lightByTrack.size !== lightEntries.length ||
    darkByTrack.size !== darkEntries.length ||
    (darkEntries.length > 0 &&
      (darkEntries.length !== lightEntries.length ||
        darkEntries.some((entry) => !lightByTrack.has(entry.trackType))))
  ) {
    throw new Error('Portable prepared-reference catalog theme track rosters do not match.');
  }
  if (new Set(catalog.entries.map((entry) => entry.placementFingerprint)).size !== 1) {
    throw new Error('Portable prepared-reference catalog placements do not match.');
  }
  for (const light of lightEntries) {
    const dark = darkByTrack.get(light.trackType);
    if (!dark) continue;
    if (
      light.sceneContractSha256 !== dark.sceneContractSha256 ||
      light.compiledBroadInteractionPayloadSha256 !== dark.compiledBroadInteractionPayloadSha256 ||
      light.compiledBroadInteractionPayloadObjectId !== dark.compiledBroadInteractionPayloadObjectId
    ) {
      throw new Error(
        `Portable prepared-reference catalog theme interaction authorities do not match for ${light.trackType}.`
      );
    }
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const PLACEMENT_FINGERPRINT = /^ap1:[0-9a-f]{24}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parsePortablePreparedReferenceViewCatalogV1(
  value: unknown,
  bundle: PortablePreparedReferenceBundleV1
): PortablePreparedReferenceViewCatalogV1 {
  const root = record(value, 'portable prepared-reference view catalog');
  onlyKeys(
    root,
    ['contract', 'assemblyId', 'sourceFingerprint', 'entries', 'catalogFingerprint'],
    'portable prepared-reference view catalog'
  );
  if (
    root.contract !== PORTABLE_PREPARED_REFERENCE_VIEW_CATALOG_V1 ||
    root.assemblyId !== bundle.assembly.id ||
    !SOURCE_FINGERPRINT.test(String(root.sourceFingerprint)) ||
    !Array.isArray(root.entries) ||
    root.entries.length === 0 ||
    !SHA256.test(String(root.catalogFingerprint))
  ) {
    throw new Error('Portable prepared-reference view catalog identity is invalid.');
  }
  const bundleObjects = new Map(bundle.objects.map((object) => [object.id, object]));
  const viewKeys = new Set<string>();
  const broadObjectIds = new Set<string>();
  const entries = root.entries.map((raw, index): PortablePreparedReferenceViewCatalogEntryV1 => {
    const label = `portable prepared-reference view catalog.entries[${index}]`;
    const entry = record(raw, label);
    onlyKeys(
      entry,
      [
        'themeMode',
        'trackType',
        'sourceFingerprint',
        'surfaceManifestFingerprint',
        'catalogFingerprint',
        'placementFingerprint',
        'scenePayloadSha256',
        'sceneContractSha256',
        'sceneCompilerContractFingerprint',
        'sceneArtifactKey',
        'sceneManifestObjectId',
        'scenePayloadObjectId',
        'compiledBroadInteractionPayloadSha256',
        'compiledBroadInteractionPayloadObjectId',
        'compiledBroadInteractionManifest',
        'broadManifestObjectId',
      ],
      label,
      [
        'themeMode',
        'trackType',
        'sourceFingerprint',
        'surfaceManifestFingerprint',
        'catalogFingerprint',
        'placementFingerprint',
        'scenePayloadSha256',
        'sceneContractSha256',
        'sceneCompilerContractFingerprint',
        'sceneArtifactKey',
        'sceneManifestObjectId',
        'scenePayloadObjectId',
        'broadManifestObjectId',
      ]
    );
    const themeMode = entry.themeMode;
    const trackType = text(entry.trackType, `${label}.trackType`);
    const sourceFingerprint = String(entry.sourceFingerprint);
    const sceneManifestObjectId = safeId(
      entry.sceneManifestObjectId,
      `${label}.sceneManifestObjectId`
    );
    const scenePayloadObjectId = safeId(
      entry.scenePayloadObjectId,
      `${label}.scenePayloadObjectId`
    );
    const broadManifestObjectId = safeId(
      entry.broadManifestObjectId,
      `${label}.broadManifestObjectId`
    );
    const sceneManifestObject = bundleObjects.get(sceneManifestObjectId);
    const scenePayloadObject = bundleObjects.get(scenePayloadObjectId);
    const broadManifestObject = bundleObjects.get(broadManifestObjectId);
    const compactFields = [
      entry.compiledBroadInteractionPayloadSha256,
      entry.compiledBroadInteractionPayloadObjectId,
      entry.compiledBroadInteractionManifest,
    ];
    const hasCompact = compactFields.every((value) => value !== undefined);
    if (!hasCompact && compactFields.some((value) => value !== undefined)) {
      throw new Error(`${label} has a partial compact interaction authority.`);
    }
    const compactPayloadObjectId = hasCompact
      ? safeId(
          entry.compiledBroadInteractionPayloadObjectId,
          `${label}.compiledBroadInteractionPayloadObjectId`
        )
      : undefined;
    const compactPayloadObject = compactPayloadObjectId
      ? bundleObjects.get(compactPayloadObjectId)
      : undefined;
    const compactManifest = hasCompact
      ? compiledBroadInteractionManifest(
          entry.compiledBroadInteractionManifest,
          `${label}.compiledBroadInteractionManifest`
        )
      : undefined;
    if (
      (themeMode !== 'dark' && themeMode !== 'light') ||
      sourceFingerprint !== root.sourceFingerprint ||
      !SHA256.test(String(entry.surfaceManifestFingerprint)) ||
      !SHA256.test(String(entry.catalogFingerprint)) ||
      !PLACEMENT_FINGERPRINT.test(String(entry.placementFingerprint)) ||
      !SHA256.test(String(entry.scenePayloadSha256)) ||
      !SHA256.test(String(entry.sceneContractSha256)) ||
      !SHA256.test(String(entry.sceneCompilerContractFingerprint)) ||
      !text(entry.sceneArtifactKey, `${label}.sceneArtifactKey`) ||
      sceneManifestObject?.role !== 'annotation-scene-manifest' ||
      scenePayloadObject?.role !== 'annotation-scene-payload' ||
      scenePayloadObject.sha256 !== entry.scenePayloadSha256 ||
      broadManifestObject?.role !== 'broad-raster-manifest'
    ) {
      throw new Error(`${label} does not match its authenticated bundle objects.`);
    }
    if (
      hasCompact &&
      (!SHA256.test(String(entry.compiledBroadInteractionPayloadSha256)) ||
        compactPayloadObject?.role !== 'compiled-broad-interaction-payload' ||
        compactPayloadObject.sha256 !== entry.compiledBroadInteractionPayloadSha256 ||
        compactManifest?.integrity?.payloadSha256 !== entry.compiledBroadInteractionPayloadSha256 ||
        compactManifest?.sourceScene?.payloadSha256 !== entry.scenePayloadSha256 ||
        compactManifest?.sourceScene?.contractSha256 !== entry.sceneContractSha256)
    ) {
      throw new Error(`${label} compact interaction does not match its parent scene.`);
    }
    const viewKey = `${themeMode}\0${trackType}`;
    if (viewKeys.has(viewKey) || broadObjectIds.has(broadManifestObjectId)) {
      throw new Error(`${label} duplicates a view or broad-manifest identity.`);
    }
    viewKeys.add(viewKey);
    broadObjectIds.add(broadManifestObjectId);
    return Object.freeze({
      themeMode,
      trackType,
      sourceFingerprint,
      surfaceManifestFingerprint: String(entry.surfaceManifestFingerprint),
      catalogFingerprint: String(entry.catalogFingerprint),
      placementFingerprint: String(entry.placementFingerprint),
      scenePayloadSha256: String(entry.scenePayloadSha256),
      sceneContractSha256: String(entry.sceneContractSha256),
      sceneCompilerContractFingerprint: String(entry.sceneCompilerContractFingerprint),
      sceneArtifactKey: String(entry.sceneArtifactKey),
      sceneManifestObjectId,
      scenePayloadObjectId,
      ...(hasCompact
        ? {
            compiledBroadInteractionPayloadSha256: String(
              entry.compiledBroadInteractionPayloadSha256
            ),
            compiledBroadInteractionPayloadObjectId: compactPayloadObjectId!,
            compiledBroadInteractionManifest: Object.freeze(compactManifest!),
          }
        : {}),
      broadManifestObjectId,
    });
  });
  const body = {
    contract: PORTABLE_PREPARED_REFERENCE_VIEW_CATALOG_V1,
    assemblyId: root.assemblyId,
    sourceFingerprint: root.sourceFingerprint,
    entries,
  };
  if (sha256Canonical(body) !== root.catalogFingerprint) {
    throw new Error('Portable prepared-reference view catalog fingerprint does not match.');
  }
  return Object.freeze({
    ...body,
    catalogFingerprint: String(root.catalogFingerprint),
  }) as PortablePreparedReferenceViewCatalogV1;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function compiledBroadInteractionManifest(
  value: unknown,
  label: string
): CompiledBroadAnnotationInteractionBinaryManifestV1 {
  const manifest = record(value, label);
  if (manifest.schema !== COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1) {
    throw new Error(`${label}.schema must be ${COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1}.`);
  }
  const integrity = record(manifest.integrity, `${label}.integrity`);
  if (integrity.algorithm !== 'sha256' || !SHA256.test(String(integrity.payloadSha256))) {
    throw new Error(`${label}.integrity must carry a sha256 payload digest.`);
  }
  const sourceScene = record(manifest.sourceScene, `${label}.sourceScene`);
  if (
    !SHA256.test(String(sourceScene.payloadSha256)) ||
    !SHA256.test(String(sourceScene.contractSha256))
  ) {
    throw new Error(`${label}.sourceScene must carry sha256 payload and contract digests.`);
  }
  if (!isCompiledBroadInteractionManifest(manifest)) {
    throw new Error(`${label} is not a compiled broad interaction manifest.`);
  }
  return manifest;
}

function isCompiledBroadInteractionManifest(
  value: Record<string, unknown>
): value is Record<string, unknown> & CompiledBroadAnnotationInteractionBinaryManifestV1 {
  return value.schema === COMPILED_BROAD_ANNOTATION_INTERACTION_BINARY_V1;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  required: readonly string[] = allowed
): void {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) {
    throw new Error(`${label} must be bounded nonempty text.`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`${label} is not a safe object ID.`);
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

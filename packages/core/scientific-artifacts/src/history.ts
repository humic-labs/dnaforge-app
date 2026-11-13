import {
  parseScientificIdentityMap,
  scientificIdentityResourceId,
  scientificIdentityPath,
  type ScientificHistoryReader,
  type ScientificIdentityMap,
  parseUniqueJson,
} from '@waypoint/scientific-objects';
import {
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  defineBlob,
  parseResourceId,
  type BlobRef,
} from '@waypoint/workspace-revisions';
import {
  isSequencePackageAdmissionMarker,
  parseSequencePackageAdmissionDescriptor,
  validateSequencePackageAdmission,
} from '@waypoint/share-bundle/sequence-package-admission';
import { scientificNativeCodecs } from './native-codecs';
import { nativeRecord } from './native-json';

export interface LegacyNativeChecksumDiagnostic {
  readonly code: 'LEGACY_DERIVED_GENBANK_CHECKSUM';
  readonly workspaceVersionId: string;
  readonly path: string;
  readonly originalMetadataHash: string;
  readonly recordedChecksum: string;
  readonly acceptedProductChecksum: string;
}

export interface NativeScientificHistoryReader extends ScientificHistoryReader {
  readonly legacyDiagnostics: readonly LegacyNativeChecksumDiagnostic[];
}

export function nativeScientificHistoryReader(
  readBlob: (blob: BlobRef) => Uint8Array | null
): NativeScientificHistoryReader {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const identities = new Map<string, ScientificIdentityMap>();
  const packages = new Set<string>();
  const diagnostics: LegacyNativeChecksumDiagnostic[] = [];
  return {
    codecs: scientificNativeCodecs,
    readBlob,
    get legacyDiagnostics() {
      return Object.freeze([...diagnostics]);
    },
    validateVersion: ({ graph, head, acceptedHead, workspaceId, reader }) => {
      const result = listWorkspaceResources(graph, head);
      if (!result.ok) throw new Error('Native scientific history version is unavailable.');
      const files = new Map<string, { blob: BlobRef; resourceId: string; resourceKind: string }>();
      for (const slot of result.value) {
        if (slot.tombstone || slot.path === null) continue;
        const revision = inspectResourceRevision(graph, slot.revisionId);
        const state =
          revision.ok && revision.value.stateHash
            ? inspectResourceState(graph, revision.value.stateHash)
            : null;
        if (!state?.ok) throw new Error('Native scientific history state is unavailable.');
        if (state.value.layout === 'file')
          files.set(slot.path, {
            blob: state.value.blob,
            resourceId: slot.resourceId,
            resourceKind: state.value.resourceKind,
          });
        else
          for (const member of state.value.members)
            files.set(`${slot.path}/${member.relativePath}`, {
              blob: member.blob,
              resourceId: slot.resourceId,
              resourceKind: state.value.resourceKind,
            });
      }
      const identity = files.get(scientificIdentityPath);
      const misplacedIdentity = result.value.find(
        (slot) => !slot.tombstone && slot.resourceId === scientificIdentityResourceId
      );
      if (identity || misplacedIdentity) {
        if (
          !identity ||
          identity.resourceId !== scientificIdentityResourceId ||
          identity.resourceKind !== 'dnaforge.scientific-identity-map' ||
          misplacedIdentity?.path !== scientificIdentityPath
        )
          throw new Error('Native scientific identity map has a different owner or path.');
        let parsed = identities.get(identity.blob.hash);
        if (!parsed) {
          const bytes = readBlob(identity.blob);
          if (!bytes) throw new Error('Native scientific identity bytes are unavailable.');
          parsed = parseScientificIdentityMap(decoder.decode(bytes), workspaceId);
          identities.set(identity.blob.hash, parsed);
        }
        const current = reader.listCurrent();
        if (parsed.entries.length !== current.length)
          throw new Error('Native identity map omits or adds scientific resources.');
        for (const snapshot of current) {
          const entry = parsed.entries.find((row) => row.resourceId === snapshot.resourceId);
          const file = entry ? files.get(entry.path) : null;
          if (
            !entry ||
            file?.resourceId !== snapshot.resourceId ||
            (parsed.formatVersion === 2 &&
              entry.format !== (snapshot.representation?.format ?? 'scientific-json-v1'))
          )
            throw new Error('Native identity map differs from the accepted scientific namespace.');
        }
      }
      for (const [path, marker] of files) {
        if (!isSequencePackageAdmissionMarker(path)) {
          if (/^dnaforge\.sequence-package\.v/u.test(marker.resourceKind))
            throw new Error('Native sequence package metadata has an unsupported path.');
          continue;
        }
        const root = path.slice(0, -'/.forge/plasmid.json'.length);
        const members = [...files].filter(([name]) => name.startsWith(`${root}/`));
        const key = JSON.stringify(
          members
            .map(([name, file]) => [
              name,
              file.blob.hash,
              file.blob.byteLength,
              file.resourceId,
              file.resourceKind,
            ])
            .sort(([a], [b]) => String(a).localeCompare(String(b)))
        );
        const validationKey = `${head === acceptedHead ? 'accepted' : 'historical'}:${key}`;
        if (packages.has(validationKey)) continue;
        const markerBytes = readBlob(marker.blob);
        if (!markerBytes)
          throw new Error('Native sequence package metadata bytes are unavailable.');
        const rawMarker = nativeRecord(
          parseUniqueJson(decoder.decode(markerBytes), { maxDepth: 64 })
        );
        const descriptor = parseSequencePackageAdmissionDescriptor(rawMarker, path);
        if (!descriptor.ok)
          throw new Error(`Invalid historical sequence package: ${descriptor.errors[0]?.message}`);
        const sequenceId = parseResourceId(descriptor.descriptor.packageId);
        const sequence = sequenceId.ok ? reader.current(sequenceId.value) : null;
        const expectedId = `sequence-package:${defineBlob(new TextEncoder().encode(descriptor.descriptor.packageId)).hash.slice('sha256:'.length)}`;
        if (
          !sequence ||
          sequence.document.kind !== 'sequence' ||
          marker.resourceId !== expectedId ||
          marker.resourceKind !==
            `dnaforge.sequence-package.v${descriptor.descriptor.formatVersion}` ||
          files.get(descriptor.descriptor.productPath)?.resourceId !== sequence.resourceId
        )
          throw new Error('Native package differs from its accepted scientific owner or format.');
        let projection = markerBytes;
        const product = files.get(descriptor.descriptor.productPath);
        if (!product) throw new Error('Native package product is missing.');
        if (
          descriptor.descriptor.genBankChecksum !== undefined &&
          descriptor.descriptor.genBankChecksum !== product.blob.hash
        ) {
          if (head === acceptedHead || descriptor.descriptor.formatVersion !== 6)
            throw new Error(
              'Native current package checksum is inconsistent; repair its derived cache through a new accepted revision before cloud publication.'
            );

          diagnostics.push(
            Object.freeze({
              code: 'LEGACY_DERIVED_GENBANK_CHECKSUM',
              workspaceVersionId: head,
              path,
              originalMetadataHash: marker.blob.hash,
              recordedChecksum: descriptor.descriptor.genBankChecksum,
              acceptedProductChecksum: product.blob.hash,
            })
          );
          projection = new TextEncoder().encode(
            JSON.stringify({
              ...rawMarker,
              product: { ...nativeRecord(rawMarker.product), genBankChecksum: product.blob.hash },
            })
          );
        }
        const projectedMarker = defineBlob(projection);
        const bytes = new Map<string, Uint8Array>([[path, projection]]);
        const manifest = {
          files: members.map(([name, file]) => {
            if (name === descriptor.descriptor.productPath) {
              const content = readBlob(file.blob);
              if (!content)
                throw new Error('Native sequence package authority bytes are unavailable.');
              bytes.set(name, content);
            }
            return {
              path: name,
              contentSha256: (name === path ? projectedMarker : file.blob).hash.slice(
                'sha256:'.length
              ),
              sizeBytes: name === path ? projectedMarker.byteLength : file.blob.byteLength,
            };
          }),
        };
        const admitted = validateSequencePackageAdmission({ manifest, packageBytes: bytes });
        if (!admitted.ok)
          throw new Error(`Invalid historical sequence package: ${admitted.errors[0]?.message}`);
        packages.add(validationKey);
      }
    },
  };
}

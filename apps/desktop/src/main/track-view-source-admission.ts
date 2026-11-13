import { BigBed, BigWig } from '@gmod/bbi';
import type { TrackViewSourceInput } from '@waypoint/domain-services';
import { directTrackAdmissionRequest } from '@waypoint/genome-data';
import { BbiRangeFile } from '../shared/genome/bbi-range-file';
import {
  admitIndexedBigWigRequest,
  admitIndexedBigBedRequest,
  type BbiAdmissionRuntime,
} from '../shared/genome/indexed-track-admission';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import { issueLocalIndexedTrackAuthority } from './local-indexed-track-authority';
import { sidecarFetch } from './sidecar-session-runtime';
import { getApiUrl } from './config';
import { resolveCanonicalPath } from './ipc/path-allowlist';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { sha256Hex } from '../shared/sha256-sync';

function isAdmissionBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createRuntime(root: string): BbiAdmissionRuntime {
  const readers = new Map<string, BigBed | BigWig>();
  return {
    async admit(input) {
      const source = input.source;
      if (source.kind !== 'path' && source.kind !== 'url')
        throw new Error('Unsupported Track View source.');
      const baseUrl = getApiUrl().replace(/\/+$/, '');
      const local = source.kind === 'path' ? await resolveCanonicalPath(source.path) : null;
      if (local && !isPathInsideBoundary(local, root))
        throw new Error('Track source resolves outside the selected project.');
      const authority = local
        ? issueLocalIndexedTrackAuthority({ path: local, workspaceGrounded: true })
        : null;
      const response = await sidecarFetch(`${baseUrl}/external/indexed-tracks/admit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_kind: source.kind === 'path' ? 'path' : 'url',
          source: authority?.canonicalPath ?? (source.kind === 'url' ? source.url : source.path),
          ...(authority ? { local_path_authority: authority.authority } : {}),
          format_id: input.formatId,
          provenance_id:
            input.provenanceId.length <= 500
              ? input.provenanceId
              : `indexed-source:${sha256Hex(input.provenanceId)}`,
          granted_capabilities: ['external-fetch:annotation'],
        }),
      });
      if (!response.ok) throw new Error(`Track source admission failed (${response.status}).`);
      const body = await response.json();
      if (
        !isAdmissionBody(body) ||
        body.format !== input.formatId ||
        typeof body.source_token !== 'string' ||
        typeof body.source_uri !== 'string' ||
        typeof body.canonical_url_hash !== 'string' ||
        typeof body.provenance_id !== 'string' ||
        typeof body.byte_length !== 'number' ||
        !Number.isFinite(body.byte_length) ||
        body.byte_length <= 0 ||
        typeof body.expires_in_seconds !== 'number' ||
        !Number.isFinite(body.expires_in_seconds) ||
        body.expires_in_seconds <= 0
      )
        throw new Error('Track source admission returned invalid metadata.');
      return {
        baseUrl,
        sourceUri: body.source_uri,
        sourceToken: body.source_token,
        canonicalUrlHash: body.canonical_url_hash,
        byteLength: body.byte_length,
        provenanceId: body.provenance_id,
        expiresAtMs: Date.now() + body.expires_in_seconds * 1000,
        ...(typeof body.etag === 'string' ? { etag: body.etag } : {}),
        ...(typeof body.last_modified === 'string' ? { lastModified: body.last_modified } : {}),
      };
    },
    reader: {
      async open(key, format, grant, signal) {
        const filehandle = new BbiRangeFile(`${grant.baseUrl}/external/range`, {
          headers: { 'X-DNAForge-Source-Token': grant.sourceToken },
          fetch: (input, init) => sidecarFetch(input.toString(), init),
        });
        const reader =
          format === 'bigwig' ? new BigWig({ filehandle }) : new BigBed({ filehandle });
        readers.set(key, reader);
        const header = await reader.getHeader({ signal });
        return {
          fileType: header.fileType,
          references: Object.values(header.refsByNumber)
            .filter((entry) => entry != null)
            .map((entry) => ({ name: entry.name, length: entry.length })),
          zoomReductionLevels: header.zoomLevels.map((entry) => entry.reductionLevel),
          ...(header.fileType === 'bigbed'
            ? { autoSql: header.autoSql, fieldCount: header.fieldCount }
            : {}),
          totalSummary: {
            basesCovered: header.totalSummary.basesCovered,
            scoreMin: header.totalSummary.scoreMin,
            scoreMax: header.totalSummary.scoreMax,
          },
        };
      },
      async closeSource(key) {
        readers.delete(key);
      },
      async queryQuantitative(key, regions, basesPerSpan, signal) {
        const reader = readers.get(key);
        if (!(reader instanceof BigWig)) throw new Error('Quantitative source is not open.');
        const packed = await reader.getFeaturesAsArraysMulti([...regions], {
          basesPerSpan,
          signal,
        });
        return regions.map((_region, index) => {
          const start = packed.regionOffsets[index] ?? 0;
          const end = packed.regionOffsets[index + 1] ?? start;
          return {
            starts: packed.starts.slice(start, end),
            ends: packed.ends.slice(start, end),
            values: packed.scores.slice(start, end),
          };
        });
      },
    },
  };
}

export async function admitTrackViewSource(
  input: TrackViewSourceInput,
  reference: PreparedReferenceAssemblyEntryV1,
  root: string
) {
  const request = directTrackAdmissionRequest({
    assemblyId: reference.id,
    input: input.source,
    formatId: input.format,
    ...(input.label ? { label: input.label } : {}),
    ingress: 'automation',
  });
  const admit = input.format === 'bigwig' ? admitIndexedBigWigRequest : admitIndexedBigBedRequest;
  return admit({
    request,
    assemblyReferences: reference.members.map((entry) => ({
      name: entry.chrom,
      length: entry.lengthBp!,
      aliases: entry.aliases
        ? Object.values(entry.aliases).flatMap((value) =>
            typeof value === 'string' ? [value] : (value ?? [])
          )
        : undefined,
    })),
    runtime: createRuntime(root),
  });
}

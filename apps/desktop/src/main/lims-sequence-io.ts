import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { decodeSequenceDocument, type AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  limsEntityFromRow,
  type DnaSequenceRef,
  type DnaSequenceSourceFormat,
  type DnaSequenceTopology,
  type FileDnaSequenceRef,
  type LimsEntity,
} from '../shared/lims';
import { getEntityRowById } from './lims-engine-core';
import { ScientificObjectStore } from './scientific-object-store';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import {
  defineBlob,
  parseResourceId,
  parseResourceRevisionId,
} from '@waypoint/workspace-revisions';

export function deleteRange(sequence: string, start: number, end: number): string {
  return `${sequence.slice(0, start - 1)}${sequence.slice(end)}`;
}

export function replaceBase(sequence: string, position: number, preferredAlt: string): string {
  const index = position - 1;
  const current = sequence[index]?.toUpperCase();
  const alt = current === preferredAlt.toUpperCase() ? 'C' : preferredAlt.toUpperCase();
  return `${sequence.slice(0, index)}${alt}${sequence.slice(index + 1)}`;
}

export function loadEntitySequence(
  entity: LimsEntity,
  role: string,
  db?: Database.Database
): { sequence: AnnotatedSequence; ref: DnaSequenceRef } {
  const ref = entity.fields.sequence as DnaSequenceRef | undefined;
  if (!ref || ref.mode === 'unresolved') {
    throw new Error(`${role} sequence is unresolved for ${entity.name}`);
  }
  if (ref.mode === 'inline') {
    const sequence = ref.bases.replace(/\s/g, '').toUpperCase();
    return {
      ref,
      sequence: {
        id: entity.id,
        name: entity.name,
        sequence,
        length: sequence.length,
        annotations: [],
        circular: false,
      },
    };
  }
  if (ref.acceptedRevisionId !== undefined) {
    const workspaceId = ref.workspaceId;
    if (
      !db ||
      typeof workspaceId !== 'number' ||
      !Number.isSafeInteger(workspaceId) ||
      workspaceId !== entity.workspaceId ||
      ref.documentId !== entity.id
    )
      throw new Error(`${role} accepted sequence requires its owning database workspace.`);
    if (typeof ref.documentId !== 'string' || typeof ref.acceptedRevisionId !== 'string')
      throw new Error(`${role} accepted sequence identity is invalid.`);
    const resourceId = parseResourceId(ref.documentId),
      revisionId = parseResourceRevisionId(ref.acceptedRevisionId);
    if (!resourceId.ok || !revisionId.ok)
      throw new Error(`${role} accepted sequence identity is invalid.`);
    const snapshot = new ScientificObjectStore(db, workspaceId)
      .read()
      .reader.revision({ resourceId: resourceId.value, revisionId: revisionId.value });
    if (!snapshot || snapshot.document.kind !== 'sequence')
      throw new Error(`${role} accepted sequence revision is unavailable.`);
    const document = snapshot.document;
    const text = snapshot.representation?.text ?? defineScientificDocument(document).text;
    const fileHash = defineBlob(new TextEncoder().encode(text)).hash;
    if (
      ref.length !== document.bases.length ||
      ref.topology !== document.topology ||
      ref.contentHash !== fileHash ||
      (ref.fileContentHash !== undefined && ref.fileContentHash !== fileHash) ||
      (ref.normalizedSequenceHash !== undefined &&
        ref.normalizedSequenceHash !==
          defineBlob(new TextEncoder().encode(document.bases.toUpperCase())).hash)
    )
      throw new Error(`${role} accepted sequence descriptor does not match its exact revision.`);
    if (snapshot.representation?.format === 'genbank-v1')
      return {
        ref,
        sequence: {
          ...parseSequenceContent(snapshot.representation.text, ref.relPath, ref.topology),
          id: entity.id,
          name: document.name,
        },
      };
    if (snapshot.representation || document.annotations.length)
      throw new Error(
        `${role} accepted sequence representation requires a qualified annotation reader.`
      );
    return {
      ref,
      sequence: {
        id: entity.id,
        name: document.name,
        sequence: document.bases,
        length: document.bases.length,
        circular: document.topology === 'circular',
        annotations: [],
      },
    };
  }
  if (!existsSync(ref.relPath)) {
    throw new Error(`${role} sequence file is missing: ${ref.relPath}`);
  }
  const content = isBinarySequencePath(ref.relPath)
    ? readFileSync(ref.relPath)
    : readFileSync(ref.relPath, 'utf8');
  return { ref, sequence: parseSequenceContent(content, ref.relPath, ref.topology) };
}

export function parseSequenceContent(
  content: string | ArrayBuffer | Uint8Array,
  filePath: string,
  fallbackTopology: DnaSequenceTopology = 'linear'
): AnnotatedSequence {
  const document = decodeSequenceDocument(content, {
    path: filePath,
    filename: filePath.split(/[\\/]/).pop() || filePath,
  });
  const parsed = document.sequence;
  const shouldUseFallbackTopology = document.format !== 'genbank' && document.format !== 'snapgene';
  return {
    ...parsed,
    circular: shouldUseFallbackTopology ? fallbackTopology === 'circular' : parsed.circular,
  };
}

export function resolveMarkerSequences(
  db: Database.Database,
  markerGenomeEntityIds: Record<string, string>
): Record<string, string> {
  const markerSequences: Record<string, string> = {};
  for (const [markerName, entityId] of Object.entries(markerGenomeEntityIds)) {
    const markerEntity = limsEntityFromRow(getEntityRowById(db, entityId));
    if (markerEntity.kind !== 'genome' && markerEntity.kind !== 'plasmid') {
      throw new Error(`Marker ${markerName} must reference a genome or plasmid entity`);
    }
    const loaded = loadEntitySequence(markerEntity, `marker ${markerName}`, db);
    const sequence = loaded.sequence.sequence.toUpperCase();
    markerSequences[markerName] = sequence;
    markerSequences[markerName.toLowerCase()] = sequence;
    markerSequences[markerEntity.name] = sequence;
    markerSequences[markerEntity.name.toLowerCase()] = sequence;
  }
  return markerSequences;
}

export function buildFileSequenceRef(
  filePath: string,
  content: string,
  options: {
    documentId: string;
    length: number;
    topology: DnaSequenceTopology;
    sourceFormat?: DnaSequenceSourceFormat;
  }
): FileDnaSequenceRef {
  const stat = statSync(filePath);
  const fileContentHash = sha256(content);
  const normalizedSequenceHash = normalizedSequenceHashForContent(content, filePath);
  return {
    mode: 'file',
    documentId: options.documentId,
    relPath: filePath,
    topology: options.topology,
    length: options.length,
    contentHash: fileContentHash,
    fileContentHash,
    normalizedSequenceHash,
    sourceFormat: options.sourceFormat ?? sourceFormatForPath(filePath),
    sequenceId: null,
    sizeBytes: stat.size,
    modifiedAt: stat.mtimeMs,
  };
}

export function normalizedSequenceHashForContent(
  content: string | ArrayBuffer | Uint8Array,
  filePath: string
): string | undefined {
  try {
    const document = decodeSequenceDocument(content, {
      path: filePath,
      filename: filePath.split(/[\\/]/).pop() || filePath,
    });
    return sha256(document.sequence.sequence.toUpperCase());
  } catch {
    return undefined;
  }
}

export function looksLikeGenBank(filePath: string, content: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.gb') ||
    lower.endsWith('.gbk') ||
    lower.endsWith('.genbank') ||
    /^\s*LOCUS\b/m.test(content)
  );
}

export function sourceFormatForPath(filePath: string): DnaSequenceSourceFormat {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.gb') || lower.endsWith('.gbk') || lower.endsWith('.genbank')) return 'gb';
  if (lower.endsWith('.dna')) return 'snapgene';
  if (
    lower.endsWith('.fa') ||
    lower.endsWith('.fasta') ||
    lower.endsWith('.fna') ||
    lower.endsWith('.ffn')
  ) {
    return 'fasta';
  }
  return 'unknown';
}

function isBinarySequencePath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'ab1' || ext === 'abi' || ext === 'dna';
}

export function sanitizePathStem(value: string): string {
  return (
    value
      .replace(/\.[A-Za-z0-9]+$/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'genome-hypothesis'
  );
}

export function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

import type { SequenceDesign } from '../features/design/types';
import {
  MOLECULAR_DOCUMENT_SCHEMA,
  isMolecularDocumentSchema,
  parseMolecularDocument,
  type MolecularDocument,
} from '../shared/molecular-document';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { NOTEBOOK_EMPTY_TIPTAP_DOC } from './notebook-package';

export type ParsedWorkspaceArtifact =
  | {
      schema: typeof MOLECULAR_DOCUMENT_SCHEMA;
      kind: 'molecular-document';
      id: string;
      name: string;
      document: MolecularDocument;
      raw: Record<string, unknown>;
    }
  | {
      schema: 'waypoint.notebook.v1';
      kind: 'notebook';
      id: string;
      title: string;
      content: unknown;
      raw: Record<string, unknown>;
    }
  | {
      schema: 'waypoint.design.v1';
      kind: 'assembly-design';
      id: string;
      name: string;
      design: SequenceDesign | null;
      raw: Record<string, unknown>;
    };

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function parseWorkspaceArtifact(content: string): ParsedWorkspaceArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid DNAForge artifact JSON');
  }

  const doc = objectValue(parsed);
  if (!doc) throw new Error('DNAForge artifact must be a JSON object');

  const schema = stringValue(doc.schema);
  if (isMolecularDocumentSchema(schema)) {
    const document = parseMolecularDocument(content);
    return {
      schema: document.schema,
      kind: 'molecular-document',
      id: document.id,
      name: document.name,
      document,
      raw: doc,
    };
  }
  const kind = stringValue(doc.kind);
  const rawEmbeddedId = stringValue(doc.id);
  if (!schema || !kind || !rawEmbeddedId) {
    throw new Error('DNAForge artifact is missing schema, kind, or id');
  }

  const id = stripWorkspaceScope(rawEmbeddedId);
  if (!id) {
    throw new Error('DNAForge artifact id is empty after stripping workspace scope');
  }
  if (id !== rawEmbeddedId) {
    console.warn(
      `[workspace-artifacts] stripped inherited workspace scope from embedded id: ${rawEmbeddedId} → ${id}`
    );
  }

  if (schema === 'waypoint.notebook.v1' && kind === 'notebook') {
    return {
      schema,
      kind,
      id,
      title: stringValue(doc.title) ?? 'Untitled',
      content: doc.content ?? NOTEBOOK_EMPTY_TIPTAP_DOC,
      raw: doc,
    };
  }

  if (schema === 'waypoint.design.v1' && kind === 'assembly-design') {
    return {
      schema,
      kind,
      id,
      name: stringValue(doc.name) ?? 'Untitled',
      design: (objectValue(doc.design) as SequenceDesign | null) ?? null,
      raw: doc,
    };
  }

  throw new Error(`Unsupported DNAForge artifact schema: ${schema}/${kind}`);
}

import {
  MOLECULAR_DOCUMENT_SCHEMA,
  molecularDocumentSchema,
  type MolecularDocument,
} from './molecular-document';
import { MOLECULAR_VIEW_MAX_COORDINATE_BYTES, coordinateDigest } from './molecular-view';

export const DEFAULT_MOLECULAR_VIEW_MARKER = 'dnaforge_default_view';

const PLACEHOLDER_PREVIEW =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

export type PackagedCoordinateFormat = 'pdb' | 'cif' | 'bcif';

export function packagedCoordinateFormat(fileName: string): PackagedCoordinateFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdb') || lower.endsWith('.ent')) return 'pdb';
  if (lower.endsWith('.cif') || lower.endsWith('.mmcif')) return 'cif';
  if (lower.endsWith('.bcif')) return 'bcif';
  return null;
}

export function coordinateFileStem(fileName: string): string {
  return fileName.replace(/\.(pdb|ent|cif|mmcif|bcif)$/i, '');
}

export function isDefaultMolecularScene(scene: string): boolean {
  try {
    return JSON.parse(scene)?.root?.custom?.[DEFAULT_MOLECULAR_VIEW_MARKER] === true;
  } catch {
    return false;
  }
}

function defaultMolecularScene(format: PackagedCoordinateFormat, title: string, createdAt: number) {
  return JSON.stringify({
    kind: 'single',
    metadata: { version: '1', timestamp: new Date(createdAt).toISOString(), title },
    root: {
      kind: 'root',
      custom: { [DEFAULT_MOLECULAR_VIEW_MARKER]: true },
      children: [
        {
          kind: 'download',
          params: { url: `structure.${format}` },
          children: [
            {
              kind: 'parse',
              params: { format: format === 'cif' ? 'mmcif' : format },
              children: [{ kind: 'structure', params: { type: 'model' } }],
            },
          ],
        },
      ],
    },
  });
}

export async function buildDefaultMolecularDocument(input: {
  name: string;
  format: PackagedCoordinateFormat;
  text: string;
  createdAt: number;
  documentId: string;
  referenceId: string;
  source?: { source: string; sourceId?: string };
}): Promise<MolecularDocument> {
  if (new TextEncoder().encode(input.text).byteLength > MOLECULAR_VIEW_MAX_COORDINATE_BYTES)
    throw new Error('The coordinate file is larger than a molecular view can hold.');
  const title = input.name.trim().slice(0, 200) || 'Structure';
  return molecularDocumentSchema.parse({
    schema: MOLECULAR_DOCUMENT_SCHEMA,
    id: input.documentId,
    name: title,
    currentReferenceId: input.referenceId,
    history: [
      {
        referenceId: input.referenceId,
        snapshot: {
          kind: 'molecular-view',
          version: 1,
          title,
          caption: '',
          scene: defaultMolecularScene(input.format, title, input.createdAt),
          coordinates: {
            format: input.format,
            text: input.text,
            sha256: await coordinateDigest(input.text),
          },
          source: input.source ?? { source: 'file' },
          evidence: [],
          preview: PLACEHOLDER_PREVIEW,
          createdAt: input.createdAt,
          presentation: { id: input.documentId },
        },
      },
    ],
  });
}

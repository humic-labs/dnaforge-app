export const SOURCE_DOCUMENT_MARKER = 'source-document.json';
export const SOURCE_DOCUMENT_MARKER_PATH = '.forge/source-document.json';
export const SOURCE_DOCUMENT_SCHEMA = 'dnaforge.source-document.v1';

export type SourceDocumentFamily = 'fasta' | 'structure' | 'chromatogram';
export type SourceDocumentPresentation =
  | 'sequence-package'
  | 'fasta-collection'
  | 'molecular-document'
  | 'coordinate-asset'
  | 'chromatogram';

export interface SourceDocumentDescriptor {
  packageId: string;
  familyId: SourceDocumentFamily;
  sourceName: string;
  sha256: string;
  packageRoot: string;
  originalPath: string;
  entryPath: string;
  productPaths: string[];
  presentation: SourceDocumentPresentation;
}

export type SourceDocumentPresentationData =
  | {
      familyId: 'fasta';
      sourceSha256: string;
      records: { name: string; description?: string; sequence: string; length: number }[];
    }
  | {
      familyId: 'structure';
      sourceSha256: string;
      documentId: string;
      coordinates: { format: 'pdb' | 'cif' | 'bcif'; text: string; sha256: string };
    }
  | {
      familyId: 'structure';
      sourceSha256: string;
      coordinateAsset: { format: 'pdb' | 'cif' | 'bcif'; bytes: Uint8Array };
    }
  | { familyId: 'chromatogram'; sourceSha256: string; bytes: Uint8Array };

export function isSourceDocumentMarkerPath(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .toLowerCase()
    .endsWith('/' + SOURCE_DOCUMENT_MARKER_PATH);
}

import { isWorkbookFileName } from '../ingress';

export type LimsImportSource =
  | { kind: 'file'; file: File }
  | {
      kind: 'paste';
      text: string;
      kindLabel: string;
    }
  | {
      kind: 'connector';
      connectorId: string;
      resourceId: string;
      displayName: string;
    };

export interface ResolvedImportSource {
  fileName: string;
  isWorkbook: boolean;
  text?: string;
  arrayBuffer?: ArrayBuffer;
  sourcePath?: string;
}

export async function resolveImportSource(
  source: LimsImportSource,
  getPathForFile: (file: File) => string
): Promise<ResolvedImportSource> {
  if (source.kind === 'file') {
    const { file } = source;
    const isWorkbook = isWorkbookFileName(file.name);
    return {
      fileName: file.name,
      isWorkbook,
      sourcePath: getPathForFile(file) || undefined,
      text: isWorkbook ? undefined : await file.text(),
      arrayBuffer: isWorkbook ? await file.arrayBuffer() : undefined,
    };
  }
  if (source.kind === 'paste') {
    const text = source.text.replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
    const extension =
      source.kindLabel === 'protein' && firstLine.trimStart().startsWith('>')
        ? 'fasta'
        : firstLine.includes('\t')
          ? 'tsv'
          : 'csv';
    return {
      fileName: `pasted-${source.kindLabel}.${extension}`,
      isWorkbook: false,
      text,
      sourcePath: undefined,
    };
  }
  throw new Error(`Import connector "${source.connectorId}" is not available yet.`);
}

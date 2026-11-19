import { HANDLER_FAMILIES, type HandlerFamilyId } from './file-associations';

export type SourceViewerFormat = Exclude<HandlerFamilyId, 'genbank' | 'snapgene'>;

export interface SourceFileView {
  path: string;
  format: SourceViewerFormat;
  location: 'external' | 'project';
}

export function externalFormatForPath(path: string): HandlerFamilyId | null {
  const name = path.split(/[\\/]/u).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return HANDLER_FAMILIES.find((family) => family.extensions.includes(ext))?.id ?? null;
}

export function externalPreviewFilters() {
  return [
    { name: 'Supported files', extensions: HANDLER_FAMILIES.flatMap((f) => [...f.extensions]) },
    ...HANDLER_FAMILIES.map((f) => ({ name: f.displayName, extensions: [...f.extensions] })),
  ];
}

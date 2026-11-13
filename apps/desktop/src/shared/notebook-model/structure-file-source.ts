export function structureFileSource<T extends object>(
  attrs: T,
  content: string,
  fileName: string
): Omit<T, 'source' | 'sourceId' | 'label' | 'error'> & {
  source: 'file';
  sourceId: string;
  label: string;
  error: undefined;
} {
  return { ...attrs, source: 'file', sourceId: content, label: fileName, error: undefined };
}

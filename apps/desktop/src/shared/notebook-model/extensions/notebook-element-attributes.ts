export function readNotebookElementAttribute(element: unknown, name: string): string | null {
  if (typeof element !== 'object' || element === null) return null;
  const getter: unknown = Reflect.get(element, 'getAttribute');
  if (typeof getter !== 'function') return null;
  const value: unknown = Reflect.apply(getter, element, [name]);
  return typeof value === 'string' ? value : null;
}

export function readNotebookElementStyle(element: unknown, name: string): string | null {
  if (typeof element !== 'object' || element === null) return null;
  const style: unknown = Reflect.get(element, 'style');
  if (typeof style !== 'object' || style === null) return null;
  const value: unknown = Reflect.get(style, name);
  return typeof value === 'string' ? value : null;
}

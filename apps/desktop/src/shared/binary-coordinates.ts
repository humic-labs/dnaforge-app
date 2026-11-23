export function binaryCoordinateByteLength(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

export function isBinaryCoordinateText(text: string): boolean {
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}(?![\s\S])/.test(text);
}

export function binaryCoordinateText(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkBytes = 24 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes))));
  return chunks.join('');
}

export function binaryCoordinateBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function coordinateStructureData(coordinates: {
  format: string;
  text: string;
}): string | Uint8Array<ArrayBuffer> {
  return coordinates.format === 'bcif' ? binaryCoordinateBytes(coordinates.text) : coordinates.text;
}

export function textCoordinates<T extends { format: 'pdb' | 'cif' | 'bcif' }>(
  coordinates: T
): T & { format: 'pdb' | 'cif' } {
  if (!isTextCoordinates(coordinates))
    throw new Error('This needs text PDB or mmCIF coordinates, not binary CIF.');
  return coordinates;
}

function isTextCoordinates<T extends { format: 'pdb' | 'cif' | 'bcif' }>(
  coordinates: T
): coordinates is T & { format: 'pdb' | 'cif' } {
  return coordinates.format !== 'bcif';
}

export const BINARY_COORDINATE_TEXT =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function binaryCoordinateText(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function binaryCoordinateBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function coordinateStructureData(coordinates: {
  format: string;
  text: string;
}): string | Uint8Array {
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

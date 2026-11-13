export const NATIVE_MUTATION_REQUEST_VERSION = 'canonical-json-v1';

export function canonicalNativeMutationRequest(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Native mutation request is not JSON.');
  return orderedJson(JSON.parse(json));
}

function orderedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(orderedJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${orderedJson(entry)}`)
      .join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Native mutation request is not JSON.');
  return json;
}

export function nativeMutationRequestBytes(value: unknown, version: unknown): string {
  if (version === NATIVE_MUTATION_REQUEST_VERSION) return canonicalNativeMutationRequest(value);
  if (version !== undefined)
    throw new Error('Native mutation request hash version is unsupported.');
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Native mutation request is not JSON.');
  return json;
}

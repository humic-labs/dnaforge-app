import type { CanonicalValue } from '@waypoint/workspace-revisions';

export function canonicalPayload(value: unknown): string {
  let nodes = 0;
  const active = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 64) throw new TypeError('Scientific JSON is too complex.');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      if (/\p{Surrogate}/u.test(item))
        throw new TypeError('Scientific JSON contains invalid Unicode.');
      return JSON.stringify(item);
    }
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null)
      throw new TypeError('Scientific data must be JSON.');
    if (active.has(item)) throw new TypeError('Scientific JSON contains a cycle.');
    active.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length)
        throw new TypeError('Scientific JSON cannot have symbol keys.');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(item) && key === 'length') continue;
        if (!descriptor.enumerable || !('value' in descriptor))
          throw new TypeError('Scientific JSON must contain ordinary data fields.');
      }
      if (Array.isArray(item)) {
        if (
          Object.keys(item).length !== item.length ||
          Object.keys(item).some((key, index) => key !== String(index))
        )
          throw new TypeError('Scientific arrays must be dense.');
        return `[${item.map((entry) => encode(entry, depth + 1)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Scientific data must be plain JSON.');
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${encode(key, depth + 1)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`
        )
        .join(',')}}`;
    } finally {
      active.delete(item);
    }
  }
  return encode(value, 0);
}

export function freezeJson<Value extends CanonicalValue>(value: Value): Value {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

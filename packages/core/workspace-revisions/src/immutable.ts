export function deepFreeze<Value>(value: Value): Value {
  return freezeValue(value, new WeakSet<object>());
}

function freezeValue<Value>(value: Value, visited: WeakSet<object>): Value {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  const properties = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(object)) freezeValue(properties[key], visited);
  return Object.freeze(value);
}

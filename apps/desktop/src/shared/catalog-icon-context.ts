import type { EntityColorContext } from './entity-color-family';

export function catalogIconContext(input: {
  kind?: string | null;
  path?: string | null;
  metadata?: string | null;
}): EntityColorContext | undefined {
  let metadata: Record<string, unknown> = {};
  if (input.metadata) {
    try {
      const parsed: unknown = JSON.parse(input.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        metadata = Object.fromEntries(Object.entries(parsed));
    } catch {}
  }
  const schema = metadata.entitySchema;
  const schemaName =
    schema && typeof schema === 'object' && 'name' in schema && typeof schema.name === 'string'
      ? schema.name
      : undefined;
  const decision = metadata.classificationDecision;
  const molecule =
    decision &&
    typeof decision === 'object' &&
    'molecule' in decision &&
    (decision.molecule === 'dna' || decision.molecule === 'rna')
      ? decision.molecule
      : undefined;
  const kind =
    schemaName && (!input.kind || input.kind === 'sequence' || input.kind === 'primer')
      ? schemaName
      : input.kind || schemaName;
  const path =
    input.path || (typeof metadata.relativePath === 'string' ? metadata.relativePath : undefined);
  if (!kind && !path && !molecule) return undefined;
  return {
    ...(kind ? { kind } : {}),
    ...(path ? { path } : {}),
    ...(molecule ? { molecule } : {}),
  };
}

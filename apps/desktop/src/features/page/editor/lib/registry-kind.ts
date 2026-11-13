import { canonicalEntityIconKind } from '../../../../components/icons/entity-icon-registry';
import { LIMS_BUILTIN_ENTITY_SCHEMAS } from '../../../../shared/lims';

const builtinDisplayNames = new Map<string, string>(
  LIMS_BUILTIN_ENTITY_SCHEMAS.map((schema) => [schema.name, schema.displayName])
);

export function registryKindLabel(kind: string | null | undefined): string {
  if (!kind) return 'Registry record';
  return (
    builtinDisplayNames.get(kind) ??
    kind.replace(/[-_]+/g, ' ').replace(/^./, (first) => first.toUpperCase())
  );
}

export function registryKindIconKind(kind: string | null | undefined): string {
  return kind && canonicalEntityIconKind(kind) ? kind : 'record';
}

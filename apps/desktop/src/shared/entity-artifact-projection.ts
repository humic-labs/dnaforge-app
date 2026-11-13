import { contentFingerprint } from './content-fingerprint';

export function canonicalEntityArtifactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEntityArtifactValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalEntityArtifactValue(child)])
  );
}

export function canonicalEntityArtifactProjection(input: {
  kind: string;
  name: string;
  fields: Record<string, unknown>;
  registrationStatus: string;
  domainStatus: string | null;
  schemaRevisionId: string | null;
  archived: boolean;
}): unknown {
  return canonicalEntityArtifactValue({
    kind: input.kind,
    name: input.name,
    fields: input.fields,
    registrationStatus: input.registrationStatus,
    domainStatus: input.domainStatus,
    schemaRevisionId: input.schemaRevisionId,
    archived: input.archived,
  });
}

export function entityArtifactProjectionFingerprint(
  input: Parameters<typeof canonicalEntityArtifactProjection>[0]
): string {
  return contentFingerprint(JSON.stringify(canonicalEntityArtifactProjection(input)));
}

export function entityArtifactProjectionContent(
  input: Parameters<typeof canonicalEntityArtifactProjection>[0]
): string {
  return JSON.stringify(canonicalEntityArtifactProjection(input));
}

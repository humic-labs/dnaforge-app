const UUID_IN_PROSE =
  /(?<![\w:/=])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

export function claimsCompletedBiologyArtifact(content: string): boolean {
  return /(?:\b(?:I|we)\s+(?:have\s+)?|^\s*)(?:built|created|drafted|saved|generated|assembled|imported|updated)\b[^.!?\n]{0,120}\b(?:design|plasmid|sequence|notebook)\b/imu.test(
    content
  );
}

export function sanitizeAssistantArtifactMetadata(
  content: string,
  artifactIds: ReadonlySet<string> = new Set<string>()
): string {
  return content
    .replace(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:Design|Document)\s+ID(?:\*\*)?\s*:\s*[^\n]*$/gimu, '')
    .replace(/^\s*(?:[-*]\s*)?(?:\*\*)?Resource\s+URI(?:\*\*)?\s*:\s*[^\n]*$/gimu, '')
    .replace(
      /\b(?:(?:its|the|this)\s+)?(?:document|design)\s+id\s+(?:is|was)\s+(?:[0-9a-f-]{36}|blank)\s*[.;]?\s*/giu,
      ''
    )
    .replace(/\[([^\]]+)\]\(waypoint:\/\/(?:design|sequence)\/[^)]+\)/giu, '$1')
    .replace(/waypoint:\/\/(?:design|sequence)\/[^\s)]+/giu, '')
    .replace(/\b(?:Design|Document)\s+ID\s*:\s*(?:[0-9a-f-]{36}|blank)\b/giu, '')
    .replace(UUID_IN_PROSE, (id) => (artifactIds.has(id.toLowerCase()) ? '' : id))
    .replace(/\b(?:Design|Document)\s+ID\s*:\s*(?=$|\n)/gimu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

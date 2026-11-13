const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function analyticsOrganizationId(
  organizations: ReadonlyArray<{ readonly orgId: string }>
): string | null {
  const ids = [...new Set(organizations.map((organization) => organization.orgId))];
  return ids.length === 1 && UUID_RE.test(ids[0]) ? ids[0] : null;
}

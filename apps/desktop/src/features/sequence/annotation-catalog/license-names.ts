const FRIENDLY_LICENSE_NAMES: ReadonlyMap<string, string> = new Map([
  ['CC0-1.0', 'Public domain (CC0)'],
  ['CC-BY-4.0', 'CC BY 4.0'],
  ['LicenseRef-DNAForge-generated', 'Computed by DNAForge'],
  ['LicenseRef-SRI-BioCyc-Open-Database', 'SRI BioCyc terms'],
]);

export function friendlyLicenseName(licenseId: string | null): string {
  if (licenseId === null) return 'Licence not stated';
  return FRIENDLY_LICENSE_NAMES.get(licenseId) ?? licenseId;
}

export type AnalyticsConsentRegime = 'opt_in' | 'opt_out';

export interface AnalyticsRegionSignals {
  countryCode?: string | null;
  timeZone?: string | null;
}

const EU_MEMBER_STATES = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
];
const EU_ALTERNATE_CODES_FOR_GREECE_AND_UK = ['EL', 'UK'];
const EU_REGIONS_WITH_OWN_CODES = ['AX', 'GF', 'GP', 'MQ', 'MF', 'RE', 'YT', 'IC', 'EA'];
const EEA_MEMBERS_OUTSIDE_EU = ['IS', 'LI', 'NO'];
const UK_CROWN_DEPENDENCIES_AND_GIBRALTAR = ['GB', 'GG', 'JE', 'IM', 'GI'];
const SWITZERLAND = ['CH'];
const UN_M49_EUROPE_AND_SUBREGIONS = ['150', '039', '151', '154', '155'];

const OPT_IN_COUNTRY_CODES = new Set([
  ...EU_MEMBER_STATES,
  ...EU_ALTERNATE_CODES_FOR_GREECE_AND_UK,
  ...EU_REGIONS_WITH_OWN_CODES,
  ...EEA_MEMBERS_OUTSIDE_EU,
  ...UK_CROWN_DEPENDENCIES_AND_GIBRALTAR,
  ...SWITZERLAND,
  ...UN_M49_EUROPE_AND_SUBREGIONS,
]);

const WORLD_OR_UNKNOWN_REGION_CODES = new Set(['001', 'ZZ']);

const OPT_IN_ZONES_OUTSIDE_EUROPE_AREA = [
  'Africa/Ceuta',
  'America/Cayenne',
  'America/Guadeloupe',
  'America/Marigot',
  'America/Martinique',
  'America/St_Barthelemy',
  'Arctic/Longyearbyen',
  'Asia/Famagusta',
  'Asia/Nicosia',
  'Atlantic/Azores',
  'Atlantic/Canary',
  'Atlantic/Faroe',
  'Atlantic/Madeira',
  'Atlantic/Reykjavik',
  'Indian/Mayotte',
  'Indian/Reunion',
];
const LEGACY_EUROPEAN_ZONE_NAMES = [
  'CET',
  'EET',
  'MET',
  'WET',
  'Eire',
  'GB',
  'GB-Eire',
  'Iceland',
  'Poland',
  'Portugal',
];
const OPT_IN_TIME_ZONES = new Set([
  ...OPT_IN_ZONES_OUTSIDE_EUROPE_AREA,
  ...LEGACY_EUROPEAN_ZONE_NAMES,
]);
const EVERY_EUROPE_AREA_ZONE = 'Europe/';

const OPT_OUT_TIME_ZONE_AREAS =
  /^(Africa|America|Antarctica|Asia|Atlantic|Australia|Indian|Pacific|US|Canada|Brazil|Mexico|Chile)\//;

function countryRegime(countryCode: unknown): AnalyticsConsentRegime | null {
  const code = typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '';
  if (!/^(?:[A-Z]{2}|\d{3})$/.test(code) || WORLD_OR_UNKNOWN_REGION_CODES.has(code)) return null;
  return OPT_IN_COUNTRY_CODES.has(code) ? 'opt_in' : 'opt_out';
}

function timeZoneRegime(timeZone: unknown): AnalyticsConsentRegime | null {
  const zone = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (!zone) return null;
  if (zone.startsWith(EVERY_EUROPE_AREA_ZONE) || OPT_IN_TIME_ZONES.has(zone)) return 'opt_in';
  return OPT_OUT_TIME_ZONE_AREAS.test(zone) ? 'opt_out' : null;
}

export function localeCountryCode(locale: unknown): string | null {
  if (typeof locale !== 'string') return null;
  const region = locale
    .split(/[-_]/)
    .slice(1)
    .find((part) => /^(?:[A-Za-z]{2}|\d{3})$/.test(part));
  return region ? region.toUpperCase() : null;
}

export function resolveAnalyticsConsentRegime(
  signals: AnalyticsRegionSignals
): AnalyticsConsentRegime {
  const country = countryRegime(signals.countryCode);
  const zone = timeZoneRegime(signals.timeZone);
  if (country === 'opt_in' || zone === 'opt_in') return 'opt_in';
  if (country === 'opt_out' || zone === 'opt_out') return 'opt_out';
  return 'opt_in';
}

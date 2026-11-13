import { describe, expect, it } from 'vitest';
import { localeCountryCode, resolveAnalyticsConsentRegime } from './consent-regime';

describe('desktop analytics consent regime', () => {
  it.each([
    ['DE', null, 'opt_in'],
    ['fr', null, 'opt_in'],
    ['IE', null, 'opt_in'],
    ['NO', null, 'opt_in'],
    ['IS', null, 'opt_in'],
    ['LI', null, 'opt_in'],
    ['GB', null, 'opt_in'],
    ['CH', null, 'opt_in'],
    ['RE', null, 'opt_in'],
    ['150', null, 'opt_in'],
    ['US', null, 'opt_out'],
    ['JP', null, 'opt_out'],
    ['BR', null, 'opt_out'],
    ['419', null, 'opt_out'],
    [null, 'Europe/Berlin', 'opt_in'],
    [null, 'Europe/London', 'opt_in'],
    [null, 'Europe/Zurich', 'opt_in'],
    [null, 'Europe/Zagreb', 'opt_in'],
    [null, 'Atlantic/Canary', 'opt_in'],
    [null, 'Atlantic/Reykjavik', 'opt_in'],
    [null, 'Asia/Nicosia', 'opt_in'],
    [null, 'Indian/Reunion', 'opt_in'],
    [null, 'CET', 'opt_in'],
    [null, 'America/New_York', 'opt_out'],
    [null, 'US/Pacific', 'opt_out'],
    [null, 'Asia/Tokyo', 'opt_out'],
    [null, 'Australia/Sydney', 'opt_out'],
    [null, 'Atlantic/Bermuda', 'opt_out'],
    ['US', 'Europe/Paris', 'opt_in'],
    ['DE', 'America/New_York', 'opt_in'],
    ['US', 'UTC', 'opt_out'],
    [null, null, 'opt_in'],
    ['', '', 'opt_in'],
    ['ZZ', 'UTC', 'opt_in'],
    ['001', 'Etc/GMT+3', 'opt_in'],
    [null, 'Mars/Olympus_Mons', 'opt_in'],
    ['not-a-code', 'GMT', 'opt_in'],
  ] as const)('country=%s timeZone=%s -> %s', (countryCode, timeZone, regime) => {
    expect(resolveAnalyticsConsentRegime({ countryCode, timeZone })).toBe(regime);
  });

  it('reads the region subtag of a locale', () => {
    expect(localeCountryCode('de-AT')).toBe('AT');
    expect(localeCountryCode('en_GB')).toBe('GB');
    expect(localeCountryCode('en-150')).toBe('150');
    expect(localeCountryCode('zh-Hant-TW')).toBe('TW');
    expect(localeCountryCode('en')).toBeNull();
    expect(localeCountryCode(undefined)).toBeNull();
  });
});

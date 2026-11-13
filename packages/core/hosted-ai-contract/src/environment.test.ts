import { describe, expect, it } from 'vitest';
import { hostedEnvironmentProfile, hostedServiceEnvironmentProfile } from './environment.js';

describe('Hosted environment authority profiles', () => {
  it.each([
    ['local', 'development', null, null, null],
    [
      'staging',
      'staging',
      'rhezskdgtooutzhebfle',
      'staging.dnaforge.com',
      'dnaforge-1-resource.services.ai.azure.com',
    ],
    [
      'production',
      'production',
      'jklyskbgvrgniksvniuo',
      'dnaforge.com',
      'dnaforge-production.openai.azure.com',
    ],
  ] as const)(
    'maps %s to one explicit authority and identity set',
    (runtime, authority, supabaseProjectRef, desktopHostname, azureFoundryHostname) => {
      expect(hostedEnvironmentProfile(runtime)).toEqual({
        runtime,
        authority,
        supabaseProjectRef,
        desktopHostname,
        azureFoundryHostname,
      });
    }
  );

  it('rejects permissive aliases instead of guessing an authority environment', () => {
    for (const value of ['', 'dev', 'prod', 'test', 'STAGING']) {
      expect(() => hostedEnvironmentProfile(value)).toThrow(
        'must be local, staging, or production'
      );
    }
  });

  it('exposes only staging and production as deployable Hosted service profiles', () => {
    expect(hostedServiceEnvironmentProfile('staging')).toMatchObject({
      runtime: 'staging',
      authority: 'staging',
    });
    expect(hostedServiceEnvironmentProfile('production')).toMatchObject({
      runtime: 'production',
      authority: 'production',
    });
    expect(() => hostedServiceEnvironmentProfile('local')).toThrow('local is unsupported');
  });
});

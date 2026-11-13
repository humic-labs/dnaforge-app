// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  HOSTED_AI_GATEWAY_CONFIGURED_MARKER,
  HOSTED_AI_GATEWAY_EMPTY_MARKER,
  HOSTED_AI_MAIN_DISABLED_MARKER,
  HOSTED_AI_RENDERER_DISABLED_MARKER,
  PACKAGED_AUTH_RELEASE_A_MARKER,
  resolveHostedAiBuildPolicy,
} from './hosted-ai-build-policy';

describe('Release A Hosted AI build policy', () => {
  it('disables Hosted and strips a configured gateway from production builds', () => {
    expect(
      resolveHostedAiBuildPolicy({
        mode: 'production',
        releaseBuild: undefined,
        releaseADisabledAcknowledgement: undefined,
        releaseBHosted: false,
        configuredGatewayUrl: 'https://hostile.invalid',
      })
    ).toEqual({
      enabled: false,
      gatewayUrl: '',
      gatewayMarker: HOSTED_AI_GATEWAY_EMPTY_MARKER,
      mainMarker: HOSTED_AI_MAIN_DISABLED_MARKER,
      rendererMarker: HOSTED_AI_RENDERER_DISABLED_MARKER,
      packagedAuthOrigin: 'https://dnaforge.com',
      packagedAuthMarker: PACKAGED_AUTH_RELEASE_A_MARKER,
    });
  });

  it('requires an explicit Release A acknowledgement for official builds', () => {
    expect(() =>
      resolveHostedAiBuildPolicy({
        mode: 'production',
        releaseBuild: '1',
        releaseADisabledAcknowledgement: undefined,
        releaseBHosted: false,
        configuredGatewayUrl: undefined,
      })
    ).toThrow(/DNAFORGE_HOSTED_AI_RELEASE_A_DISABLED=1/);
  });

  it('refuses an acknowledged official build in a non-production mode', () => {
    expect(() =>
      resolveHostedAiBuildPolicy({
        mode: 'test',
        releaseBuild: '1',
        releaseADisabledAcknowledgement: '1',
        releaseBHosted: false,
        configuredGatewayUrl: undefined,
      })
    ).toThrow(/must use production mode/);
  });

  it('keeps Hosted available in development for qualification work', () => {
    expect(
      resolveHostedAiBuildPolicy({
        mode: 'development',
        releaseBuild: undefined,
        releaseADisabledAcknowledgement: undefined,
        releaseBHosted: false,
        configuredGatewayUrl: 'https://hosted.example.test/',
      })
    ).toMatchObject({
      enabled: true,
      gatewayUrl: 'https://hosted.example.test',
      gatewayMarker: HOSTED_AI_GATEWAY_CONFIGURED_MARKER,
      packagedAuthOrigin: 'https://dnaforge.com',
      packagedAuthMarker: PACKAGED_AUTH_RELEASE_A_MARKER,
    });
  });

  it('enables an official Release B only for its canonical sealed gateway origin', () => {
    expect(
      resolveHostedAiBuildPolicy({
        mode: 'production',
        releaseBuild: '1',
        releaseADisabledAcknowledgement: undefined,
        releaseBHosted: true,
        configuredGatewayUrl: 'https://hosted.dnaforge.com',
      })
    ).toMatchObject({
      enabled: true,
      gatewayUrl: 'https://hosted.dnaforge.com',
      gatewayMarker: HOSTED_AI_GATEWAY_CONFIGURED_MARKER,
      packagedAuthOrigin: 'https://hosted.dnaforge.com',
      packagedAuthMarker:
        'DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=https://hosted.dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END',
    });
  });

  it.each([
    '',
    'http://hosted.dnaforge.com',
    'https://user@hosted.dnaforge.com',
    'https://hosted.dnaforge.com/path',
  ])('refuses malformed Release B gateway authority %j', (configuredGatewayUrl) => {
    expect(() =>
      resolveHostedAiBuildPolicy({
        mode: 'production',
        releaseBuild: '1',
        releaseADisabledAcknowledgement: undefined,
        releaseBHosted: true,
        configuredGatewayUrl,
      })
    ).toThrow(/canonical HTTPS gateway origin/);
  });
});

export const HOSTED_AI_MAIN_ENABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:enabled';
export const HOSTED_AI_MAIN_DISABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_MAIN:disabled';
export const HOSTED_AI_GATEWAY_EMPTY_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:empty';
export const HOSTED_AI_GATEWAY_CONFIGURED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_GATEWAY:configured';
export const HOSTED_AI_RENDERER_ENABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_RENDERER:enabled';
export const HOSTED_AI_RENDERER_DISABLED_MARKER = 'DNAFORGE_RELEASE_A_HOSTED_RENDERER:disabled';

export const PACKAGED_AUTH_RELEASE_A_ORIGIN = 'https://dnaforge.com';
export const PACKAGED_AUTH_RELEASE_A_MARKER =
  'DNAFORGE_PACKAGED_AUTH=release-a::ORIGIN=https://dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END';
const PACKAGED_AUTH_RELEASE_B_PREFIX = 'DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=';
const PACKAGED_AUTH_SUFFIX = '::DESKTOP_AUTH_AUTHORITY_V1::END';

export interface HostedAiBuildPolicyInput {
  mode: string;
  releaseBuild: string | undefined;
  releaseADisabledAcknowledgement: string | undefined;
  releaseBHosted: boolean;
  configuredGatewayUrl: string | undefined;
}

export interface HostedAiBuildPolicy {
  enabled: boolean;
  gatewayUrl: string;
  gatewayMarker: string;
  mainMarker: string;
  rendererMarker: string;
  packagedAuthOrigin: string;
  packagedAuthMarker: string;
}

export function resolveHostedAiBuildPolicy(input: HostedAiBuildPolicyInput): HostedAiBuildPolicy {
  const officialRelease = input.releaseBuild === '1';
  if (officialRelease && !input.releaseBHosted && input.releaseADisabledAcknowledgement !== '1') {
    throw new Error('Official Release A builds require DNAFORGE_HOSTED_AI_RELEASE_A_DISABLED=1.');
  }
  if (officialRelease && input.mode !== 'production') {
    throw new Error('Official desktop builds must use production mode.');
  }

  const enabled = input.releaseBHosted || input.mode !== 'production';
  const gatewayUrl = enabled ? (input.configuredGatewayUrl ?? '').trim().replace(/\/+$/, '') : '';
  if (input.releaseBHosted) {
    let gateway: URL;
    try {
      gateway = new URL(gatewayUrl);
    } catch {
      throw new Error('Release B Hosted requires one canonical HTTPS gateway origin.');
    }
    if (
      gateway.protocol !== 'https:' ||
      gateway.username !== '' ||
      gateway.password !== '' ||
      gateway.pathname !== '/' ||
      gateway.search !== '' ||
      gateway.hash !== '' ||
      gateway.origin !== gatewayUrl
    ) {
      throw new Error('Release B Hosted requires one canonical HTTPS gateway origin.');
    }
  }
  return {
    enabled,
    gatewayUrl,
    gatewayMarker: gatewayUrl
      ? HOSTED_AI_GATEWAY_CONFIGURED_MARKER
      : HOSTED_AI_GATEWAY_EMPTY_MARKER,
    mainMarker: enabled ? HOSTED_AI_MAIN_ENABLED_MARKER : HOSTED_AI_MAIN_DISABLED_MARKER,
    rendererMarker: enabled
      ? HOSTED_AI_RENDERER_ENABLED_MARKER
      : HOSTED_AI_RENDERER_DISABLED_MARKER,
    packagedAuthOrigin: input.releaseBHosted ? gatewayUrl : PACKAGED_AUTH_RELEASE_A_ORIGIN,
    packagedAuthMarker: input.releaseBHosted
      ? `${PACKAGED_AUTH_RELEASE_B_PREFIX}${gatewayUrl}${PACKAGED_AUTH_SUFFIX}`
      : PACKAGED_AUTH_RELEASE_A_MARKER,
  };
}

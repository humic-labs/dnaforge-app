export type HostedRuntimeEnvironment = 'local' | 'staging' | 'production';
export type HostedAuthorityEnvironment = 'development' | 'staging' | 'production';
export type HostedServiceRuntimeEnvironment = Exclude<HostedRuntimeEnvironment, 'local'>;
export type HostedServiceAuthorityEnvironment = Exclude<HostedAuthorityEnvironment, 'development'>;

export interface HostedEnvironmentProfile {
  readonly runtime: HostedRuntimeEnvironment;
  readonly authority: HostedAuthorityEnvironment;
  readonly supabaseProjectRef: string | null;
  readonly desktopHostname: string | null;
  readonly azureFoundryHostname: string | null;
}

export interface HostedServiceEnvironmentProfile extends HostedEnvironmentProfile {
  readonly runtime: HostedServiceRuntimeEnvironment;
  readonly authority: HostedServiceAuthorityEnvironment;
  readonly supabaseProjectRef: string;
  readonly desktopHostname: string;
  readonly azureFoundryHostname: string;
}

const LOCAL_PROFILE: HostedEnvironmentProfile = {
  runtime: 'local',
  authority: 'development',
  supabaseProjectRef: null,
  desktopHostname: null,
  azureFoundryHostname: null,
};

const SERVICE_PROFILES: Readonly<
  Record<HostedServiceRuntimeEnvironment, HostedServiceEnvironmentProfile>
> = {
  staging: {
    runtime: 'staging',
    authority: 'staging',
    supabaseProjectRef: 'rhezskdgtooutzhebfle',
    desktopHostname: 'staging.dnaforge.com',
    azureFoundryHostname: 'dnaforge-1-resource.services.ai.azure.com',
  },
  production: {
    runtime: 'production',
    authority: 'production',
    supabaseProjectRef: 'jklyskbgvrgniksvniuo',
    desktopHostname: 'dnaforge.com',
    azureFoundryHostname: 'dnaforge-production.openai.azure.com',
  },
};

const PROFILES: Readonly<Record<HostedRuntimeEnvironment, HostedEnvironmentProfile>> = {
  local: LOCAL_PROFILE,
  ...SERVICE_PROFILES,
};

export function hostedEnvironmentProfile(value: string | undefined): HostedEnvironmentProfile {
  if (value !== 'local' && value !== 'staging' && value !== 'production') {
    throw new Error('DNAFORGE_ENVIRONMENT must be local, staging, or production.');
  }
  return PROFILES[value];
}

export function hostedServiceEnvironmentProfile(
  value: string | undefined
): HostedServiceEnvironmentProfile {
  if (value === 'local') {
    throw new Error('DNAFORGE_ENVIRONMENT local is unsupported for Hosted services.');
  }
  if (value !== 'staging' && value !== 'production') {
    throw new Error('DNAFORGE_ENVIRONMENT must be staging or production for Hosted services.');
  }
  return SERVICE_PROFILES[value];
}

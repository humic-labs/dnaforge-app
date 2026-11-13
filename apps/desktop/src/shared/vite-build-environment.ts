import { loadEnv } from 'vite';

type BuildEnvironmentInput = {
  mode: string;
  repoRoot: string;
  qualification: boolean;
  processEnvironment: Readonly<Record<string, string | undefined>>;
};

type BuildEnvironment = {
  env: Record<string, string>;
  envDir: string | false;
};

function definedEnvironmentValues(
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

export function resolveElectronViteBuildEnvironment({
  mode,
  repoRoot,
  qualification,
  processEnvironment,
}: BuildEnvironmentInput): BuildEnvironment {
  if (qualification) {
    return {
      env: definedEnvironmentValues(processEnvironment),
      envDir: false,
    };
  }

  return {
    env: loadEnv(mode, repoRoot, ''),
    envDir: repoRoot,
  };
}

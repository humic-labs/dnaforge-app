export type ViteLikeEnv = {
  DEV?: boolean;
  MODE?: string;
};

export type DevSurfaceState = {
  devAssets: boolean;
  devScenarios: boolean;
  devShortcuts: boolean;
};

export function isHostedRendererMode(env: ViteLikeEnv): boolean {
  return env.MODE === 'hosted';
}

export function isLocalDevBuild(env: ViteLikeEnv): boolean {
  return env.DEV === true && !isHostedRendererMode(env);
}

export function shouldAutoMountDevAssets(env: ViteLikeEnv, devAssetsPath: string): boolean {
  return isLocalDevBuild(env) && devAssetsPath.trim().length > 0;
}

export function shouldEnableDevScenarios(env: ViteLikeEnv): boolean {
  return isLocalDevBuild(env) || env.MODE === 'test';
}

export function getDevSurfaceState(env: ViteLikeEnv, devAssetsPath: string): DevSurfaceState {
  return {
    devAssets: shouldAutoMountDevAssets(env, devAssetsPath),
    devScenarios: shouldEnableDevScenarios(env),
    devShortcuts: shouldEnableDevScenarios(env),
  };
}

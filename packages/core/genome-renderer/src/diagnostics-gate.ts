type ViteLikeEnv = {
  DEV?: boolean;
  MODE?: string;
  PROD?: boolean;
  VITEST?: boolean | string;
};

type DiagnosticsWindow = Window &
  typeof globalThis & {
    __webglDiagnosticsEnabled?: boolean;
    __webglExposeForTests?: boolean;
  };

function viteEnv(): ViteLikeEnv | undefined {
  return (import.meta as ImportMeta & { env?: ViteLikeEnv }).env;
}

function isDevOrTestRuntime(): boolean {
  const env = viteEnv();
  return (
    env?.DEV === true || env?.MODE === 'test' || env?.VITEST === true || env?.VITEST === 'true'
  );
}

export function isWebGLDiagnosticsEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const w = window as DiagnosticsWindow;
    if (w.__webglDiagnosticsEnabled === true || w.__webglExposeForTests === true) return true;
    if (w.__webglDiagnosticsEnabled === false) return false;
  }
  return isDevOrTestRuntime();
}

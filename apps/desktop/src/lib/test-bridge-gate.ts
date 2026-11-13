export type ViteEnv = {
  DEV?: boolean;
  MODE?: string;
};

export function shouldEnableTestBridge(env: ViteEnv): boolean {
  return env.DEV === true || env.MODE === 'test';
}

export function backgroundWindowRequested(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  argv?: readonly string[]
): boolean;
export function isAgentLaunch(env?: NodeJS.ProcessEnv): boolean;
export function isTestLaunch(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean;

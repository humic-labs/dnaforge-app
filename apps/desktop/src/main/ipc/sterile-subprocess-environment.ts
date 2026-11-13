export function createSterileOsEnvironment(
  ambientEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (process.platform !== 'win32') return environment;

  const systemRootEntry = Object.entries(ambientEnvironment).find(
    ([key, value]) => key.toLowerCase() === 'systemroot' && typeof value === 'string'
  );
  if (systemRootEntry) environment.SYSTEMROOT = systemRootEntry[1];
  return environment;
}

export function createMutableSubprocessEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return { ...environment, ...overrides };
}

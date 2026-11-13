function isAgentLaunch(env = process.env) {
  return (
    env.DNAFORGE_AGENT_EXECUTION === '1' ||
    env.CLAUDECODE === '1' ||
    Boolean(env.CODEX_HOME) ||
    Boolean(env.CODEX_CLI_PATH)
  );
}

function isTestLaunch(env, argv) {
  return env.NODE_ENV === 'test' || argv.includes('--e2e') || argv.includes('--waypoint-e2e=1');
}

function backgroundWindowRequested(env = process.env, platform = process.platform, argv = []) {
  if (argv.includes('--launched-by=mcp')) return true;
  if (env.DNAFORGE_FOREGROUND_WINDOW === '1' && env.DNAFORGE_BACKGROUND_WINDOW !== '1')
    return false;
  if (isTestLaunch(env, argv)) {
    return (
      platform === 'darwin' &&
      env.WAYPOINT_E2E_FOREGROUND !== '1' &&
      (!env.CI || env.DNAFORGE_BACKGROUND_WINDOW === '1')
    );
  }
  return env.DNAFORGE_BACKGROUND_WINDOW === '1' || isAgentLaunch(env);
}

module.exports = { backgroundWindowRequested, isAgentLaunch, isTestLaunch };

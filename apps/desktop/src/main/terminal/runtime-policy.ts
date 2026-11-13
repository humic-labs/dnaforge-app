import type { TerminalRuntimePolicy } from '../../shared/terminal-runtime-policy';

const essential = new Set([
  'HOME',
  'USERPROFILE',
  'PATH',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
]);

export function terminalParentEnvironment(
  parent: NodeJS.ProcessEnv,
  policy: TerminalRuntimePolicy
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(parent).filter(
      ([key]) => policy.inheritEnvironment || essential.has(key.toUpperCase())
    )
  );
  if (policy.locale === 'utf8') {
    const locale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
    delete environment.LC_ALL;
    environment.LANG = locale;
    environment.LC_CTYPE = locale;
  }
  return environment;
}

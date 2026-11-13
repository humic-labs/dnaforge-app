const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

const CONTEXT_KEYS = ['id', 'profile', 'purpose', 'root', 'schemaVersion', 'workspace'];

function ownedDirectory(path) {
  const metadata = lstatSync(path);
  if (
    !isAbsolute(path) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  )
    throw new Error('The automation profile directory is not privately owned.');
}

function automationUserDataPath(argv, environment = process.env, applicationDirectory) {
  const path = environment.DNAFORGE_AUTOMATION_CONTEXT;
  if (!path) {
    if (environment.DNAFORGE_DATA_CONFINEMENT_REQUIRED === '1')
      throw new Error('A required automation context is missing.');
    return null;
  }
  const metadata = lstatSync(path);
  if (
    !isAbsolute(path) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  )
    throw new Error('The automation context is not an owned private file.');
  const context = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !context ||
    typeof context !== 'object' ||
    Object.keys(context).sort().join(',') !== CONTEXT_KEYS.join(',') ||
    context.schemaVersion !== 1 ||
    context.purpose !== 'agent-automation' ||
    typeof context.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.id) ||
    typeof context.root !== 'string' ||
    typeof context.workspace !== 'string' ||
    context.profile !== join(context.root, 'profile') ||
    path !== join(context.root, 'context.json')
  )
    throw new Error('The automation context does not bind an exact profile.');
  ownedDirectory(context.root);
  ownedDirectory(context.profile);
  ownedDirectory(join(context.root, 'tmp'));
  if (realpathSync(context.workspace) !== context.workspace)
    throw new Error('The automation workspace is not canonical.');
  if (applicationDirectory) {
    const difference = relative(context.workspace, realpathSync(applicationDirectory));
    if (isAbsolute(difference) || difference === '..' || difference.startsWith(`..${sep}`))
      throw new Error('The application belongs to another automation workspace.');
  }
  const requested = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--user-data-dir') requested.push(argv[++index] ?? '');
    else if (argv[index].startsWith('--user-data-dir='))
      requested.push(argv[index].slice('--user-data-dir='.length));
  }
  if (
    requested.length > 1 ||
    requested.some((value) => !value || resolve(value) !== context.profile) ||
    argv.includes('--dnaforge-test-shared-profile')
  )
    throw new Error('The application launch contradicts its isolated automation profile.');
  return context.profile;
}

module.exports = { automationUserDataPath };

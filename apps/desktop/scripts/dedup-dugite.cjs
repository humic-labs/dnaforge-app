
const path = require('node:path');
const fs = require('node:fs');
const { Arch } = require('builder-util');
const {
  dedupToCanonical,
  countLargeRegularCopies,
  directorySizeBytes,
} = require('./lib/dedup-identical-files.cjs');
const { pruneForeignDarwinHelpers } = require('./lib/prune-packaged-helpers.cjs');
const {
  buildMacDefaultHandlerHelper,
  injectMacAssociationMetadata,
  loadFileAssociationRegistry,
} = require('./file-association-packaging.cjs');

const CANONICAL_GIT = 'git';
const associationRegistry = loadFileAssociationRegistry(path.resolve(__dirname, '..'));

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    console.log(`[dedup-dugite] skip — platform ${context.electronPlatformName} (macOS only)`);
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appRoot = path.join(context.appOutDir, `${productFilename}.app`);
  injectMacAssociationMetadata(context, associationRegistry);
  console.log('[file-associations] injected macOS document declarations');
  buildMacDefaultHandlerHelper(context, path.resolve(__dirname, '..'));
  console.log('[file-associations] built macOS default-handler helper');
  const archName = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  const helperResult = pruneForeignDarwinHelpers({
    helpersDir: path.join(appRoot, 'Contents', 'Helpers'),
    archName,
  });
  console.log(
    `[packaged-helpers] target=${archName}; kept=${helperResult.kept.join(',') || 'none'}; ` +
      `removed=${helperResult.removed.join(',') || 'none'}`
  );

  const gitCore = path.join(
    appRoot,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'dugite',
    'git',
    'libexec',
    'git-core'
  );

  if (!fs.existsSync(gitCore)) {
    console.log(`[dedup-dugite] skip — git-core not found at ${gitCore} (dugite not bundled?)`);
    return;
  }

  const canonical = path.join(gitCore, CANONICAL_GIT);
  if (!fs.existsSync(canonical)) {
    console.log(`[dedup-dugite] skip — canonical '${CANONICAL_GIT}' not found in ${gitCore}`);
    return;
  }

  const mib = (n) => (n / (1024 * 1024)).toFixed(1);
  try {
    const sizeBefore = directorySizeBytes(gitCore);
    const copiesBefore = countLargeRegularCopies(gitCore, CANONICAL_GIT);
    const { deduped, bytesSaved, canonicalHash, alreadySymlinked, skipped } = dedupToCanonical(
      gitCore,
      CANONICAL_GIT
    );
    const sizeAfter = directorySizeBytes(gitCore);
    const copiesAfter = countLargeRegularCopies(gitCore, CANONICAL_GIT);

    console.log(
      `[dedup-dugite] git-core dedup: ${deduped} subcommand(s) symlinked to git ` +
        `(${mib(bytesSaved)} MiB reclaimed; sha256=${(canonicalHash || '').slice(0, 12)}…). ` +
        `git-core size ${mib(sizeBefore)} → ${mib(sizeAfter)} MiB, ` +
        `full-size copies ${copiesBefore} → ${copiesAfter}, ` +
        `alreadySymlinked=${alreadySymlinked}, skipped=${skipped}.`
    );

    if (copiesAfter > 3) {
      console.warn(
        `[dedup-dugite] WARNING: ${copiesAfter} full-size git copies remain un-deduped after the pass.`
      );
    }
  } catch (err) {
    console.warn(
      `[dedup-dugite] skipped — dedup pass errored (non-fatal): ${err && err.message ? err.message : err}`
    );
  }
};

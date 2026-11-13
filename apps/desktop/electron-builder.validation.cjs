const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { parse } = require('yaml');

const productionConfig = parse(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'));

if (
  productionConfig.appId !== 'com.dnaforge.desktop' ||
  productionConfig.productName !== 'DNAForge'
) {
  throw new Error(
    'electron-builder.validation.cjs must be reviewed when the production application identity changes'
  );
}

module.exports = {
  ...productionConfig,
  appId: 'com.dnaforge.desktop.validation',
  productName: 'DNAForge Validation',
  executableName: 'DNAForge Validation',
  artifactName: 'DNAForge-Validation-${version}-${arch}.${ext}',
  forceCodeSigning: true,
  extraMetadata: {
    name: 'dnaforge-validation',
    productName: 'DNAForge Validation',
    description: 'Internal signed DNAForge package validation build — not a production release',
  },
  directories: {
    ...productionConfig.directories,
    output: 'dist-electron-validation',
  },
  protocols: [],
  mac: {
    ...productionConfig.mac,
    icon: '../../node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns',
  },
  dmg: {
    ...productionConfig.dmg,
    title: 'DNAForge Validation ${version}',
  },
};

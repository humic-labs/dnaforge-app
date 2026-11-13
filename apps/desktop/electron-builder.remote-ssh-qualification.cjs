const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parse } = require('yaml');

if (process.env.DNAFORGE_RELEASE_BUILD || process.env.DNAFORGE_RELEASE_CHANNEL) {
  throw new Error('Remote SSH qualification cannot build a release.');
}
const production = parse(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'));
module.exports = {
  ...production,
  forceCodeSigning: false,
  protocols: [],
  publish: null,
  directories: { ...production.directories, output: 'dist-remote-ssh-qualification' },
  win: {
    ...production.win,
    azureSignOptions: undefined,
    signAndEditExecutable: false,
  },
};

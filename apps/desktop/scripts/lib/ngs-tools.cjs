const fs = require('node:fs');
const path = require('node:path');

const SOURCE_LOCK_PATH = path.resolve(__dirname, '../../../../.ci/ngs-tools-source.lock.json');
const SOURCE_LOCK_BYTES = fs.readFileSync(SOURCE_LOCK_PATH);
const SOURCE_LOCK = JSON.parse(SOURCE_LOCK_BYTES);
const SUFFIXES = Object.freeze({ arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' });

const NGS_TOOL_SPECS = Object.freeze([
  Object.freeze({ name: 'minimap2', probeArgs: ['--version'], supportedSchema: /^2\.31-r1302$/ }),
  Object.freeze({
    name: 'samtools',
    probeArgs: ['--version'],
    supportedSchema: /^samtools 1\.24\r?\nUsing htslib 1\.25(?:\r?\n|$)/,
  }),
]);

function ngsToolSuffix(arch) {
  const suffix = SUFFIXES[arch];
  if (!suffix) throw new Error(`NGS tools are not built for architecture ${arch}`);
  return suffix;
}

function verifyNgsVersion(name, output) {
  const spec = NGS_TOOL_SPECS.find((entry) => entry.name === name);
  const text = output.trim();
  if (!spec || !spec.supportedSchema.test(text)) {
    throw new Error(`Unexpected ${name} version: ${text.slice(0, 160)}`);
  }
  return name === 'minimap2' ? SOURCE_LOCK.versions.minimap2 : SOURCE_LOCK.versions.samtools;
}

function macSystemDependencies(output) {
  const dependencies = output
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0]);
  if (
    !dependencies.length ||
    dependencies.some(
      (dependency) =>
        !dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')
    )
  ) {
    throw new Error(`NGS helper has non-system dylibs: ${dependencies.join(', ')}`);
  }
  return dependencies;
}

module.exports = {
  SOURCE_LOCK,
  SOURCE_LOCK_BYTES,
  NGS_TOOL_SPECS,
  SUFFIXES,
  ngsToolSuffix,
  verifyNgsVersion,
  macSystemDependencies,
};

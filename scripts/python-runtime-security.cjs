#!/usr/bin/env node

const policy = require('../.ci/python-runtime-security.json');

function versionParts(value, name, allowSeries = false) {
  const expression = allowSeries
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u
    : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
  if (typeof value !== 'string' || !expression.test(value)) {
    throw new Error(`Invalid ${name} version: ${JSON.stringify(value)}`);
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error(`Invalid ${name} version: ${JSON.stringify(value)}`);
  }
  return parts;
}

function compareVersions(actual, required) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] - required[index];
  }
  return 0;
}

function pythonRequirement(requested) {
  const parts = versionParts(requested, 'Python', true);
  const series = parts.slice(0, 2).join('.');
  const floor = policy.minimums[series];
  if (!floor) throw new Error(`Unsupported Python series: ${series}`);
  const minimum = versionParts(floor, 'Python');
  if (parts.length === 3 && compareVersions(parts, minimum) < 0) {
    throw new Error(
      `Python ${floor} or newer in the ${series} series is required; found ${requested}`
    );
  }
  return { series, version: parts.length === 3 ? requested : floor };
}

function minimumPythonVersion(requested) {
  return pythonRequirement(requested).version;
}

function assertPythonVersion(actual, requested) {
  const parts = versionParts(actual, 'Python');
  const requirement = pythonRequirement(requested || parts.slice(0, 2).join('.'));
  if (
    parts.slice(0, 2).join('.') !== requirement.series ||
    compareVersions(parts, versionParts(requirement.version, 'Python')) < 0
  ) {
    throw new Error(
      `Python ${requirement.version} or newer in the ${requirement.series} series is required; found ${actual}`
    );
  }
  return actual;
}

function assertUvVersion(identity) {
  const match = typeof identity === 'string' && identity.match(/^uv (\d+\.\d+\.\d+)(?:\s|$)/u);
  if (!match || compareVersions(versionParts(match[1], 'uv'), versionParts(policy.uv, 'uv')) < 0) {
    throw new Error(`uv ${policy.uv} or newer is required; found ${JSON.stringify(identity)}`);
  }
  return match[1];
}

module.exports = { assertPythonVersion, assertUvVersion, minimumPythonVersion, policy };

if (require.main === module) {
  try {
    const [command, value, requested] = process.argv.slice(2);
    let result;
    switch (command) {
      case 'minimum':
        result = minimumPythonVersion(value);
        break;
      case 'check':
        result = assertPythonVersion(value, requested);
        break;
      case 'check-uv':
        result = assertUvVersion(value);
        break;
      case 'uv-minimum':
        result = policy.uv;
        break;
      case 'downloads-url':
        result = policy.downloadsJsonUrl;
        break;
      default:
        throw new Error(`Unknown Python runtime security command: ${command}`);
    }
    process.stdout.write(`${result}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

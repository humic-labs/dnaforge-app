import fs from 'node:fs';
import childProcess from 'node:child_process';

function bytes(value, field) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error(`Missing capacity field: ${field}`);
  if (!/^\d+$/.test(String(value))) throw new Error(`Invalid capacity field: ${field}`);
  const integer = BigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`Capacity field exceeds the safe integer range: ${field}`);
  return Number(integer);
}

function requestedPurpose(options) {
  const purpose = options.purpose ?? 'important';
  if (!['important', 'opportunistic'].includes(purpose))
    throw new Error('Storage capacity purpose must be important or opportunistic.');
  return purpose;
}

function filesystemCapacity(stat, purpose, destinationPath) {
  const availableBytes = bytes(BigInt(stat.bavail) * BigInt(stat.bsize), 'availableBytes');
  return {
    destinationPath,
    availableBytes,
    freeBytes: availableBytes,
    importantBytes: null,
    opportunisticBytes: null,
    totalBytes:
      stat.blocks === undefined
        ? null
        : bytes(BigInt(stat.blocks) * BigInt(stat.bsize), 'totalBytes'),
    source: 'filesystem-available',
    purpose,
  };
}

function foundationArguments(canonicalPath, purpose) {
  const script = `ObjC.import("Foundation");
const url = $.NSURL.fileURLWithPath(${JSON.stringify(canonicalPath)});
const keys = [$.NSURLVolumeTotalCapacityKey, $.NSURLVolumeAvailableCapacityKey,
  $.NSURLVolumeAvailableCapacityFor${purpose === 'important' ? 'Important' : 'Opportunistic'}UsageKey];
const error = Ref();
const values = url.resourceValuesForKeysError($(keys), error);
if (!values) throw new Error("Foundation capacity query failed");
const result = {};
["totalBytes", "freeBytes", "${purpose}Bytes"].forEach((name, i) => {
  const value = values.objectForKey(keys[i]);
  if (!value) throw new Error("Foundation capacity field unavailable: " + name);
  result[name] = ObjC.unwrap(value.stringValue);
});
JSON.stringify(result);`;
  return ['-l', 'JavaScript', '-e', script];
}

const QUERY_OPTIONS = { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 };

function foundationCapacity(raw, purpose, destinationPath) {
  const record = JSON.parse(raw);
  const capacity = {
    importantBytes: null,
    opportunisticBytes: null,
    ...Object.fromEntries(
      ['totalBytes', 'freeBytes', `${purpose}Bytes`].map((field) => [
        field,
        bytes(record?.[field], field),
      ])
    ),
  };
  for (const field of ['freeBytes', 'importantBytes', 'opportunisticBytes']) {
    if (capacity[field] > capacity.totalBytes)
      throw new Error(`Capacity field exceeds volume size: ${field}`);
  }
  return {
    destinationPath,
    ...capacity,
    availableBytes: capacity[`${purpose}Bytes`],
    source: `macos-${purpose}-usage`,
    purpose,
  };
}

function capacityUnknown(targetPath, cause) {
  return Object.assign(
    new Error(`Available storage capacity is unknown for ${targetPath}.`, { cause }),
    {
      code: 'STORAGE_CAPACITY_UNKNOWN',
    }
  );
}

export function readStorageCapacitySync(targetPath, options = {}) {
  const purpose = requestedPurpose(options);
  try {
    const canonicalPath = fs.realpathSync(targetPath);
    if ((options.platform ?? process.platform) !== 'darwin') {
      const stat = (options.statfsSync ?? fs.statfsSync)(canonicalPath, { bigint: true });
      return filesystemCapacity(stat, purpose, canonicalPath);
    }
    const raw = (options.execFileSync ?? childProcess.execFileSync)(
      '/usr/bin/osascript',
      foundationArguments(canonicalPath, purpose),
      QUERY_OPTIONS
    );
    return foundationCapacity(raw, purpose, canonicalPath);
  } catch (cause) {
    throw capacityUnknown(targetPath, cause);
  }
}

function execFileOutput(file, args, options) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout) => {
      if (error?.killed && error.signal === 'SIGTERM' && error.code === null)
        error.code = 'ETIMEDOUT';
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function readStorageCapacity(targetPath, options = {}) {
  const purpose = requestedPurpose(options);
  try {
    const canonicalPath = await fs.promises.realpath(targetPath);
    if ((options.platform ?? process.platform) !== 'darwin') {
      const stat = await (options.statfs ?? fs.promises.statfs)(canonicalPath, { bigint: true });
      return filesystemCapacity(stat, purpose, canonicalPath);
    }
    const raw = await (options.execFile ?? execFileOutput)(
      '/usr/bin/osascript',
      foundationArguments(canonicalPath, purpose),
      QUERY_OPTIONS
    );
    return foundationCapacity(raw, purpose, canonicalPath);
  } catch (cause) {
    throw capacityUnknown(targetPath, cause);
  }
}

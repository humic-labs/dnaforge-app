
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listRegularFiles(dir, canonicalName) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === canonicalName) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    out.push({ name, full, stat: st });
  }
  return out;
}

function countIdenticalCopies(dir, canonicalName) {
  const canonical = path.join(dir, canonicalName);
  if (!fs.existsSync(canonical)) return 0;
  const canonStat = fs.statSync(canonical);
  const canonHash = sha256(canonical);

  let count = 0;
  for (const { stat, full } of listRegularFiles(dir, canonicalName)) {
    if (stat.size !== canonStat.size) continue;
    if (sha256(full) === canonHash) count++;
  }
  return count;
}

function countLargeRegularCopies(dir, canonicalName, tolerance = 0.1) {
  const canonical = path.join(dir, canonicalName);
  if (!fs.existsSync(canonical)) return 0;
  const canonSize = fs.statSync(canonical).size;
  const lo = canonSize * (1 - tolerance);
  const hi = canonSize * (1 + tolerance);

  let count = 0;
  for (const { stat } of listRegularFiles(dir, canonicalName)) {
    if (stat.size >= lo && stat.size <= hi) count++;
  }
  return count;
}

function directorySizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else total += st.size;
    }
  }
  return total;
}

function dedupToCanonical(dir, canonicalName) {
  const canonical = path.join(dir, canonicalName);
  if (!fs.existsSync(canonical) || !fs.lstatSync(canonical).isFile()) {
    return { deduped: 0, bytesSaved: 0, canonicalHash: null, alreadySymlinked: 0, skipped: 0 };
  }

  const canonStat = fs.statSync(canonical);
  const canonHash = sha256(canonical);
  const canonSize = canonStat.size;

  let deduped = 0;
  let bytesSaved = 0;
  let alreadySymlinked = 0;
  let skipped = 0;

  for (const name of fs.readdirSync(dir)) {
    if (name === canonicalName) continue;
    const full = path.join(dir, name);
    let lst;
    try {
      lst = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      try {
        if (fs.readlinkSync(full) === canonicalName) alreadySymlinked++;
      } catch {
      }
    }
  }

  for (const { full, stat } of listRegularFiles(dir, canonicalName)) {
    if (stat.size !== canonSize) continue;
    if (sha256(full) !== canonHash) continue;

    const tmp = `${full}.dedup-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.symlinkSync(canonicalName, tmp);
      fs.renameSync(tmp, full);
      deduped++;
      bytesSaved += canonSize;
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
      }
      skipped++;
      // eslint-disable-next-line no-console
      console.warn(
        `[dedup] skipped ${path.basename(full)}: ${err && err.message ? err.message : err}`
      );
    }
  }

  return { deduped, bytesSaved, canonicalHash: canonHash, alreadySymlinked, skipped };
}

module.exports = {
  dedupToCanonical,
  countIdenticalCopies,
  countLargeRegularCopies,
  directorySizeBytes,
  sha256,
};

#!/usr/bin/env node
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyBinding(binding) {
  const database = new Database(':memory:', binding ? { nativeBinding: binding } : {});
  try {
    if (database.prepare('SELECT 1 AS ready').get().ready !== 1)
      throw new Error('The installed SQLite binding did not execute a query.');
  } finally {
    database.close();
  }
}

function installTestSqlite({
  fixtureDir = path.join(__dirname, '../src/main/__tests__/__fixtures__'),
} = {}) {
  verifyBinding();
  const packagePath = fs.realpathSync(require.resolve('better-sqlite3/package.json'));
  const packageRoot = path.dirname(packagePath);
  const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
  const source = Object.keys(require.cache).find(
    (file) => file.startsWith(`${packageRoot}${path.sep}`) && file.endsWith('.node')
  );
  if (!source) throw new Error('Could not identify the loaded SQLite native binding.');
  const sha256 = hashFile(source);
  const destination = path.join(fixtureDir, 'better_sqlite3_node.node');
  const stamp = path.join(fixtureDir, '.sqlite-prebuild-stamp');
  const identity = `${version}-napi-${process.platform}-${process.arch}-${sha256}`;
  fs.mkdirSync(fixtureDir, { recursive: true });
  if (!fs.existsSync(destination) || hashFile(destination) !== sha256) {
    const temporary = path.join(fixtureDir, `.sqlite-${randomUUID()}.node`);
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      if (hashFile(temporary) !== sha256)
        throw new Error('SQLite binding copy failed verification.');
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  verifyBinding(destination);
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== identity)
    fs.writeFileSync(stamp, identity);
  console.log(
    `[install-test-sqlite] verified locked SQLite ${version} for ${process.platform}/${process.arch}`
  );
  return { destination, version, sha256 };
}

module.exports = { installTestSqlite };

if (require.main === module) {
  try {
    installTestSqlite();
  } catch (error) {
    console.error(`[install-test-sqlite] ${error.message}`);
    process.exitCode = 1;
  }
}

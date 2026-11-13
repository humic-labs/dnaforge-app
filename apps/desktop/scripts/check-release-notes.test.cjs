const assert = require('node:assert/strict');
const test = require('node:test');

const { checkReleaseNotes } = require('./check-release-notes.cjs');

const RELEASE_NOTES = {
  '0.9.9': { date: '2026-10-03', highlights: [] },
  '0.9.7': { date: '2026-09-28', highlights: [] },
};
const registry = {
  RELEASE_NOTES,
  VERSION_HISTORY: Object.keys(RELEASE_NOTES),
};

test('an unstamped placeholder older than the newest release is skipped ', () => {
  const result = checkReleaseNotes('0.9.3', registry);
  assert.deepEqual(result.errors, []);
  assert.match(result.skipped, /unstamped development version 0\.9\.3/);
});

test('a nightly prerelease is skipped', () => {
  const result = checkReleaseNotes('0.9.10-nightly.37000000', registry);
  assert.deepEqual(result.errors, []);
  assert.match(result.skipped, /nightly/);
});

test('a stamped release listed first passes', () => {
  assert.deepEqual(checkReleaseNotes('0.9.9', registry), { skipped: null, errors: [] });
});

test('a stamped release newer than the list fails on both missing pieces', () => {
  const { skipped, errors } = checkReleaseNotes('0.9.10', registry);
  assert.equal(skipped, null);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Missing release notes for 0\.9\.10/);
  assert.match(errors[1], /Expected 0\.9\.10, got 0\.9\.9/);
});

test('a stamped release with notes but not listed first fails', () => {
  const outOfOrder = { ...registry, VERSION_HISTORY: ['0.9.7', '0.9.9'] };
  const { errors } = checkReleaseNotes('0.9.9', outOfOrder);
  assert.deepEqual(errors, ['Release version must be first. Expected 0.9.9, got 0.9.7.']);
});

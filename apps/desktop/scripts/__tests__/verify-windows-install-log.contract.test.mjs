import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, '..');
const smoke = readFileSync(join(scriptsDir, 'verify-windows-install-smoke.ps1'), 'utf8');
const helper = readFileSync(join(scriptsDir, 'windows-install-log.ps1'), 'utf8');
const packagedAcceptance = readFileSync(
  join(here, '..', '..', '..', '..', 'scripts', 'verify-packaged-app-windows.ps1'),
  'utf8'
);
const sidecarAnnotationSmoke = readFileSync(
  join(scriptsDir, 'verify-windows-sidecar-annotation-smoke.ps1'),
  'utf8'
);
const mg1655Fixture = readFileSync(
  join(
    here,
    '..',
    '..',
    '..',
    '..',
    'test-fixtures',
    'sequences',
    'circular',
    'ecoli-mg1655-complete.gb'
  ),
  'utf8'
);

function mustInclude(source, needle, label) {
  assert.ok(
    source.includes(needle),
    `${label}: expected source to contain ${JSON.stringify(needle)}`
  );
}

function stripPsComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

describe('windows install log path contract (helper)', () => {
  it('resolves locked primary + dual-write paths', () => {
    mustInclude(helper, 'DNAForge\\logs\\install.log', 'primary path');
    mustInclude(helper, 'dnaforge-install.log', 'dual-write filename');
    mustInclude(helper, 'Get-PrimaryInstallLogPath', 'primary helper');
    mustInclude(helper, 'Get-DualWriteInstallLogPath', 'dual-write helper');
  });

  it('clears only install.log files (not LocalAppData\\DNAForge tree)', () => {
    mustInclude(helper, 'Clear-DNAForgeInstallLogFile', 'file-only clear');
    assert.ok(
      !/Remove-Item[^\n]*DNAForge[^\n]*-Recurse/.test(helper),
      'helper must not recursively delete LocalAppData\\DNAForge'
    );
  });

  it('asserts T1 happy-path markers and dual-write when writable', () => {
    mustInclude(helper, 'Assert-HappyPathInstallLog', 'T1 assert fn');
    mustInclude(helper, 'schema=1', 'schema marker');
    mustInclude(helper, 'event=init', 'init marker');
    mustInclude(helper, 'event=install_complete', 'complete marker');
    const happyFn = helper.slice(
      helper.indexOf('function Assert-HappyPathInstallLog'),
      helper.indexOf('function Assert-FailurePathInstallLog')
    );
    mustInclude(happyFn, 'Test-InstallLogDirWritable', 'T1 dual-write writability gate');
    mustInclude(happyFn, 'DualWriteLogPath', 'T1 dual-write param');
  });

  it('asserts T2 failure-path markers with hard dual-write when writable', () => {
    mustInclude(helper, 'Assert-FailurePathInstallLog', 'T2 assert fn');
    mustInclude(helper, 'MustNotContain', 'absent-marker API');
    const failureFn = helper.slice(
      helper.indexOf('function Assert-FailurePathInstallLog'),
      helper.indexOf('function Write-InstallLogDump')
    );
    mustInclude(failureFn, 'event=init', 'T2 requires init');
    mustInclude(failureFn, 'event=install_complete', 'T2 checks complete');
    mustInclude(failureFn, 'MustNotContain', 'T2 rejects complete');
    mustInclude(failureFn, 'Test-InstallLogDirWritable', 'T2 dual-write writability gate');
    const codeOnly = stripPsComments(failureFn);
    assert.ok(
      !codeOnly.includes('Write-Warning'),
      'T2 dual-write failures must throw, not Write-Warning'
    );
    mustInclude(failureFn, 'throw', 'T2 dual-write hard fail');
  });
});

describe('windows install smoke T1+T2 wiring', () => {
  it('dot-sources the shared helper module', () => {
    mustInclude(smoke, 'windows-install-log.ps1', 'dot-source helper');
  });

  it('runs T2 kill-after-init before T1 happy path by default', () => {
    mustInclude(smoke, 'Invoke-DNAForgeFailurePathSmoke', 'T2 entry');
    mustInclude(smoke, 'Invoke-DNAForgeSilentInstall', 'T1 entry');
    mustInclude(smoke, 'SkipFailurePath', 'opt-out switch');
    mustInclude(smoke, 'starting installer without -Wait', 'T2 no-wait start');
    mustInclude(smoke, 'event=init', 'poll for init');

    const t2Call = smoke.indexOf('Invoke-DNAForgeFailurePathSmoke `');
    const t1Call = smoke.indexOf('Invoke-DNAForgeSilentInstall `');
    assert.ok(t2Call > 0, 'T2 call site (backtick-continued) not found');
    assert.ok(t1Call > t2Call, 'T2 must be invoked before T1 in the main try block');
  });

  it('kills the installer process tree and asserts exit before T2 log assert', () => {
    mustInclude(smoke, 'taskkill.exe', 'process-tree kill');
    mustInclude(smoke, '/T', 'tree flag');
    mustInclude(smoke, '/F', 'force flag');
    mustInclude(smoke, 'still alive after kill', 'post-kill liveness assert');
  });

  it('T2 cleanup only removes Programs candidates that contain DNAForge.exe', () => {
    const t2Fn = smoke.slice(
      smoke.indexOf('function Invoke-DNAForgeFailurePathSmoke'),
      smoke.indexOf('\ntry {')
    );
    mustInclude(t2Fn, 'DNAForge.exe', 'exe probe before cleanup');
    const candidatesFn = smoke.slice(
      smoke.indexOf('function Get-DefaultInstallCandidates'),
      smoke.indexOf('function Stop-InstallerProcessTree')
    );
    const candidatesCode = stripPsComments(candidatesFn);
    assert.ok(
      !/Join-Path\s+\$env:LOCALAPPDATA\s+'DNAForge'/.test(candidatesCode),
      'install candidates must not include LocalAppData\\DNAForge (log/userData root)'
    );
  });

  it('pre-deletes logs and asserts T1 markers + dual-write after successful install', () => {
    mustInclude(smoke, 'Clear-DNAForgeInstallLogs', 'pre-delete');
    mustInclude(smoke, 'Assert-HappyPathInstallLog', 'T1 assert call');
    mustInclude(smoke, 'DualWriteLogPath', 'T1 dual-write arg');
    mustInclude(smoke, 'Write-InstallLogDump', 'dump on failure');
  });

  it('keeps Defender exclusions, transient retries, default-dir + acceptance gate', () => {
    mustInclude(smoke, 'Add-MpPreference', 'Defender exclusion');
    mustInclude(smoke, '-1073741819', '0xC0000005 retry');
    mustInclude(smoke, '-1073741502', '0xC0000142 retry');
    mustInclude(smoke, 'UseDefaultInstallDir', 'default install dir');
    mustInclude(smoke, 'verify-packaged-app-windows.ps1', 'acceptance gate');
    mustInclude(smoke, '-SessionToken $sessionToken', 'acceptance gate session token');
  });
});

describe('Windows Rfam fixture contract', () => {
  it('keeps ssrA anchored to its canonical GenBank feature rather than a stale coordinate', () => {
    const lines = mg1655Fixture.split('\n');
    let currentFeature;
    let ssrARange;
    for (const line of lines) {
      const feature = /^     (\S+)\s+(\d+)\.\.(\d+)/.exec(line);
      if (feature) {
        currentFeature = {
          type: feature[1],
          start: Number(feature[2]),
          end: Number(feature[3]),
        };
        continue;
      }
      if (currentFeature?.type === 'gene' && /^                     \/gene="ssrA"/.test(line)) {
        ssrARange = currentFeature;
        break;
      }
    }

    assert.deepEqual(ssrARange, { type: 'gene', start: 2755593, end: 2755955 });
    assert.equal(ssrARange.end - ssrARange.start + 1, 363);
  });

  it('derives ssrA from the GenBank feature table in every Windows annotation gate', () => {
    for (const [name, source] of [
      ['packaged-app acceptance', packagedAcceptance],
      ['sidecar annotation smoke', sidecarAnnotationSmoke],
    ]) {
      mustInclude(source, 'function Get-GenBankFeatureSubsequence', `${name} feature parser`);
      mustInclude(source, "-FeatureName 'ssrA'", `${name} ssrA lookup`);
      mustInclude(source, "$featureType -eq 'gene'", `${name} gene identity check`);
      mustInclude(
        source,
        '$featureMatches = New-Object',
        `${name} must avoid the automatic $Matches variable`
      );
      mustInclude(source, '$tmRnaHit.start -ne 1', `${name} RF00023 start contract`);
      mustInclude(source, '$tmRnaHit.end -ne 363', `${name} RF00023 end contract`);
      assert.doesNotMatch(
        source,
        /\$matches\s*=/i,
        `${name} must not shadow PowerShell's automatic $Matches variable`
      );
      assert.ok(
        !source.includes('-Start1 3471612'),
        `${name} must not pin the former re-originated MG1655 coordinate`
      );
    }
  });
});

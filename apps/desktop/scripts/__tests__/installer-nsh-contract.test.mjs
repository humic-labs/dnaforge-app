import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(desktopRoot, '../..');
const nshPath = path.join(desktopRoot, 'resources', 'installer.nsh');
const builderYmlPath = path.join(desktopRoot, 'electron-builder.yml');
const packageJsonPath = path.join(repoRoot, 'package.json');
const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml');
const appBuilderPatchPath = path.join(repoRoot, 'patches', 'app-builder-lib@26.15.3.patch');
const beaconPs1Path = path.join(desktopRoot, 'resources', 'dnaforge-install-beacon.ps1');
const identityPs1Path = path.join(desktopRoot, 'resources', 'dnaforge-download-identity.ps1');
const identityVectorPath = path.resolve(
  desktopRoot,
  '../../test-fixtures/analytics/windows-download-id-vectors.json'
);

const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const nsh = readText(nshPath);
const builderYml = readText(builderYmlPath);

function stripNsisComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/;.*$/, ''))
    .join('\n');
}

const codeOnly = stripNsisComments(nsh);

function macroBody(source, macroName) {
  const start = source.search(new RegExp(`!macro\\s+${macroName}\\b`));
  assert.ok(start >= 0, `missing !macro ${macroName}`);
  const after = source.slice(start);
  const end = after.search(/!macroend\b/);
  assert.ok(end >= 0, `missing !macroend for ${macroName}`);
  return after.slice(0, end);
}

function logicIfBlock(source, openingLine) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === openingLine);
  assert.ok(start >= 0, `missing NSIS conditional: ${openingLine}`);
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^\$\{If(?:Not)?\}(?:\s|$)/i.test(line)) depth += 1;
    if (/^\$\{EndIf\}(?:\s|$)/i.test(line)) {
      depth -= 1;
      if (depth === 0) return lines.slice(start, index + 1).join('\n');
    }
  }
  assert.fail(`unterminated NSIS conditional: ${openingLine}`);
}

function systemPluginRegister(nsisRegister) {
  const numbered = /^\$([0-9])$/.exec(nsisRegister);
  if (numbered) return Number(numbered[1]);
  const named = /^\$R([0-9])$/.exec(nsisRegister);
  assert.ok(named, `unsupported NSIS register ${nsisRegister}`);
  return Number(named[1]) + 10;
}

function assertSystemCallReturnsTo(source, apiName, nsisRegister) {
  const pluginRegister = systemPluginRegister(nsisRegister);
  assert.match(
    source,
    new RegExp(`System::Call\\s+'[^\\n]*${apiName}[^\\n]*i\\.r${pluginRegister}(?:\\s|')`),
    `${apiName} must return through System plug-in r${pluginRegister}, which maps to ${nsisRegister}`
  );
}

describe(' installer.nsh contract', () => {
  it('defines shared write macro and both electron-builder hooks', () => {
    assert.match(codeOnly, /!macro\s+DNAForgeInstallLogWrite\b/);
    assert.match(codeOnly, /!macro\s+customInit\b/);
    assert.match(codeOnly, /!macro\s+customInstall\b/);
  });

  it('uses versioned schema markers for init and install_complete (code, not comments)', () => {
    assert.match(codeOnly, /schema=1/);
    assert.match(codeOnly, /"init"/);
    assert.match(codeOnly, /"install_complete"/);
  });

  it('customInit dual-writes primary LocalAppData + $EXEDIR dnaforge-install.log', () => {
    const initBody = macroBody(codeOnly, 'customInit');
    assert.match(initBody, /DNAForgeInstallLogBuildLine\s+"init"/);
    assert.match(initBody, /\$LOCALAPPDATA\\DNAForge\\logs\\install\.log/);
    assert.match(initBody, /\$EXEDIR\\dnaforge-install\.log/);
    assert.match(initBody, /DNAForgeInstallLogWrite/);

    const writes = [...initBody.matchAll(/DNAForgeInstallLogWrite\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(
      writes.some((p) => p.includes('DNAForge\\logs\\install.log')),
      `customInit must write primary log; got writes=${JSON.stringify(writes)}`
    );
    assert.ok(
      writes.some((p) => p.includes('dnaforge-install.log')),
      `customInit must dual-write EXEDIR log; got writes=${JSON.stringify(writes)}`
    );
  });

  it('forces electron-updater --updated installs silent before any installer work', () => {
    const initBody = macroBody(codeOnly, 'customInit');
    assert.match(
      initBody,
      /\$\{If\}\s+\$\{isUpdated\}[\s\S]*?SetSilent\s+silent[\s\S]*?\$\{EndIf\}/
    );
    const updatedAt = initBody.indexOf('${If} ${isUpdated}');
    const silentAt = initBody.indexOf('SetSilent silent');
    const attemptAt = initBody.indexOf('[guid]::NewGuid');
    assert.ok(
      updatedAt >= 0 && silentAt > updatedAt,
      'updated installs must explicitly enter silent mode'
    );
    assert.ok(silentAt < attemptAt, 'silent mode must be set before beacons, logs, or file writes');
  });

  it('prepares registered manual replacements and updater replacements before legacy removal', () => {
    const prepareBody = macroBody(codeOnly, 'customPrepareUpdate');
    const validationBody = macroBody(codeOnly, 'DNAForgeValidateUpdaterRegistration');
    const quarantineBody = macroBody(codeOnly, 'DNAForgeQuarantineUpdaterDirectory');
    const suppressionBody = macroBody(codeOnly, 'DNAForgeSuppressUpdaterRegistration');
    const initBody = macroBody(codeOnly, 'customInit');
    const dependencyPatch = readText(appBuilderPatchPath);

    assert.doesNotMatch(
      prepareBody,
      /\$\{If\}\s+\$\{isUpdated\}/,
      'the patched install section owns runtime routing before it invokes this hook'
    );
    assert.match(prepareBody, /Var\s+\/GLOBAL\s+dnaforgeUpdaterQuarantine/);
    assert.match(prepareBody, /Var\s+\/GLOBAL\s+dnaforgeUpdaterDirectoryState/);
    assert.match(prepareBody, /Var\s+\/GLOBAL\s+dnaforgeUpdaterPrimaryRegistration/);
    assert.match(prepareBody, /Var\s+\/GLOBAL\s+dnaforgeUpdaterSecondaryRegistration/);
    assert.match(prepareBody, /StrCpy\s+\$dnaforgeUpdaterQuarantine\s+""/);
    assert.match(
      prepareBody,
      /DNAForgeValidateUpdaterRegistration\s+SHELL_CONTEXT\s+\$dnaforgeUpdaterPrimaryRegistration/
    );
    assert.match(
      prepareBody,
      /\$installMode\s*==\s*"all"[\s\S]*DNAForgeValidateUpdaterRegistration\s+HKEY_CURRENT_USER\s+\$dnaforgeUpdaterSecondaryRegistration/
    );
    const primaryValidationAt = prepareBody.indexOf(
      'DNAForgeValidateUpdaterRegistration SHELL_CONTEXT'
    );
    const secondaryValidationAt = prepareBody.indexOf(
      'DNAForgeValidateUpdaterRegistration HKEY_CURRENT_USER'
    );
    const quarantineAt = prepareBody.indexOf('DNAForgeQuarantineUpdaterDirectory');
    const primarySuppressionAt = prepareBody.indexOf(
      'DNAForgeSuppressUpdaterRegistration SHELL_CONTEXT'
    );
    const secondarySuppressionAt = prepareBody.indexOf(
      'DNAForgeSuppressUpdaterRegistration HKEY_CURRENT_USER'
    );
    assert.ok(primaryValidationAt >= 0 && secondaryValidationAt >= 0 && quarantineAt >= 0);
    assert.ok(
      Math.max(primaryValidationAt, secondaryValidationAt) < quarantineAt,
      'every registry scope must be validated before either scope can move the installation'
    );
    assert.ok(
      quarantineAt < Math.min(primarySuppressionAt, secondarySuppressionAt),
      'uninstall commands may be suppressed only after the directory is safe to replace'
    );
    assert.doesNotMatch(
      `${initBody}\n${prepareBody}`,
      /"\$\{VERSION\}"\s*==/,
      'predecessor rescue must not disappear when the candidate version advances'
    );

    assert.match(validationBody, /ReadRegStr[\s\S]*DisplayVersion/);
    assert.match(validationBody, /ReadRegStr[\s\S]*InstallLocation/);
    assert.match(validationBody, /ReadRegStr[\s\S]*UninstallString/);
    const absentRegistration = logicIfBlock(validationBody, '${If} $R0 == ""');
    assert.match(absentRegistration, /\$\{AndIf\}\s+\$R1\s*==\s*""/);
    assert.match(absentRegistration, /\$\{AndIf\}\s+\$R2\s*==\s*""/);
    assert.match(absentRegistration, /Goto\s+dnaforge_validate_done_/);
    const missingInstallLocation = logicIfBlock(validationBody, '${If} $R1 == ""');
    assert.match(missingInstallLocation, /Goto\s+dnaforge_validate_failed_/);
    assert.doesNotMatch(
      missingInstallLocation,
      /StrCpy\s+\$R1\s+"\$INSTDIR"/,
      'a missing registered path must remain unverified and preserve the old updater registration'
    );
    const mismatchedInstallLocation = logicIfBlock(validationBody, '${If} $R1 != "$INSTDIR"');
    assert.match(mismatchedInstallLocation, /Goto\s+dnaforge_validate_failed_/);
    assert.equal(
      [...validationBody.matchAll(/StrCpy\s+\$\{stateVar\}\s+"same"/g)].length,
      1,
      'only an exact registered-path match may authorize later registry suppression'
    );
    assert.doesNotMatch(validationBody, /MoveFileW|DeleteRegValue/);

    assert.match(quarantineBody, /\$INSTDIR/);
    assert.match(quarantineBody, /GetTempFileName/);
    assert.ok(
      quarantineBody.indexOf('SetOutPath "$TEMP"') < quarantineBody.indexOf('GetFileAttributesW'),
      'the installer must leave INSTDIR before inspecting or moving that directory'
    );
    assertSystemCallReturnsTo(quarantineBody, 'GetFileAttributesW', '$R5');
    assert.match(
      quarantineBody,
      /System::Call\s+'kernel32::GetFileAttributesW\([^\n]+\)\s+i\.r15\s+\?e'\s*\n\s*Pop\s+\$R4\s*\n\s*\$\{If\}\s+\$R5\s*==\s*-1/,
      'file attributes and the associated Windows error must be captured atomically'
    );
    assert.doesNotMatch(
      quarantineBody,
      /kernel32::GetLastError/,
      'a later call can observe an unrelated Windows error and must not authorize registry suppression'
    );
    const absentDirectory = logicIfBlock(quarantineBody, '${If} $R5 == -1');
    assert.match(absentDirectory, /\$\{If\}\s+\$R4\s*==\s*2/);
    assert.match(absentDirectory, /\$\{OrIf\}\s+\$R4\s*==\s*3/);
    assert.match(absentDirectory, /StrCpy\s+\$dnaforgeUpdaterDirectoryState\s+"absent"/);
    assert.equal(
      [...quarantineBody.matchAll(/StrCpy\s+\$dnaforgeUpdaterDirectoryState\s+"absent"/g)].length,
      1,
      'only Win32 file-not-found errors may prove the old directory absent'
    );
    assert.match(quarantineBody, /MoveFileW/);
    assertSystemCallReturnsTo(quarantineBody, 'MoveFileW', '$R5');
    assert.match(quarantineBody, /\$R4\s*<\s*60/);
    assert.match(quarantineBody, /Sleep\s+500/);
    assert.match(quarantineBody, /after 30 seconds/);
    const successfulMove = logicIfBlock(quarantineBody, '${If} $R5 != 0');
    assert.match(successfulMove, /Goto\s+dnaforge_quarantine_moved_/);
    assert.equal(
      [...quarantineBody.matchAll(/Goto\s+dnaforge_quarantine_moved_/g)].length,
      1,
      'no path outside the successful MoveFileW predicate may claim the directory moved'
    );
    assert.doesNotMatch(
      quarantineBody.replace(successfulMove, ''),
      /Goto\s+dnaforge_quarantine_moved_/
    );
    assert.match(
      quarantineBody,
      /MoveFileW[^\n]*i\.r15'\s*\n\s*\$\{If\}\s+\$R5\s*!=\s*0\s*\n\s*Goto\s+dnaforge_quarantine_moved_[\s\S]*dnaforge_quarantine_moved_[^:]+:[\s\S]*StrCpy\s+\$dnaforgeUpdaterDirectoryState\s+"moved"/,
      'only a successful atomic directory move may produce the moved state'
    );
    assert.equal(
      [...quarantineBody.matchAll(/StrCpy\s+\$dnaforgeUpdaterDirectoryState\s+"moved"/g)].length,
      1
    );
    assert.match(quarantineBody, /StrCpy\s+\$dnaforgeUpdaterQuarantine\s+"\$R3"/);
    assert.doesNotMatch(quarantineBody, /RMDir\s+\/r\s+"\\\\\?\\\$R3"/);
    assert.doesNotMatch(quarantineBody, /DeleteRegValue|DeleteRegKey/);
    assert.doesNotMatch(
      quarantineBody,
      /dnaforge_quarantine_done_/,
      'the directory macro must not emit an unused label because NSIS warnings fail packaging'
    );
    assert.doesNotMatch(
      quarantineBody,
      /\$\{FileExists\}\s+"\$INSTDIR\\\*\.\*"/,
      'a wildcard existence check may not authorize suppressing the registered old uninstaller'
    );
    const overwriteGuard = logicIfBlock(
      quarantineBody,
      '${If} $dnaforgeUpdaterDirectoryState == "moved"'
    );
    assert.match(overwriteGuard, /\$\{OrIf\}\s+\$dnaforgeUpdaterDirectoryState\s*==\s*"absent"/);
    assert.match(overwriteGuard, /SetOverwrite\s+on/);
    assert.doesNotMatch(quarantineBody.replace(overwriteGuard, ''), /SetOverwrite\s+on/);

    const registrationGuard = logicIfBlock(suppressionBody, '${If} ${stateVar} == "same"');
    assert.match(
      registrationGuard,
      /\$\{If\}\s+\$dnaforgeUpdaterDirectoryState\s*==\s*"moved"[\s\S]*\$\{OrIf\}\s+\$dnaforgeUpdaterDirectoryState\s*==\s*"absent"/
    );
    assert.match(registrationGuard, /DeleteRegValue[\s\S]*"UninstallString"/);
    assert.match(registrationGuard, /DeleteRegValue[\s\S]*"QuietUninstallString"/);
    assert.doesNotMatch(suppressionBody.replace(registrationGuard, ''), /DeleteRegValue/);
    assert.match(`${validationBody}\n${quarantineBody}`, /DNAForge\.exe/);
    assert.match(`${validationBody}\n${quarantineBody}`, /Restart now/);
    assert.match(`${validationBody}\n${quarantineBody}`, /https:\/\/dnaforge\.com\/download/);

    const installSectionPatch = dependencyPatch.slice(
      dependencyPatch.indexOf('diff --git a/templates/nsis/installSection.nsh')
    );
    const replacementBranchAt = installSectionPatch.indexOf('+!ifmacrodef customPrepareUpdate');
    const replacementBranchEnd = installSectionPatch.indexOf('+!endif', replacementBranchAt);
    assert.ok(replacementBranchAt >= 0 && replacementBranchEnd > replacementBranchAt);
    const replacementBranch = installSectionPatch.slice(
      replacementBranchAt,
      replacementBranchEnd + '+!endif'.length
    );
    const emittedReplacementBranch = replacementBranch
      .split('\n')
      .map((line) => (line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line))
      .join('\n');
    const updatedRuntime = logicIfBlock(
      emittedReplacementBranch,
      '${if} $dnaforgeUpdaterDirectoryState == "moved"'
    );
    const runtimeElseAt = updatedRuntime.indexOf('${else}');
    assert.ok(runtimeElseAt > 0, 'unprepared installations must retain ordinary removal');
    const autoUpdateBranch = updatedRuntime.slice(0, runtimeElseAt);
    const manualInstallBranch = updatedRuntime.slice(runtimeElseAt);
    assert.match(emittedReplacementBranch, /!insertmacro customPrepareUpdate/);
    assert.ok(
      emittedReplacementBranch.indexOf('!insertmacro customPrepareUpdate') <
        emittedReplacementBranch.indexOf('${if} $dnaforgeUpdaterDirectoryState')
    );
    assert.match(autoUpdateBranch, /\$\{orIf\} \$dnaforgeUpdaterDirectoryState == "absent"/);
    assert.doesNotMatch(autoUpdateBranch, /!insertmacro uninstallOldVersion/);
    assert.match(manualInstallBranch, /!insertmacro uninstallOldVersion SHELL_CONTEXT/);
    assert.match(manualInstallBranch, /!insertmacro handleUninstallResult SHELL_CONTEXT/);
    assert.match(manualInstallBranch, /!insertmacro uninstallOldVersion HKEY_CURRENT_USER/);
    assert.match(manualInstallBranch, /!insertmacro handleUninstallResult HKEY_CURRENT_USER/);
    const noHookElseAt = replacementBranch.indexOf('\n+!else\n');
    assert.ok(noHookElseAt > 0, 'the compile-time no-hook branch must exist');
    const noHookBranch = replacementBranch.slice(
      noHookElseAt + '\n+!else\n'.length,
      replacementBranch.lastIndexOf('\n+!endif')
    );
    assert.doesNotMatch(noHookBranch, /!insertmacro customPrepareUpdate/);
    assert.match(noHookBranch, /!insertmacro uninstallOldVersion SHELL_CONTEXT/);
    assert.match(noHookBranch, /!insertmacro handleUninstallResult SHELL_CONTEXT/);
    assert.match(noHookBranch, /!insertmacro uninstallOldVersion HKEY_CURRENT_USER/);
    assert.match(noHookBranch, /!insertmacro handleUninstallResult HKEY_CURRENT_USER/);
    assert.equal([...noHookBranch.matchAll(/!insertmacro uninstallOldVersion/g)].length, 2);
    assert.equal([...noHookBranch.matchAll(/!insertmacro handleUninstallResult/g)].length, 2);
    assert.equal(
      [...replacementBranch.matchAll(/!insertmacro uninstallOldVersion/g)].length,
      4,
      'unprepared installs need the stock path both with and without the custom hook compiled'
    );
    assert.doesNotMatch(
      installSectionPatch.replace(replacementBranch, ''),
      /!insertmacro (?:uninstallOldVersion|handleUninstallResult)/,
      'candidate-owned replacement and every predecessor uninstaller call must be mutually exclusive'
    );
  });

  it('does not quarantine a manually selected unregistered or different directory', () => {
    const prepareBody = macroBody(codeOnly, 'customPrepareUpdate');
    const manualGuard = logicIfBlock(prepareBody, '${IfNot} ${isUpdated}');
    assert.match(manualGuard, /ReadRegStr \$R0 SHELL_CONTEXT[^\n]+"InstallLocation"/);
    assert.match(manualGuard, /\$\{If\} \$R0 != "\$INSTDIR"/);
    assert.match(
      manualGuard,
      /\$\{If\} \$installMode == "all"[\s\S]*ReadRegStr \$R0 HKEY_CURRENT_USER/
    );
    assert.match(manualGuard, /Goto dnaforge_prepare_done_/);
    assert.ok(
      prepareBody.indexOf(manualGuard) <
        prepareBody.indexOf('!insertmacro DNAForgeValidateUpdaterRegistration')
    );
    assert.ok(
      prepareBody.indexOf('!insertmacro DNAForgeValidateUpdaterRegistration') <
        prepareBody.indexOf('!insertmacro DNAForgeQuarantineUpdaterDirectory')
    );
    assert.ok(
      prepareBody.indexOf('dnaforge_prepare_done_${DNAFORGE_PREPARE_UID}:') >
        prepareBody.indexOf('!insertmacro DNAForgeSuppressUpdaterRegistration')
    );
  });

  it('moves updated installations as one extended-length directory and preserves them on failure', () => {
    const removeBody = macroBody(codeOnly, 'customRemoveFiles');
    assert.ok(removeBody.includes('SetOutPath "$TEMP"'));
    assert.ok(removeBody.includes('${If} ${isUpdated}'));
    assert.ok(removeBody.includes('${GetParent} "$INSTDIR" $R0'));
    assert.ok(removeBody.includes('GetTempFileName $R1 "$R0"'));
    assert.ok(
      removeBody.includes(
        'System::Call \'kernel32::MoveFileW(w "\\\\?\\$INSTDIR", w "\\\\?\\$R1") i.r0\''
      )
    );
    assert.doesNotMatch(removeBody, /\bRename\b/);
    assert.match(removeBody, /\$0\s*==\s*0[\s\S]*SetErrorLevel\s+2[\s\S]*Abort/);
    assert.match(
      removeBody,
      /GetTempFileName[\s\S]*\$\{Errors\}[\s\S]*SetErrorLevel\s+2[\s\S]*Abort/
    );
    assert.ok(
      removeBody.indexOf('MoveFileW') < removeBody.indexOf('RMDir /r "\\\\?\\$R1"'),
      'cleanup must start only after the whole installation directory moved'
    );
    assert.ok(
      removeBody.includes('${Else}\n    RMDir /r "\\\\?\\$INSTDIR"'),
      'ordinary uninstalls must remove the installation through an extended-length path'
    );
  });

  it('retains the vendor UserProgramFiles fix with the pinned update-safety patch', () => {
    const packageJson = JSON.parse(readText(packageJsonPath));
    assert.equal(
      packageJson.pnpm?.patchedDependencies?.['app-builder-lib@26.15.3'],
      'patches/app-builder-lib@26.15.3.patch'
    );
    assert.ok(existsSync(appBuilderPatchPath), 'the pinned app-builder-lib patch must exist');

    const dependencyPatch = readText(appBuilderPatchPath);
    assert.doesNotMatch(dependencyPatch, /diff --git a\/templates\/nsis\/multiUser\.nsh/);
    const installedTemplate = readText(
      require.resolve('app-builder-lib/templates/nsis/multiUser.nsh')
    );
    const vendorCode = stripNsisComments(installedTemplate);
    assert.match(
      vendorCode,
      /^.*System::Call 'KERNEL32::lstrcpynW\(w \.r0, p r2, i \$\{NSIS_MAX_STRLEN\}\)p'/m
    );
    assert.match(vendorCode, /^\s*Push \$1$/m);
    assert.match(vendorCode, /^\s*Push \$2$/m);
    assert.match(vendorCode, /^\s*Pop \$2$/m);
    assert.match(vendorCode, /^\s*Pop \$1$/m);

    const lockfile = readText(lockfilePath);
    assert.match(
      lockfile,
      /patchedDependencies:\n(?:[^\n]*\n)*?  app-builder-lib@26\.15\.3:\n(?:[^\n]*\n)*?    path: patches\/app-builder-lib@26\.15\.3\.patch/
    );
  });

  it('customInstall writes install_complete to primary only', () => {
    const installBody = macroBody(codeOnly, 'customInstall');
    assert.match(installBody, /DNAForgeInstallLogBuildLine\s+"install_complete"/);
    assert.match(installBody, /\$LOCALAPPDATA\\DNAForge\\logs\\install\.log/);
    assert.doesNotMatch(installBody, /\$EXEDIR\\dnaforge-install\.log/);
    assert.match(
      installBody,
      /\$dnaforgeUpdaterQuarantine\s*!=\s*""[\s\S]*RMDir\s+\/r\s+"\\\\\?\\\$dnaforgeUpdaterQuarantine"/
    );
    assert.ok(
      installBody.indexOf('"install_complete"') <
        installBody.indexOf('RMDir /r "\\\\?\\$dnaforgeUpdaterQuarantine"'),
      'the old installation quarantine must survive until the candidate reports install_complete'
    );
  });

  it('best-effort writes: CreateDirectory / FileOpen / FileWrite / FileClose / ClearErrors', () => {
    assert.match(codeOnly, /CreateDirectory/);
    assert.match(codeOnly, /FileOpen/);
    assert.match(codeOnly, /FileWrite/);
    assert.match(codeOnly, /FileClose/);

    assert.doesNotMatch(codeOnly, /FileFlush/);
    assert.match(codeOnly, /ClearErrors/);
  });

  it('restricts Abort to preserving or reopening the old installation when directory movement fails', () => {
    const removeBody = macroBody(codeOnly, 'customRemoveFiles');
    const validationBody = macroBody(codeOnly, 'DNAForgeValidateUpdaterRegistration');
    const quarantineBody = macroBody(codeOnly, 'DNAForgeQuarantineUpdaterDirectory');
    assert.equal((removeBody.match(/\bAbort\b/g) ?? []).length, 2);
    assert.equal((quarantineBody.match(/\bAbort\b/g) ?? []).length, 2);
    assert.equal((validationBody.match(/\bAbort\b/g) ?? []).length, 1);
    assert.match(
      validationBody,
      /Exec[\s\S]*DNAForge\.exe[\s\S]*\$\{IfNot\} \$\{Silent\}[\s\S]*MessageBox[\s\S]*\$\{EndIf\}[\s\S]*Abort/
    );
    assert.equal(
      (quarantineBody.match(/\$\{IfNot\} \$\{Silent\}[\s\S]*?MessageBox[\s\S]*?\$\{EndIf\}/g) ?? [])
        .length,
      2,
      'silent auto-update failures must abort without waiting on a hidden dialog'
    );
    assert.doesNotMatch(
      codeOnly.replace(removeBody, '').replace(validationBody, '').replace(quarantineBody, ''),
      /\bAbort\b/
    );
    assert.doesNotMatch(codeOnly, /DNAFORGE_ABORT/i);
    assert.doesNotMatch(codeOnly, /!define\s+\w*ABORT/i);
  });

  it('mints attempt_id and fires best-effort install beacons from customInit/customInstall', () => {
    assert.match(nsh, /!macro\s+DNAForgeInstallBeacon\b/);
    assert.match(nsh, /install-beacon/);
    assert.match(nsh, /DNAFORGE_DIAGNOSTICS_BASE/);

    assert.match(nsh, /dnaforge-diagnostics-url\.txt/);
    assert.match(nsh, /dnaforge-install-beacon\.ps1/);
    assert.match(nsh, /InitPluginsDir/);
    assert.match(nsh, /-File "\$PLUGINSDIR\\dnaforge-install-beacon\.ps1"/);
    assert.doesNotMatch(nsh, /!macro\s+DNAForgeResolveDiagnosticsBase\b/);
    assert.doesNotMatch(nsh, /Uri ''\$R5\//);
    assert.ok(existsSync(beaconPs1Path), 'resources/dnaforge-install-beacon.ps1 must ship');
    const beaconPs1 = readText(beaconPs1Path);
    assert.match(beaconPs1, /Invoke-RestMethod/);
    assert.match(beaconPs1, /dnaforge-diagnostics-url\.txt/);
    assert.match(beaconPs1, /telemetry_actor/);
    assert.match(beaconPs1, /event_id\s*=\s*\[guid\]::NewGuid\(\)\.ToString\(\)/);
    assert.match(beaconPs1, /\$bodyJson\s*=\s*\$body\s*\|\s*ConvertTo-Json/);
    assert.match(beaconPs1, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
    assert.match(beaconPs1, /-Body \$bodyJson/);
    assert.match(beaconPs1, /\$statusCode -eq 429/);
    assert.match(beaconPs1, /\$statusCode -ge 500/);
    assert.match(beaconPs1, /DNAFORGE_TELEMETRY_ACTOR/);
    assert.match(beaconPs1, /DNAFORGE_TELEMETRY_ACTOR_ASSERTION/);
    assert.match(beaconPs1, /DNAFORGE_ALLOW_DIAGNOSTICS_URL_OVERRIDE/);
    assert.match(beaconPs1, /127\\\.0\\\.0\\\.1\|localhost\|\\\[::1\\\]/);
    assert.doesNotMatch(beaconPs1, /\^https\?\:\/\//);
    assert.match(beaconPs1, /telemetry_actor_assertion/);
    assert.doesNotMatch(beaconPs1, /GITHUB_ACTIONS/);
    assert.match(beaconPs1, /DNAFORGE_TELEMETRY_CI_RUN_ID/);
    assert.match(nsh, /!define DNAFORGE_BUILD_TAG "\$%DNAFORGE_BUILD_TAG%"/);
    assert.match(nsh, /!define DNAFORGE_RELEASE_CHANNEL "\$%DNAFORGE_RELEASE_CHANNEL%"/);
    assert.match(nsh, /-DesktopBuildTag "\$\{DNAFORGE_BUILD_TAG\}"/);
    assert.match(nsh, /-DesktopReleaseChannel "\$\{DNAFORGE_RELEASE_CHANNEL\}"/);
    assert.match(beaconPs1, /\$body\.desktop_build_tag = \$DesktopBuildTag/);
    assert.match(beaconPs1, /\$body\.desktop_release_channel = \$releaseChannel/);
    assert.doesNotMatch(beaconPs1, /\$env:DNAFORGE_BUILD_TAG/);
    assert.doesNotMatch(beaconPs1, /\$env:DNAFORGE_RELEASE_CHANNEL/);

    const initBody = macroBody(codeOnly, 'customInit');
    assert.match(initBody, /\[guid\]::NewGuid/);
    assert.match(initBody, /install-attempt\.id/);
    assert.match(initBody, /DNAForgeInstallBeacon\s+"init"/);

    const beaconAt = initBody.search(/DNAForgeInstallBeacon\s+"init"/);
    const logAt = initBody.search(/DNAForge\\logs\\install\.log/);
    assert.ok(
      beaconAt >= 0 && logAt >= 0 && beaconAt < logAt,
      'customInit must fire init beacon before writing install.log'
    );

    const installBody = macroBody(codeOnly, 'customInstall');
    assert.match(installBody, /DNAForgeInstallBeacon\s+"install_complete"/);
  });

  it('overwrites the current-run file and clears stale download attribution for unmarked runs', () => {
    const identityBody = macroBody(codeOnly, 'DNAForgeInstallIdentityWrite');
    assert.match(identityBody, /Delete\s+`\$\{path\}`/);
    assert.match(identityBody, /IfErrors\s+dnaforge_install_identity_write_done_/);
    assert.match(identityBody, /FileOpen\s+\$R8\s+`\$\{path\}`\s+w/);
    assert.doesNotMatch(identityBody, /FileSeek/);
    assert.match(identityBody, /FileWrite\s+\$R8\s+`\$\{attemptId\}\$\\r\$\\n`/);
    assert.match(identityBody, /\$\{If\}\s+`\$\{downloadId\}`\s+!=\s+""/);

    const initBody = macroBody(codeOnly, 'customInit');
    assert.match(initBody, /dnaforge-download-identity\.ps1/);
    assert.match(initBody, /-InstallerPath "\$EXEPATH"/);
    assert.match(initBody, /DNAForgeInstallIdentityWrite[\s\S]*?"\$R6"\s+"\$R4"/);
    assert.ok(existsSync(identityPs1Path));
    assert.ok(existsSync(identityVectorPath));
  });

  it('keeps the download marker reporting-only and passes it to both installer beacons', () => {
    const parser = readText(identityPs1Path);
    const vectors = JSON.parse(readText(identityVectorPath));
    assert.match(parser, /\^DNAForge-Setup-/);
    assert.match(parser, /\[1-9\]\[0-9\]\*/);
    assert.match(parser, /-cmatch/);
    assert.ok(vectors.valid.some(({ filename }) => filename.endsWith(' (100).exe')));
    assert.ok(vectors.invalid.some((filename) => filename.endsWith(' (001).exe')));
    assert.match(nsh, /-DownloadId "\$R4"/);
    const beacon = readText(beaconPs1Path);
    assert.match(beacon, /\[string\]\$DownloadId/);
    assert.match(beacon, /\$body\.download_id = \$DownloadId/);
  });

  it('removes PowerShell CRLF from installer identities in the correct order', () => {
    const initBody = macroBody(codeOnly, 'customInit');
    for (const variable of ['$R6', '$R4']) {
      const lfTrim = `StrCpy ${variable} ${variable} -1`;
      const lfCheck = initBody.indexOf(`$\\n\"\n    ${lfTrim}`);
      const crCheck = initBody.indexOf(`$\\r\"\n    ${lfTrim}`);
      assert.ok(lfCheck >= 0, `${variable} must remove the trailing line feed`);
      assert.ok(crCheck > lfCheck, `${variable} must remove carriage return after line feed`);
    }
  });

  it('wires electron-builder nsis.include to installer.nsh basename', () => {
    assert.match(builderYml, /nsis:\s*\n(?:[ \t]+.+\n)*[ \t]+include:\s*installer\.nsh\b/);
    assert.doesNotMatch(builderYml, /include:\s*resources\/installer\.nsh/);
  });
});

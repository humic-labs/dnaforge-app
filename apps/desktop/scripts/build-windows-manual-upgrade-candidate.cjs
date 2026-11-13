const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { build, Platform, Arch } = require('electron-builder');
const asar = require('@electron/asar');

const baselineHash = '4f8673cad447590545d963365f8a3cb45d3467078f92e748734715938b401122';
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main() {
  if (process.platform !== 'win32') throw new Error('Requires Windows NSIS and signing');
  const [installer, destination, mode] = process.argv.slice(2);
  if (!installer || !destination || !['--signed', '--unsigned-test-only'].includes(mode)) {
    throw new Error(
      'Usage: node build-windows-manual-upgrade-candidate.cjs ORIGINAL-0.9.7.exe OUTPUT --signed|--unsigned-test-only'
    );
  }
  if (hash(installer) !== baselineHash) throw new Error('Original 0.9.7 installer digest mismatch');
  const output = path.resolve(destination);
  fs.mkdirSync(output, { recursive: true });
  const outer = path.join(output, 'original-container');
  let payload = path.join(output, 'full-original-payload');
  const seven = require('7zip-bin').path7za;
  const extract = (file, target) =>
    execFileSync(seven, ['x', file, `-o${target}`, '-y'], { stdio: 'pipe' });
  extract(path.resolve(installer), outer);
  const archive = path.join(outer, '$PLUGINSDIR', 'app-64.7z');
  if (fs.existsSync(archive)) {
    extract(archive, payload);
  } else {
    payload = outer;
  }
  const application = path.join(payload, 'resources', 'app.asar');
  const packageJson = JSON.parse(asar.extractFile(application, 'package.json'));
  if (packageJson.version !== '0.9.7' || packageJson.name !== '@waypoint/desktop')
    throw new Error('Unexpected original app identity');
  const originalAsarHash = hash(application);
  const project = path.join(output, 'installer-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        description: 'Desktop app for molecular biology',
        author: 'Peter Ciaccia',
        main: packageJson.main,
      },
      null,
      2
    )
  );
  const resources = path.resolve(__dirname, '../resources');
  const signed = mode === '--signed';
  const win = { target: ['nsis'], artifactName: 'DNAForge-Setup-${version}.${ext}' };
  if (signed)
    win.azureSignOptions = {
      publisherName: 'C=US, S=California, L=San Francisco, O=Humic Labs Inc., CN=Humic Labs Inc.',
      endpoint: 'https://eus.codesigning.azure.net/',
      certificateProfileName: 'dnaforge-windows-prod',
      codeSigningAccountName: 'dnaforge-signing-prod',
    };
  await build({
    projectDir: project,
    prepackaged: payload,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      extends: null,
      appId: 'com.dnaforge.desktop',
      productName: 'DNAForge',
      copyright: 'Copyright (c) 2026 Humic Labs Inc.',
      forceCodeSigning: signed,
      electronVersion: '45.1.0',
      directories: { buildResources: resources, output: path.join(output, 'candidate') },
      win,
      nsis: { include: 'installer.nsh' },
    },
  });
  if (hash(application) !== originalAsarHash)
    throw new Error('Repackaging changed the original application');
  const candidate = path.join(output, 'candidate', 'DNAForge-Setup-0.9.7.exe');
  const receipt = {
    kind: 'full-payload-installer-only-repair',
    signed,
    sourceSha: process.env.GITHUB_SHA || null,
    originalInstallerSha256: baselineHash,
    originalAppAsarSha256: originalAsarHash,
    candidateInstallerSha256: hash(candidate),
    appVersion: '0.9.7',
    candidate,
    installerHookSha256: hash(path.join(resources, 'installer.nsh')),
    dependencyPatchSha256: hash(
      path.resolve(__dirname, '../../..', 'patches/app-builder-lib@26.15.3.patch')
    ),
    limitation:
      'Application bytes are the complete signed 0.9.7 release; only the installer is rebuilt from the recorded repair source.',
  };
  fs.writeFileSync(path.join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

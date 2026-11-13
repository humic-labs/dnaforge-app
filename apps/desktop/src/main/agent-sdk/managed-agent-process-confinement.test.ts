import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  root: '',
  appData: '',
  appCode: '',
  home: '',
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => 'test',
    getAppPath: () => state.appCode,
    getPath: (name: string) => (name === 'userData' ? state.appData : state.home),
  },
}));
vi.mock('../ipc/database', () => ({ getDb: () => state.db! }));

import { openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { prepareManagedAgentProcessConfinement } from './agent-process-confinement';

const exec = promisify(execFile);
afterEach(async () => {
  state.db?.close();
  state.db = null;
  if (state.root) await rm(state.root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'darwin')(
  'keeps private worker sockets usable with long app profiles without admitting unowned working folders',
  async () => {
    state.root = await realpath(await mkdtemp(join(tmpdir(), 'dna4162-ipc-')));
    state.appData = join(state.root, 'long-app-profile-'.repeat(8));
    state.appCode = join(state.root, 'app-code');
    state.home = join(state.root, 'home');
    await Promise.all([
      mkdir(state.appData),
      mkdir(state.appCode),
      mkdir(join(state.home, '.codex'), { recursive: true }),
    ]);
    const database = join(state.appData, 'dnaforge.db');
    state.db = openFileTestDb(database);
    ensureSchema(state.db, database);
    const env = { ...process.env, HOME: state.home, CODEX_HOME: join(state.home, '.codex') };
    await expect(
      prepareManagedAgentProcessConfinement({
        provider: 'codex',
        purpose: 'chat',
        cwd: tmpdir(),
        env,
      })
    ).rejects.toThrow('the working folder has no registered project owner');
    const confinement = await prepareManagedAgentProcessConfinement({
      provider: 'codex',
      purpose: 'probe',
      env,
    });
    try {
      const code = [
        'const net=require("node:net"),path=require("node:path");',
        'const endpoint=path.join(process.env.TMPDIR,"dna4162-broker-alias.sock");',
        'const server=net.createServer(socket=>socket.end("PRIVATE_READY"));',
        'server.once("error",error=>console.log(error.code));',
        'server.listen(endpoint,()=>{',
        ' const socket=net.connect(endpoint);',
        ' socket.on("data",data=>console.log(data.toString()));',
        ' socket.on("end",()=>server.close());',
        '});',
      ].join('\n');
      const launch = confinement.wrap(process.execPath, ['-e', code], env);
      const result = await exec(launch.command, launch.args, {
        cwd: confinement.cwd,
        env: launch.env,
        timeout: 10000,
      });
      expect(result.stdout).toContain('PRIVATE_READY');
    } finally {
      confinement.dispose();
    }
  }
);

it.skipIf(process.platform !== 'darwin')(
  'admits app-owned chat folders without granting sibling app storage',
  async () => {
    state.root = await realpath(await mkdtemp(join(tmpdir(), 'dna4162-chat-')));
    state.appData = join(state.root, 'app-data');
    state.appCode = join(state.root, 'app-code');
    state.home = join(state.root, 'home');
    const chat = join(state.appData, 'cli-scratch', 'chats', 'conversation');
    const protectedState = join(state.appData, 'retained-state.json');
    await Promise.all([
      mkdir(chat, { recursive: true }),
      mkdir(state.appCode),
      mkdir(join(state.home, '.codex'), { recursive: true }),
    ]);
    await writeFile(protectedState, 'retained app state');
    const database = join(state.appData, 'dnaforge.db');
    state.db = openFileTestDb(database);
    ensureSchema(state.db, database);
    const env = { ...process.env, HOME: state.home, CODEX_HOME: join(state.home, '.codex') };
    const confinement = await prepareManagedAgentProcessConfinement({
      provider: 'codex',
      purpose: 'chat',
      cwd: chat,
      env,
    });
    try {
      const code = [
        'const fs=require("node:fs");',
        'fs.writeFileSync("chat-content.txt","permitted chat content");',
        `try{fs.writeFileSync(${JSON.stringify(protectedState)},"BAD");}catch(error){console.log(error.code);}`,
      ].join('\n');
      const launch = confinement.wrap(process.execPath, ['-e', code], env);
      const result = await exec(launch.command, launch.args, {
        cwd: confinement.cwd,
        env: launch.env,
        timeout: 10000,
      });
      expect(result.stdout).toContain('EPERM');
      expect(await readFile(join(chat, 'chat-content.txt'), 'utf8')).toBe('permitted chat content');
      expect(await readFile(protectedState, 'utf8')).toBe('retained app state');
      expect(state.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 0,
      });
    } finally {
      confinement.dispose();
    }
  }
);

it.skipIf(process.platform !== 'darwin')(
  'confines a real registered managed project while retaining content, scratch and app-code reads',
  async () => {
    state.root = await realpath(await mkdtemp(join(tmpdir(), 'dna4162-managed-agent-')));
    state.appData = join(state.root, 'app-data');
    state.appCode = join(state.root, 'app-code');
    state.home = join(state.root, 'home');
    await Promise.all([
      mkdir(state.appData),
      mkdir(state.appCode),
      mkdir(join(state.home, '.codex'), { recursive: true }),
    ]);
    const database = join(state.appData, 'dnaforge.db');
    state.db = openFileTestDb(database);
    ensureSchema(state.db, database);
    const uuid = randomUUID();
    const siblingUuid = randomUUID();
    const managedStore = join(state.appData, 'managed-workspaces');
    const project = join(managedStore, uuid, 'repo');
    const sibling = join(managedStore, siblingUuid, 'repo');
    const unregistered = join(state.root, 'unregistered');
    await Promise.all([
      mkdir(join(project, '.git'), { recursive: true }),
      mkdir(join(sibling, '.git'), { recursive: true }),
      mkdir(unregistered),
    ]);
    const marker = join(project, '.dnaforge-workspace.json');
    const siblingFile = join(sibling, 'retained.txt');
    const appState = join(state.appData, 'authority-state.json');
    const appCode = join(state.appCode, 'companion.cjs');
    const markerContents = JSON.stringify({
      schema: 1,
      workspaceUuid: uuid,
      originPath: null,
      importedAt: 1,
    });
    await Promise.all([
      writeFile(marker, markerContents),
      writeFile(join(project, '.git', 'config'), 'retained git config'),
      writeFile(
        join(sibling, '.dnaforge-workspace.json'),
        JSON.stringify({ schema: 1, workspaceUuid: siblingUuid })
      ),
      writeFile(siblingFile, 'retained sibling'),
      writeFile(appState, 'retained app authority'),
      writeFile(appCode, 'module.exports = "app code remains readable";'),
    ]);
    for (const [root, repoUuid] of [
      [project, uuid],
      [sibling, siblingUuid],
    ])
      state.db
        .prepare(
          'INSERT INTO workspaces(name,path,repo_uuid,created_at,last_opened_at,access_mode) VALUES(?,?,?,1,1,?)'
        )
        .run('Managed project', root, repoUuid, 'writable');
    const env = { ...process.env, HOME: state.home, CODEX_HOME: join(state.home, '.codex') };
    const packagesDirectory = join(env.CODEX_HOME, 'packages');
    const installation = join(packagesDirectory, 'provider');
    const runtimeBinary = join(installation, 'bin', 'cli');
    const runtimeAlias = join(env.CODEX_HOME, 'selected-provider');
    const providerConfig = join(env.CODEX_HOME, 'config.toml');
    const providerAuth = join(env.CODEX_HOME, 'auth.json');
    const providerSession = join(env.CODEX_HOME, 'sessions', 'result.json');
    await mkdir(join(installation, 'bin'), { recursive: true });
    await Promise.all([
      writeFile(runtimeBinary, '#!/bin/sh\nprintf safe-provider\\n\n', { mode: 0o700 }),
      writeFile(providerConfig, 'model = "safe-provider"\n'),
      symlink(installation, runtimeAlias, 'dir'),
    ]);
    for (const request of [{ cwd: unregistered }, { cwd: project, writableRoots: [unregistered] }])
      await expect(
        prepareManagedAgentProcessConfinement({
          provider: 'codex',
          purpose: 'chat',
          env,
          ...request,
        })
      ).rejects.toMatchObject({ code: 'AGENT_PROCESS_CONFINEMENT_UNAVAILABLE' });
    const confinement = await prepareManagedAgentProcessConfinement({
      provider: 'codex',
      purpose: 'chat',
      cwd: project,
      env,
      runtimeExecutable: join(runtimeAlias, 'bin', 'cli'),
    });
    try {
      const targets = [
        marker,
        database,
        siblingFile,
        appState,
        appCode,
        join(managedStore, 'forged-project'),
      ];
      const attack = [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'fs.writeFileSync(path.join(process.cwd(), "results.txt"), "permitted content");',
        'fs.writeFileSync(path.join(process.env.TMPDIR, "scratch.txt"), "permitted scratch");',
        'fs.writeFileSync(process.env.PROVIDER_AUTH, "permitted auth");',
        'fs.mkdirSync(path.dirname(process.env.PROVIDER_SESSION), {recursive:true});',
        'fs.writeFileSync(process.env.PROVIDER_SESSION, "permitted session");',
        'let codeReadable; try {codeReadable = fs.readFileSync(process.env.APP_CODE, "utf8");} catch(e) {codeReadable = e.code;}',
        'const denied = JSON.parse(process.env.ATTACK_TARGETS).map(target => {try {fs.writeFileSync(target, "BYPASS"); return false;} catch(e) {return ["EACCES", "EPERM"].includes(e.code);}});',
        'let rootMetadataDenied; try {fs.chmodSync(process.cwd(), 0o700); rootMetadataDenied = false;} catch(e) {rootMetadataDenied = ["EACCES", "EPERM"].includes(e.code);}',
        'const providerFilesDenied = [process.env.RUNTIME_BINARY, process.env.PROVIDER_CONFIG].map(target => {try {fs.writeFileSync(target, "PROVIDER-BYPASS"); return false;} catch(e) {return ["EACCES", "EPERM"].includes(e.code);}});',
        'const providerStructureDenied = [process.env.RUNTIME_INSTALLATION, process.env.RUNTIME_PACKAGES, process.env.RUNTIME_ALIAS].map(target => {try {fs.renameSync(target, target+".moved"); return false;} catch(e) {return ["EACCES", "EPERM"].includes(e.code);}});',
        'console.log(JSON.stringify({denied,rootMetadataDenied,codeReadable,providerFilesDenied,providerStructureDenied}));',
      ].join('\n');
      const launch = confinement.wrap(process.execPath, ['-e', attack], {
        ...env,
        APP_CODE: appCode,
        ATTACK_TARGETS: JSON.stringify(targets),
        RUNTIME_BINARY: runtimeBinary,
        RUNTIME_INSTALLATION: installation,
        RUNTIME_PACKAGES: packagesDirectory,
        RUNTIME_ALIAS: runtimeAlias,
        PROVIDER_CONFIG: providerConfig,
        PROVIDER_AUTH: providerAuth,
        PROVIDER_SESSION: providerSession,
      });
      const result = await exec(launch.command, launch.args, {
        cwd: confinement.cwd,
        env: launch.env,
        timeout: 10_000,
      });
      const observed = JSON.parse(result.stdout);
      console.log(
        JSON.stringify({ test: 'managed-project-native-process-authority', ...observed })
      );
      expect(observed).toEqual({
        denied: [true, true, true, true, true, true],
        rootMetadataDenied: true,
        codeReadable: 'module.exports = "app code remains readable";',
        providerFilesDenied: [true, true],
        providerStructureDenied: [true, true, true],
      });
      expect(await readFile(join(project, 'results.txt'), 'utf8')).toBe('permitted content');
      expect(await readFile(join(confinement.scratchRoot, 'scratch.txt'), 'utf8')).toBe(
        'permitted scratch'
      );
      expect(await readFile(marker, 'utf8')).toBe(markerContents);
      expect(await readFile(siblingFile, 'utf8')).toBe('retained sibling');
      expect(await readFile(appState, 'utf8')).toBe('retained app authority');
      expect(await readFile(runtimeBinary, 'utf8')).toBe('#!/bin/sh\nprintf safe-provider\\n\n');
      expect(await readFile(providerConfig, 'utf8')).toBe('model = "safe-provider"\n');
      expect(await readFile(providerAuth, 'utf8')).toBe('permitted auth');
      expect(await readFile(providerSession, 'utf8')).toBe('permitted session');
      expect(state.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 2,
      });
    } finally {
      confinement.dispose();
    }
  }
);

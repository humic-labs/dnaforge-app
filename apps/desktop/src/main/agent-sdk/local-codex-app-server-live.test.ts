import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { buildCliMcpServerLaunch, buildCodexMcpConfig } from './cli-mcp';
import { codexCliEnv } from './subprocess-env';

import { detectCodex, readCodexConfiguredMcpServerNames } from './detect';
import { launchLocalCodexAppServer } from './local-codex-app-server';
import rendererToolManifest from '../../../../../packages/core/agent-tools/renderer-tool-manifest.json';

describe.runIf(process.env.DNAFORGE_LIVE_CODEX_APP_SERVER === '1')(
  'local Codex App Server live handshake',
  () => {
    it.runIf(process.platform !== 'win32')(
      'preserves literal inherited MCP identities through the actual SDK argument projection',
      async () => {
        const detection = await detectCodex();
        if (!detection.path) throw new Error('Installed Codex CLI required');
        const root = mkdtempSync(join(tmpdir(), 'fixture-sdk-mcp-identities-'));
        const home = join(root, 'cli-home');
        mkdirSync(home);
        const flagsPath = join(root, 'sdk-flags.json');
        const sinkPath = join(root, 'codex-argument-recorder');
        const foreignNames = ['personal.server', 'quoted"name'];
        writeFileSync(
          join(home, 'config.toml'),
          foreignNames
            .map(
              (name) =>
                '[mcp_servers.' +
                JSON.stringify(name) +
                ']\ncommand = "/usr/bin/true"\nrequired = true\n'
            )
            .join('\n'),
          { mode: 0o600 }
        );
        writeFileSync(
          sinkPath,
          '#!' +
            process.execPath +
            '\n' +
            'const a=process.argv.slice(2),f=[];for(let i=0;i<a.length;i++){if((a[i]==="-c"||a[i]==="--config")&&typeof a[i+1]==="string"){f.push(a[i],a[++i]);}}require("node:fs").writeFileSync(' +
            JSON.stringify(flagsPath) +
            ',JSON.stringify(f),{flag:"wx",mode:0o600,flush:true});\n',
          { mode: 0o700 }
        );
        const config = buildCodexMcpConfig(
          { serverName: 'dnaforge', command: '/usr/bin/true', args: [], env: {} },
          foreignNames
        );
        const codex = new Codex({
          codexPathOverride: sinkPath,
          env: { ...codexCliEnv(), CODEX_HOME: home },
          config,
        });
        const events: string[] = [];
        try {
          try {
            const stream = await codex
              .startThread({
                workingDirectory: root,
                skipGitRepoCheck: true,
                model: 'gpt-5.6-luna',
              })
              .runStreamed('Argument recorder only; no model request is sent.');
            for await (const event of stream.events) events.push(event.type);
          } catch {}
          expect(events).toEqual([]);
          const flags: string[] = JSON.parse(readFileSync(flagsPath, 'utf8'));
          const rows = JSON.parse(
            execFileSync(detection.path, [...flags, 'mcp', 'list', '--json'], {
              env: { ...codexCliEnv(), CODEX_HOME: home },
              encoding: 'utf8',
              timeout: 10000,
            })
          ) as Array<{ name: string; enabled: boolean }>;
          expect(rows.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
            { name: 'dnaforge', enabled: true },
            ...foreignNames.map((name) => ({ name, enabled: false })),
          ]);
          console.info(
            '[sdk-mcp-literal-identity-proof]',
            JSON.stringify({
              servers: rows.map(({ name, enabled }) => ({ name, enabled })),
              modelTurns: 0,
            })
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      20000
    );

    it('starts the app thread with an unavailable personal required server disabled', async () => {
      const detection = await detectCodex();
      if (!detection.path) throw new Error('Installed Codex CLI required');
      const root = mkdtempSync(join(tmpdir(), 'fixture-native-mcp-isolation-'));
      const serverPath = join(root, 'healthy-app-mcp.cjs');
      writeFileSync(
        serverPath,
        [
          'const rl=require("node:readline").createInterface({input:process.stdin});',
          'rl.on("line",line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};',
          'if(r.method==="initialize")result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"app-startup-proof",version:"1"}};',
          'if(r.method==="tools/list")result={tools:[{name:"proof_readonly",description:"Read-only startup proof",inputSchema:{type:"object",properties:{}}}]};',
          'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n");});',
        ].join('\n'),
        { mode: 0o600 }
      );
      const foreignName = 'unavailable-personal-server';
      const config = buildCodexMcpConfig(
        { serverName: 'dnaforge', command: process.execPath, args: [serverPath], env: {} },
        [...(await readCodexConfiguredMcpServerNames(detection.path)), foreignName]
      );
      const foreignPolicy = Object.entries(config.mcp_servers).find(
        ([name]) => name === foreignName
      )?.[1];
      expect(foreignPolicy).toEqual({ enabled: false });
      const observed: Array<{ isolated: boolean; ready: boolean }> = [];
      try {
        for (const isolated of [false, true]) {
          const server = await launchLocalCodexAppServer({
            binaryPath: detection.path,
            rootDir: join(root, isolated ? 'isolated' : 'control'),
            requestTimeoutMs: 10000,
          });
          try {
            const started = server.supervisor.request('thread/start', {
              cwd: root,
              approvalPolicy: 'never',
              sandbox: 'read-only',
              ephemeral: true,
              model: 'gpt-5.6-luna',
              config: {
                ...config,
                mcp_servers: {
                  ...config.mcp_servers,
                  [foreignName]: {
                    command: process.execPath,
                    args: ['-e', 'process.exit(0)'],
                    required: true,
                    ...foreignPolicy,
                    ...(!isolated ? { enabled: true } : {}),
                  },
                },
              },
            });
            if (isolated) {
              await expect(started).resolves.toMatchObject({ thread: { id: expect.any(String) } });
              observed.push({ isolated, ready: true });
            } else {
              await expect(started).rejects.toThrow(/unavailable-personal-server/);
              observed.push({ isolated, ready: false });
            }
          } finally {
            await server.dispose();
          }
        }
        console.info(
          '[native-mcp-session-isolation-proof]',
          JSON.stringify({ observed, methods: ['thread/start'], modelTurns: 0 })
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 25000);

    it('starts the detected CLI with its CLI-owned credential home', async () => {
      const detection = await detectCodex();
      expect(detection.path).toBeTruthy();
      expect(detection.auth).toBe('authenticated');

      const appServer = await launchLocalCodexAppServer({
        binaryPath: detection.path!,
        rootDir: tmpdir(),
        requestTimeoutMs: 10_000,
      });
      try {
        expect(appServer.supervisor.isTerminated).toBe(false);
      } finally {
        await appServer.dispose();
      }
    });

    it('attaches the configured DNAForge companion to the native thread without a model turn', async () => {
      const detection = await detectCodex();
      expect(detection.path).toBeTruthy();
      const root = mkdtempSync(join(tmpdir(), 'dnaforge-native-mcp-control-'));
      const script = join(root, 'companion.cjs');
      const tools = [
        {
          name: 'dnaforge_companion_ownership_control',
          description: 'Declared transport control. No biological operation.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        ...rendererToolManifest.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      ];
      writeFileSync(
        script,
        `const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: 'DNAForge companion ownership control', version: '1' }
  };
  else if (request.method === 'tools/list') result = { tools: ${JSON.stringify(tools)} };
  else if (request.method === 'resources/list') result = { resources: [] };
  else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported control request' } }) + '\\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`
      );
      const appServer = await launchLocalCodexAppServer({
        binaryPath: detection.path!,
        rootDir: root,
        requestTimeoutMs: 10_000,
      });
      let inventory: unknown;
      try {
        expect(appServer.protocol.client).toContain('mcpServerStatus/list');
        const started = (await appServer.supervisor.request('thread/start', {
          cwd: root,
          ephemeral: true,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          config: buildCodexMcpConfig(
            {
              serverName: 'dnaforge',
              command: process.execPath,
              args: [script],
              env: {},
            },
            await readCodexConfiguredMcpServerNames(detection.path!)
          ),
        })) as { thread: { id: string } };
        await expect
          .poll(
            async () => {
              const page = (await appServer.supervisor.request('mcpServerStatus/list', {
                threadId: started.thread.id,
                detail: 'toolsAndAuthOnly',
                limit: 100,
              })) as {
                data: Array<{
                  name: string;
                  tools: Record<string, { name: string; inputSchema: unknown }>;
                }>;
              };
              inventory = page.data.map((server) => ({
                name: server.name,
                toolCount: Object.keys(server.tools).length,
                controlPresent: 'dnaforge_companion_ownership_control' in server.tools,
                ...(server.name === 'dnaforge'
                  ? { sceneSchema: server.tools.mol_apply_scene?.inputSchema }
                  : {}),
              }));
              const server = page.data.find((item) => item.name === 'dnaforge');
              if (!server?.tools.dnaforge_companion_ownership_control) return undefined;
              expect(
                page.data
                  .filter((item) => item.name !== 'dnaforge')
                  .flatMap((item) => Object.keys(item.tools))
              ).toEqual([]);
              expect(Object.keys(server.tools)).toHaveLength(tools.length);
              expect(server.tools.mol_apply_scene.inputSchema).toMatchObject({
                properties: { root: { type: 'object' }, scene: { type: 'string' } },
              });
              return server.tools.dnaforge_companion_ownership_control.name;
            },
            { timeout: 15_000, interval: 100 }
          )
          .toBe('dnaforge_companion_ownership_control');
      } finally {
        if (process.env.DNAFORGE_MCP_CONTROL_EVIDENCE)
          writeFileSync(
            process.env.DNAFORGE_MCP_CONTROL_EVIDENCE,
            JSON.stringify(
              {
                control: 'native CLI attachment; zero model turns',
                inventory,
              },
              null,
              2
            )
          );
        await appServer.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
);

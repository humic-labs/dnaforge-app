const path = require('node:path');

async function main() {
  const { resolveConfig } = await import('electron-vite');
  const { createServer } = await import('vite');
  const resolved = await resolveConfig(
    { configFile: path.resolve(__dirname, '../electron.vite.config.ts') },
    'serve'
  );
  const renderer = resolved.config?.renderer;
  if (!renderer) throw new Error('Development renderer configuration is unavailable');
  const build = JSON.parse(renderer.define?.__DNAFORGE_APP_BUILD__ ?? 'null');
  const sourceFingerprint = JSON.parse(
    renderer.define?.__WAYPOINT_BUILD_SOURCE_FINGERPRINT__ ?? 'null'
  );
  if (!/^[a-f0-9]{40}$/.test(build?.sourceCommit) || !/^[a-f0-9]{64}$/.test(sourceFingerprint))
    throw new Error('Development renderer source identity is incomplete');
  const server = await createServer({
    ...renderer,
    configFile: false,
    server: {
      ...renderer.server,
      host: '127.0.0.1',
      port: Number(process.env.DESKTOP_DEV_PORT),
      strictPort: true,
    },
  });
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await server.listen();
  process.send?.({
    kind: 'renderer-listening',
    pid: process.pid,
    sourceCommit: build.sourceCommit,
    sourceFingerprint,
  });
}

main().catch((error) => {
  process.send?.({ kind: 'renderer-failed', reason: error.message });
  console.error(error);
  process.exit(1);
});

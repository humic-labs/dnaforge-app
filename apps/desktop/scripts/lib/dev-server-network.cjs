function devServerNetwork(devPort, hmrPort) {
  return {
    host: '127.0.0.1',
    port: devPort ? parseInt(devPort, 10) : undefined,
    hmr: { host: '127.0.0.1', port: hmrPort ? parseInt(hmrPort, 10) : undefined },
  };
}

module.exports = { devServerNetwork };

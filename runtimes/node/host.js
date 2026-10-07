'use strict';
// GoMP Node.js script host: runs RAGE.MP server packages against the GoMP core.
// Started by the core (gomp-server) with GOMP_IPC_* environment variables.

const path = require('path');
const { IpcLink } = require('./lib/ipc');
const { Runtime } = require('./lib/runtime');

function main() {
  const endpoint = {
    network: process.env.GOMP_IPC_NETWORK,
    addr: process.env.GOMP_IPC_ADDR,
    token: process.env.GOMP_IPC_TOKEN,
    name: `node-${process.version}`,
  };
  if (!endpoint.network || !endpoint.addr || !endpoint.token) {
    console.error('host.js must be started by gomp-server (GOMP_IPC_* variables are missing)');
    process.exit(2);
  }
  const packagesDir = process.env.GOMP_PACKAGES || path.resolve('packages');
  const link = new IpcLink(endpoint);
  const rt = new Runtime(link, { packagesDir });
  link.encodeHooks = rt.encodeHooks;
  link.decodeHooks = rt.decodeHooks;
  link.onOps = (ops) => {
    for (const op of ops) {
      try {
        rt.handle(op);
      } catch (err) {
        console.error(`[gomp] error while handling '${op[0]}':`, err && err.stack ? err.stack : err);
      }
    }
  };
  link.onClose = (err) => {
    if (err) console.error('[gomp] connection to the core lost:', err.message);
    process.exit(err ? 1 : 0);
  };

  // RAGE.MP keeps running when a package throws; so do we.
  process.on('uncaughtException', (err) => console.error('[packages] uncaught exception:', err && err.stack ? err.stack : err));
  process.on('unhandledRejection', (err) => console.error('[packages] unhandled rejection:', err && err.stack ? err.stack : err));

  link.connect().catch((err) => {
    console.error('[gomp] cannot connect to the core:', err.message);
    process.exit(1);
  });
}

main();

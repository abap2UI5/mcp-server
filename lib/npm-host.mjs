#!/usr/bin/env node
/*
 * npm-host — the backend child of the npm backend (lib/npm-backend.mjs):
 * what node/srv/express.mjs is for a framework checkout, for a machine that
 * has none.
 *
 *   node lib/npm-host.mjs <runtime dir>        PORT from the environment
 *
 * It resolves @abap2ui5/node-runtime from the RUNTIME DIRECTORY, not from
 * this server's own node_modules (the package is installed per release in the
 * workspace), boots it, registers the transpiled dev apps and serves on
 * loopback. The boot is apps/init.mjs, which the build generates and the
 * unit-test runner imports too - initialize(), accelerate() when the release
 * exports it, then the dev modules in the transpiler's order - so the app a
 * test ran against and the app run_app looks at booted the same way. Before
 * a first build there is no apps/, and the host boots the framework alone.
 *
 * `compress`: a release that exports one gets it in front of the handler -
 * as an express middleware (three parameters) or a factory returning one;
 * anything else is reported and the plain serve() is used. A release without
 * it serves uncompressed, exactly as before.
 *
 * It prints one banner line naming the release and what it found, then the
 * "Listening on <port>" the server's startBackend waits for; anything that
 * fails before that goes to stderr with exit code 1, which startBackend
 * reports as the reason the backend did not start.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';

const PKG = '@abap2ui5/node-runtime';

/** Boot the release in `dir`, register its dev apps, listen. Resolves with
 *  `{ server, banner }`. */
export async function startHost({ dir, port, host = '127.0.0.1' }) {
  const req = createRequire(path.join(dir, 'package.json'));
  const entry = req.resolve(PKG);
  const meta = JSON.parse(fs.readFileSync(req.resolve(`${PKG}/package.json`), 'utf8'));
  const runtime = await import(pathToFileURL(entry).href);

  const init = path.join(dir, 'apps', 'init.mjs');
  let boot;
  if (fs.existsSync(init)) {
    boot = await import(pathToFileURL(init).href);
  } else {
    await runtime.initialize();
    const accelerated = typeof runtime.accelerate === 'function';
    if (accelerated) await runtime.accelerate();
    boot = { accelerated, devModules: [] };
  }

  let server = null;
  let compression = 'not offered by this release';
  if (typeof runtime.compress === 'function') {
    try {
      const middleware = runtime.compress.length >= 3 ? runtime.compress : await runtime.compress();
      if (typeof middleware === 'function' && typeof runtime.createApp === 'function') {
        const { default: express } = await import(pathToFileURL(req.resolve('express')).href);
        const app = express();
        app.disable('x-powered-by');
        app.use(middleware);
        app.use(await runtime.createApp());
        server = await new Promise((resolve, reject) => {
          const s = app.listen(port, host, () => resolve(s));
          s.on('error', reject);
        });
        compression = 'on (the release\'s compress export)';
      } else {
        compression = 'the release exports compress, but it gave no middleware - serving uncompressed';
      }
    } catch (e) {
      if (server) throw e;
      compression = `the release's compress failed (${String((e && e.message) || e).split('\n')[0]}) - serving uncompressed`;
    }
  }
  if (!server) server = await runtime.serve({ port, host });
  const modules = Array.isArray(boot.devModules) ? boot.devModules : [];
  const banner = `abap2ui5 npm host: ${PKG} ${meta.version} from ${dir}; `
    + `${modules.length} dev module(s)${modules.length ? ` (${modules.join(', ')})` : ''}; `
    + `accelerate: ${boot.accelerated ? 'on' : 'not exported by this release'}; compression: ${compression}`;
  return { server, banner };
}

/* Run as a program - the way startBackend spawns it - and not when a test
 * imports startHost. Compared by real path, like scripts/ci-unit.mjs. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const dir = process.argv[2];
  const port = Number(process.env.PORT || 3000);
  if (!dir) {
    console.error('usage: node lib/npm-host.mjs <runtime dir>   (PORT from the environment)');
    process.exit(2);
  }
  startHost({ dir: path.resolve(dir), port }).then(({ banner }) => {
    console.log(banner);
    console.log(`Listening on ${port}`);
  }, (e) => {
    console.error(`abap2ui5 npm host: ${(e && e.stack) || e}`);
    process.exit(1);
  });
}

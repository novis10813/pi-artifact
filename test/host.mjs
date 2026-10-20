import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scope = '@earendil-works';
const install = join(homedir(), '.pi/agent/install');
const candidates = [process.env.PI_PACKAGE_ROOT];
try { candidates.push(require.resolve(`${scope}/pi-coding-agent/package.json`).replace(/\/package.json$/, '')); } catch {}
try { candidates.push(join(install, 'releases', readFileSync(join(install, 'current-version'), 'utf8').trim(), 'node_modules', scope, 'pi-coding-agent')); } catch {}
candidates.push(resolve(dirname(process.execPath), '..', 'lib/node_modules', scope, 'pi-coding-agent'));
export const host = candidates.find(p => p && existsSync(join(p, 'dist/index.js')));
if (!host) throw new Error('Install pi or set PI_PACKAGE_ROOT to its pi-coding-agent package directory.');
export const hostRequire = createRequire(join(host, 'package.json'));
const jitiPath = hostRequire.resolve('jiti');
const { createJiti } = await import(pathToFileURL(realpathSync(jitiPath)).href);
export const tuiPath = hostRequire.resolve(`${scope}/pi-tui`);
export const tui = await import(pathToFileURL(tuiPath).href);
export const agent = await import(pathToFileURL(join(host, 'dist/index.js')).href);
export const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: {
  typebox: hostRequire.resolve("typebox"),
  [`${scope}/pi-tui`]: tuiPath,
  [`${scope}/pi-coding-agent`]: join(host, 'dist/index.js'),
} });
export const load = name => jiti.import(new URL(`../src/${name}.ts`, import.meta.url).pathname);

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

const valid = (name: string) => JSON.stringify({
  projects: [{ id: name }],
  settings: {},
  customNodes: [],
});

async function exercisePreload(relativePath: string, hostName: 'utools' | 'ztools'): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), `project-manager-${hostName}-`));
  const openedUrls: string[] = [];
  const openedDirectories: string[] = [];
  const host = {
    getPath: (name: string) => {
      assert.equal(name, 'userData');
      return userData;
    },
    shellOpenExternal: (url: string) => { openedUrls.push(url); },
    shellOpenPath: async (directory: string) => { openedDirectories.push(directory); },
  };
  const context: Record<string, unknown> = {
    require,
    process,
    Buffer,
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: {},
  };
  context[hostName] = host;

  try {
    vm.runInNewContext(readFileSync(join(process.cwd(), relativePath), 'utf8'), context, {
      filename: relativePath,
    });
    const services = (context.window as { services?: Record<string, (...args: any[]) => any> }).services;
    assert(services);

    await services.writeConfigFile('data.json', valid('A'));
    await services.writeConfigFile('data.json', valid('B'));
    assert.equal(readFileSync(join(userData, 'data.json.bak'), 'utf8'), valid('A'));
    await services.writeConfigFile('data.json', valid('C'));
    assert.equal(readFileSync(join(userData, 'data.json'), 'utf8'), valid('C'));
    assert.equal(readFileSync(join(userData, 'data.json.bak'), 'utf8'), valid('B'));

    assert.equal(await services.hasConfigBackup('data.json'), true);
    assert.equal(await services.readConfigBackup('data.json'), valid('B'));
    await services.restoreConfigBackup('data.json');
    assert.equal(readFileSync(join(userData, 'data.json'), 'utf8'), valid('B'));
    assert(readdirSync(userData).some(name => /^data\.json\.corrupt-/.test(name)));

    const restoredBackup = readFileSync(join(userData, 'data.json.bak'), 'utf8');
    await assert.rejects(services.writeConfigFile('data.json', '{invalid'), /Invalid JSON|not valid JSON/);
    assert.equal(readFileSync(join(userData, 'data.json'), 'utf8'), valid('B'));
    assert.equal(readFileSync(join(userData, 'data.json.bak'), 'utf8'), restoredBackup);

    writeFileSync(join(userData, 'data.json'), '{corrupt');
    await assert.rejects(services.writeConfigFile('data.json', valid('D')), /Invalid JSON|not valid JSON/);
    assert.equal(readFileSync(join(userData, 'data.json'), 'utf8'), '{corrupt');
    assert.equal(readFileSync(join(userData, 'data.json.bak'), 'utf8'), restoredBackup);
    await services.restoreConfigBackup('data.json');
    assert.equal(readFileSync(join(userData, 'data.json'), 'utf8'), restoredBackup);

    await services.writeConfigFile('run-history.json', '{"schemaVersion":1,"entries":[]}');
    await services.writeConfigFile('run-history.json', '{"schemaVersion":1,"entries":[1]}');
    assert.equal(readdirSync(userData).some(name => name === 'run-history.json.bak'), false);

    await assert.rejects(services.writeConfigFile('../data.json', valid('bad')), /Invalid config filename/);
    await assert.rejects(services.readConfigBackup('C:\\data.json'), /Invalid config filename/);
    await assert.rejects(services.restoreConfigBackup('/tmp/data.json'), /Invalid config filename/);
    await assert.rejects(services.writeConfigFile('data.json:stream', valid('bad')), /Invalid config filename/);

    await services.openUrl('https://example.com/path');
    assert.deepEqual(openedUrls, ['https://example.com/path']);
    await assert.rejects(services.openUrl('javascript:alert(1)'), /Only http and https/);
    await services.openConfigDirectory();
    assert.deepEqual(openedDirectories, [userData]);
    assert.equal(await services.canOpenConfigDirectory(), true);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

await exercisePreload('utools/preload.js', 'utools');
await exercisePreload('ztools/preload.js', 'ztools');
assert.equal(
  readFileSync('utools/preload.js', 'utf8'),
  readFileSync('ztools/preload.js', 'utf8'),
  'uTools and ZTools persistence contracts must remain identical',
);
console.log('pluginPersistence tests passed');

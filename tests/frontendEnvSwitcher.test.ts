/**
 * 前端环境/代理快速切换工具测试
 */

import assert from 'node:assert/strict';
import {
  scanEnvFile,
  scanFrontendEnvProject,
  scanViteProxyFile,
  switchFrontendEnvCandidate,
} from '../src/utils/frontendEnvSwitcher';

/***********************环境变量候选扫描*********************/

{
  const content = [
    'VITE_API=http://dev.example.com',
    '# VITE_API=http://test.example.com',
    'API_SECRET=hidden',
    '# VITE_SINGLE=http://only.example.com',
    'BROKEN_LINE',
  ].join('\n');

  const groups = scanEnvFile('/project/.env', content);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'env');
  assert.equal(groups[0].key, 'VITE_API');
  assert.equal(groups[0].fileName, '.env');
  assert.deepEqual(groups[0].candidates.map(item => item.value), [
    'http://dev.example.com',
    'http://test.example.com',
  ]);
  assert.deepEqual(groups[0].candidates.map(item => item.active), [true, false]);
}

/***********************环境变量候选切换*********************/

{
  const content = [
    'VITE_API=http://dev.example.com',
    '# VITE_API=http://test.example.com',
  ].join('\n');

  const switched = switchFrontendEnvCandidate(content, {
    type: 'env',
    key: 'VITE_API',
    value: 'http://test.example.com',
  });

  assert.equal(switched, [
    '# VITE_API=http://dev.example.com',
    'VITE_API=http://test.example.com',
  ].join('\n'));
}

/***********************Vite代理候选扫描*********************/

{
  const content = `
export default defineConfig({
  build: {
    target: 'es2015',
    // target: 'esnext',
  },
});
`.trim();

  const groups = scanViteProxyFile('/project/vite.config.ts', content);

  assert.equal(groups.length, 0);
}

{
  const content = `
const baseApi = '/api';

export default defineConfig({
  server: {
    proxy: {
      [baseApi]: {
        target: 'http://172.16.104.168:8057/',
        // target: 'http://172.16.103.209:8057/',
        // target: 'http://172.16.103.232:8057/',
        changeOrigin: true,
      },
      '/file-api': {
        target: 'http://172.16.104.168:8060/',
        changeOrigin: true,
      },
    },
  },
});
`.trim();

  const groups = scanViteProxyFile('/project/vite.config.ts', content);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].type, 'proxy');
  assert.equal(groups[0].key, 'baseApi');
  assert.equal(groups[0].fileName, 'vite.config.ts');
  assert.deepEqual(groups[0].candidates.map(item => item.value), [
    'http://172.16.104.168:8057/',
    'http://172.16.103.209:8057/',
    'http://172.16.103.232:8057/',
  ]);
  assert.deepEqual(groups[0].candidates.map(item => item.active), [true, false, false]);
  assert.equal(groups[1].key, 'file-api');
  assert.deepEqual(groups[1].candidates.map(item => item.value), [
    'http://172.16.104.168:8060/',
  ]);
  assert.deepEqual(groups[1].candidates.map(item => item.active), [true]);
}

{
  const content = `
export default defineConfig({
  server: {
    proxy: {
        [baseApi]: {
          target: 'http://172.16.104.168:8057/',
          // target: 'http://172.16.103.209:8057/',
          // target: 'http://172.16.103.232:8057/',
          changeOrigin: true,
          rewrite: (currentPath: string) => currentPath.replace(new RegExp(\`^\${baseApi}\`), ''),
        },
        /** *********************外部业务服务代理 */
        '/api21216': {
          target: 'http://172.16.104.108:21216',
          changeOrigin: true,
          rewrite: (currentPath: string) => currentPath.replace(/^\\/api21216/, ''),
        },
    },
  },
});
`.trim();

  const groups = scanViteProxyFile('/project/vite.config.ts', content);

  assert.deepEqual(groups.map(item => item.key), ['baseApi', 'api21216']);
  assert.deepEqual(groups[1].candidates.map(item => item.value), [
    'http://172.16.104.108:21216',
  ]);
}

/***********************Vite代理候选切换*********************/

{
  const content = [
    'export default defineConfig({',
    '  server: {',
    '    proxy: {',
    "      [baseApi]: {",
    "        target: 'http://172.16.104.168:8057/',",
    "        // target: 'http://172.16.103.209:8057/',",
    "        // target: 'http://172.16.103.232:8057/',",
    "        changeOrigin: true,",
    "      },",
    '    },',
    '  },',
    '});',
  ].join('\n');

  const switched = switchFrontendEnvCandidate(content, {
    type: 'proxy',
    key: 'baseApi',
    value: 'http://172.16.103.232:8057/',
  });

  assert.equal(switched, [
    'export default defineConfig({',
    '  server: {',
    '    proxy: {',
    "      [baseApi]: {",
    "        // target: 'http://172.16.104.168:8057/',",
    "        // target: 'http://172.16.103.209:8057/',",
    "        target: 'http://172.16.103.232:8057/',",
    "        changeOrigin: true,",
    "      },",
    '    },',
    '  },',
    '});',
  ].join('\n'));
}

/***********************项目目录环境扫描*********************/

{
  const groups = await scanFrontendEnvProject('/missing', {
    readDir: async () => {
      throw new Error('Directory does not exist');
    },
    readTextFile: async () => '',
  });

  assert.deepEqual(groups, []);
}

{
  const files = new Map<string, string>([
    ['/project/.env', [
      'VITE_API=http://dev.example.com',
      '# VITE_API=http://test.example.com',
    ].join('\n')],
    ['/project/vite.config.ts', [
      'export default defineConfig({',
      '  server: {',
      '    proxy: {',
      "      [baseApi]: {",
      "        target: 'http://172.16.104.168:8057/',",
      "        // target: 'http://172.16.103.209:8057/',",
      "      },",
      "      '/api21216': {",
      "        target: 'http://172.16.104.108:21216',",
      "      },",
      '    },',
      '  },',
      '});',
    ].join('\n')],
  ]);

  const groups = await scanFrontendEnvProject('/project', {
    readDir: async () => [
      { name: '.env', isDirectory: false },
      { name: 'vite.config.ts', isDirectory: false },
      { name: 'src', isDirectory: true },
    ],
    readTextFile: async (filePath: string) => {
      const content = files.get(filePath);
      assert.ok(content, `missing fake file: ${filePath}`);
      return content;
    },
  });

  assert.deepEqual(groups.map(item => `${item.type}:${item.key}`), [
    'env:VITE_API',
    'proxy:baseApi',
    'proxy:api21216',
  ]);
}

console.log('frontendEnvSwitcher tests passed');

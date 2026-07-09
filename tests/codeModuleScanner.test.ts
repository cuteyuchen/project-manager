/**
 * 代码模块扫描器单元测试
 *
 * 测试纯函数：detectFramework / scanCodeModules / buildDirTree / extractPackageName / detectFrameworkFromPackageJson
 */

import assert from 'node:assert/strict';
import {
  detectFramework,
  scanCodeModules,
  buildDirTree,
  extractPackageName,
  detectFrameworkFromPackageJson,
} from '../src/utils/codeModuleScanner';

// ─── detectFramework 测试 ─────────────────────────────────────────────────────

console.log('=== detectFramework ===');

// Node 项目（仅有 package.json）
assert.equal(detectFramework(['package.json', 'index.js', 'node_modules']), 'node');
console.log('  ✓ 仅有 package.json → node');

// Vue 项目（vue.config.js）
assert.equal(detectFramework(['package.json', 'vue.config.js', 'src']), 'vue');
console.log('  ✓ vue.config.js → vue');

// Vue 项目（vite.config.ts）
assert.equal(detectFramework(['package.json', 'vite.config.ts', 'src']), 'vue');
console.log('  ✓ vite.config.ts + package.json → vue');

// Java 项目（pom.xml）
assert.equal(detectFramework(['pom.xml', 'src', 'README.md']), 'java');
console.log('  ✓ pom.xml → java');

// Java 项目（build.gradle）
assert.equal(detectFramework(['build.gradle', 'src', 'settings.gradle']), 'java');
console.log('  ✓ build.gradle → java');

// Java 项目（build.gradle.kts）
assert.equal(detectFramework(['build.gradle.kts', 'src']), 'java');
console.log('  ✓ build.gradle.kts → java');

// Go 项目
assert.equal(detectFramework(['go.mod', 'go.sum', 'main.go']), 'go');
console.log('  ✓ go.mod → go');

// Python 项目（pyproject.toml）
assert.equal(detectFramework(['pyproject.toml', 'src', 'tests']), 'python');
console.log('  ✓ pyproject.toml → python');

// Python 项目（setup.py）
assert.equal(detectFramework(['setup.py', 'requirements.txt']), 'python');
console.log('  ✓ setup.py → python');

// Python 项目（仅 requirements.txt）
assert.equal(detectFramework(['requirements.txt', 'main.py']), 'python');
console.log('  ✓ 仅 requirements.txt → python');

// .NET 项目（.sln）
assert.equal(detectFramework(['MyApp.sln', 'src']), 'dotnet');
console.log('  ✓ .sln → dotnet');

// .NET 项目（.csproj）
assert.equal(detectFramework(['MyApp.csproj', 'Program.cs']), 'dotnet');
console.log('  ✓ .csproj → dotnet');

// 空目录 / 无法识别
assert.equal(detectFramework(['README.md', 'LICENSE']), 'unknown');
console.log('  ✓ 无标记文件 → unknown');

assert.equal(detectFramework([]), 'unknown');
console.log('  ✓ 空列表 → unknown');

// ─── scanCodeModules 测试 ─────────────────────────────────────────────────────

console.log('\n=== scanCodeModules ===');

// 空输入
assert.deepEqual(scanCodeModules({}), []);
console.log('  ✓ 空输入 → 空结果');

// 根目录自身应被跳过
assert.deepEqual(scanCodeModules({ '.': ['package.json', 'src'] }), []);
console.log('  ✓ 根目录跳过');

// 单层模块识别
const result1 = scanCodeModules({
  '.': ['package.json', 'src'],
  'packages/app': ['package.json', 'vue.config.js', 'src'],
  'packages/api': ['go.mod', 'main.go'],
  'packages/docs': ['README.md'],  // unknown → 跳过
});
assert.equal(result1.length, 2);
assert.equal(result1[0].name, 'app');
assert.equal(result1[0].framework, 'vue');
assert.equal(result1[0].relativePath, 'packages/app');
assert.equal(result1[1].name, 'api');
assert.equal(result1[1].framework, 'go');
assert.equal(result1[1].relativePath, 'packages/api');
console.log('  ✓ 单层 monorepo → 识别 app(vue) + api(go)，跳过 docs');

// 深度限制
const result2 = scanCodeModules({
  'a/b/c/d': ['pom.xml'],  // depth=4 > maxDepth=3
  'a/b/c': ['go.mod'],      // depth=3 = maxDepth
}, 3);
assert.equal(result2.length, 1);
assert.equal(result2[0].framework, 'go');
console.log('  ✓ 深度限制（maxDepth=3）正确过滤');

// 自定义 maxDepth
const result3 = scanCodeModules({
  'a/b/c/d': ['pom.xml'],
}, 5);
assert.equal(result3.length, 1);
console.log('  ✓ 自定义 maxDepth=5 允许更深路径');

// ─── buildDirTree 测试 ────────────────────────────────────────────────────────

console.log('\n=== buildDirTree ===');

const tree = buildDirTree([
  { name: 'package.json', isDirectory: false },
  { name: 'src', isDirectory: true },
  { name: 'README.md', isDirectory: false },
]);
assert.deepEqual(tree['.'], ['package.json', 'README.md']);
assert.deepEqual(tree['src'], []);
console.log('  ✓ 正确区分文件和目录');

// ─── extractPackageName 测试 ──────────────────────────────────────────────────

console.log('\n=== extractPackageName ===');

assert.equal(extractPackageName('{"name": "@scope/my-app"}'), 'my-app');
console.log('  ✓ 去掉 scope 前缀');

assert.equal(extractPackageName('{"name": "simple-name"}'), 'simple-name');
console.log('  ✓ 普通包名');

assert.equal(extractPackageName('{"version": "1.0.0"}'), null);
console.log('  ✓ 无 name 字段 → null');

assert.equal(extractPackageName('invalid json'), null);
console.log('  ✓ 无效 JSON → null');

// ─── detectFrameworkFromPackageJson 测试 ──────────────────────────────────────

console.log('\n=== detectFrameworkFromPackageJson ===');

assert.equal(
  detectFrameworkFromPackageJson('{"dependencies": {"vue": "^3.0.0"}}'),
  'vue',
);
console.log('  ✓ vue 依赖 → vue');

assert.equal(
  detectFrameworkFromPackageJson('{"dependencies": {"react": "^18.0.0", "react-dom": "^18.0.0"}}'),
  'react',
);
console.log('  ✓ react 依赖 → react');

assert.equal(
  detectFrameworkFromPackageJson('{"dependencies": {"express": "^4.0.0"}}'),
  'node',
);
console.log('  ✓ express 依赖 → node');

assert.equal(
  detectFrameworkFromPackageJson('{}'),
  'unknown',
);
console.log('  ✓ 空 package.json → unknown');

// ─── 全部通过 ─────────────────────────────────────────────────────────────────

console.log('\n✅ codeModuleScanner 所有测试通过');

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const ztoolsPublishRepoDir = path.join(rootDir, '.ztools-publish-repo');

function run(cmd, opts = {}) {
    console.log(`  > ${cmd}`);
    execSync(cmd, { stdio: 'inherit', cwd: rootDir, ...opts });
}

function ensureCleanDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dst) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dst, entry));
        }
        return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
}

function writeJson(filePath, value, indent = 2) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, indent) + '\n');
}

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) console.log('\n🧪 DRY RUN MODE — will not actually publish\n');

const version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;

console.log(`\n🔨 Building ZTools plugin (v${version})...\n`);
run('npm run build:ztools');
console.log('✅ ZTools plugin built -> dist-ztools/');

console.log(`\n🚀 Publishing ZTools plugin (v${version})...\n`);

try {
    ensureCleanDir(ztoolsPublishRepoDir);

    copyRecursive(path.join(rootDir, 'src'), path.join(ztoolsPublishRepoDir, 'src'));
    copyRecursive(path.join(rootDir, 'public'), path.join(ztoolsPublishRepoDir, 'public'));
    copyRecursive(path.join(rootDir, 'ztools'), path.join(ztoolsPublishRepoDir, 'ztools'));

    // build-plugin.sh must be at the repo ROOT so the ZTools-plugins CI finds it
    copyRecursive(path.join(rootDir, 'ztools', 'build-plugin.sh'), path.join(ztoolsPublishRepoDir, 'build-plugin.sh'));
    // Also copy scripts/post-build-ztools.cjs in case it's referenced by package.json build script
    fs.mkdirSync(path.join(ztoolsPublishRepoDir, 'scripts'), { recursive: true });
    copyRecursive(path.join(rootDir, 'scripts', 'post-build-ztools.cjs'), path.join(ztoolsPublishRepoDir, 'scripts', 'post-build-ztools.cjs'));

    for (const file of ['index.html', 'vite.config.ts', 'uno.config.ts', 'tsconfig.json', 'tsconfig.node.json']) {
        copyRecursive(path.join(rootDir, file), path.join(ztoolsPublishRepoDir, file));
    }

    const publishPackageJson = {
        ...JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')),
        private: true,
    };
    writeJson(path.join(ztoolsPublishRepoDir, 'package.json'), publishPackageJson, 2);

    const publishPluginJsonPath = path.join(ztoolsPublishRepoDir, 'ztools', 'plugin.json');
    const publishPluginJson = JSON.parse(fs.readFileSync(publishPluginJsonPath, 'utf8'));
    publishPluginJson.version = version;
    writeJson(publishPluginJsonPath, publishPluginJson, 4);

    fs.writeFileSync(
        path.join(ztoolsPublishRepoDir, '.release-source.txt'),
        `source-only publish workspace for ztools v${version}\n`,
        'utf8'
    );

    run('git init', { cwd: ztoolsPublishRepoDir });
    run('git add .', { cwd: ztoolsPublishRepoDir });
    run(`git commit -m "chore(release): ztools source v${version}"`, { cwd: ztoolsPublishRepoDir });

    if (isDryRun) {
        console.log('\n🧪 Dry run: skipping publish step.');
        console.log(`   Would run: npx @ztools-center/plugin-cli@latest publish`);
        console.log(`   In:        ${path.join(ztoolsPublishRepoDir, 'ztools')}`);
        console.log(`\n✅ Dry run complete — publish workspace ready at .ztools-publish-repo/\n`);
    } else {
        run('npx @ztools-center/plugin-cli@latest publish', { cwd: path.join(ztoolsPublishRepoDir, 'ztools') });
        console.log(`\n✅ ZTools plugin v${version} published successfully\n`);
    }
} catch (e) {
    console.error('❌ ZTools publish failed:', e.message);
    console.log('💡 You can retry manually:');
    console.log(`   cd .ztools-publish-repo\\ztools && npx @ztools-center/plugin-cli@latest publish`);
    process.exit(1);
}

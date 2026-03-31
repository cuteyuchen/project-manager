const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const newVersion = process.argv[2];

if (!newVersion) {
    console.error('❌ Please provide a version number.\nUsage: npm run bump <version>');
    process.exit(1);
}

// Validate version format (x.y.z)
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error('❌ Invalid version format. Please use x.y.z (e.g., 1.0.0)');
    process.exit(1);
}

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

try {
    // ═══════════════════════════════════════════
    // Phase 1: Update version numbers
    // ═══════════════════════════════════════════
    console.log('\n📝 Phase 1: Updating version numbers...\n');

    // 1. package.json
    const packageJsonPath = path.join(rootDir, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const oldVersion = packageJson.version;
    packageJson.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log(`✅ package.json: ${oldVersion} -> ${newVersion}`);

    // 2. src-tauri/tauri.conf.json
    const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    tauriConf.version = newVersion;
    fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
    console.log(`✅ src-tauri/tauri.conf.json -> ${newVersion}`);

    // 3. src-tauri/Cargo.toml
    const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
    let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    const cargoRegex = /^version = ".*"$/m;
    if (cargoRegex.test(cargoToml)) {
        cargoToml = cargoToml.replace(cargoRegex, `version = "${newVersion}"`);
        fs.writeFileSync(cargoTomlPath, cargoToml);
        console.log(`✅ src-tauri/Cargo.toml -> ${newVersion}`);
        try {
            console.log('🔄 Updating Cargo.lock...');
            run('cargo check', { cwd: path.join(rootDir, 'src-tauri') });
            console.log('✅ Cargo.lock updated');
        } catch (e) {
            console.warn('⚠️ Failed to update Cargo.lock automatically.');
        }
    } else {
        console.warn('⚠️ Could not find version field in Cargo.toml');
    }

    // 4. utools/plugin.json
    const utoolsPluginPath = path.join(rootDir, 'utools', 'plugin.json');
    if (fs.existsSync(utoolsPluginPath)) {
        const utoolsPlugin = JSON.parse(fs.readFileSync(utoolsPluginPath, 'utf8'));
        utoolsPlugin.version = newVersion;
        fs.writeFileSync(utoolsPluginPath, JSON.stringify(utoolsPlugin, null, 4) + '\n');
        console.log(`✅ utools/plugin.json -> ${newVersion}`);
    }

    // 5. utools/preload.js
    const versionRegex = /(getAppVersion:\s*async\s*\(\)\s*=>\s*\{\s*return\s*")([^"]+)(")/;
    const preloadPath = path.join(rootDir, 'utools', 'preload.js');
    if (fs.existsSync(preloadPath)) {
        let content = fs.readFileSync(preloadPath, 'utf8');
        if (versionRegex.test(content)) {
            content = content.replace(versionRegex, `$1${newVersion}$3`);
            fs.writeFileSync(preloadPath, content);
            console.log(`✅ utools/preload.js -> ${newVersion}`);
        } else {
            console.warn('⚠️ Could not find getAppVersion in utools/preload.js');
        }
    }

    // 6. ztools/plugin.json
    const ztoolsPluginPath = path.join(rootDir, 'ztools', 'plugin.json');
    if (fs.existsSync(ztoolsPluginPath)) {
        const ztoolsPlugin = JSON.parse(fs.readFileSync(ztoolsPluginPath, 'utf8'));
        ztoolsPlugin.version = newVersion;
        fs.writeFileSync(ztoolsPluginPath, JSON.stringify(ztoolsPlugin, null, 4) + '\n');
        console.log(`✅ ztools/plugin.json -> ${newVersion}`);
    }

    // 7. ztools/preload.js
    const ztoolsPreloadPath = path.join(rootDir, 'ztools', 'preload.js');
    if (fs.existsSync(ztoolsPreloadPath)) {
        let content = fs.readFileSync(ztoolsPreloadPath, 'utf8');
        if (versionRegex.test(content)) {
            content = content.replace(versionRegex, `$1${newVersion}$3`);
            fs.writeFileSync(ztoolsPreloadPath, content);
            console.log(`✅ ztools/preload.js -> ${newVersion}`);
        } else {
            console.warn('⚠️ Could not find getAppVersion in ztools/preload.js');
        }
    }

    // ═══════════════════════════════════════════
    // Phase 2: Git commit, tag & push
    // ═══════════════════════════════════════════
    console.log('\n📦 Phase 2: Git commit, tag & push...\n');

    const releaseTrackedFiles = [
        'package.json',
        'src-tauri/tauri.conf.json',
        'src-tauri/Cargo.toml',
        'src-tauri/Cargo.lock',
        'utools/plugin.json',
        'utools/preload.js',
        'ztools/plugin.json',
        'ztools/preload.js',
    ].filter((file) => fs.existsSync(path.join(rootDir, file)));
    run(`git add ${releaseTrackedFiles.join(' ')}`);
    try {
        execSync('git diff --cached --quiet', { stdio: 'ignore', cwd: rootDir });
        console.log('ℹ️ No changes to commit.');
    } catch (e) {
        run(`git commit -m "chore(release): v${newVersion}"`);
        console.log(`✅ Committed: chore(release): v${newVersion}`);
    }

    try {
        run(`git tag v${newVersion}`);
        console.log(`✅ Created tag: v${newVersion}`);
    } catch (e) {
        console.log(`⚠️ Tag v${newVersion} may already exist. Skipping.`);
    }

    console.log('🚀 Pushing to remote...');
    run('git push');
    run(`git push origin v${newVersion}`);
    console.log('✅ Pushed changes and tag to remote');

    // ═══════════════════════════════════════════
    // Phase 3: Build uTools plugin
    // ═══════════════════════════════════════════
    console.log('\n🔨 Phase 3: Building plugins...\n');

    console.log('📦 Building uTools plugin...');
    run('npm run build:utools');
    console.log('✅ uTools plugin built -> dist-utools/');

    // ═══════════════════════════════════════════
    // Phase 4: Publish ZTools plugin
    // ═══════════════════════════════════════════
    console.log('\n🚀 Phase 4: Publishing ZTools plugin...\n');

    try {
        // Build an isolated source-only publish repo to avoid committing unrelated code/artifacts
        ensureCleanDir(ztoolsPublishRepoDir);

        // Source code & build config
        copyRecursive(path.join(rootDir, 'src'), path.join(ztoolsPublishRepoDir, 'src'));
        copyRecursive(path.join(rootDir, 'public'), path.join(ztoolsPublishRepoDir, 'public'));
        for (const file of ['index.html', 'vite.config.ts', 'uno.config.ts', 'tsconfig.json', 'tsconfig.node.json']) {
            copyRecursive(path.join(rootDir, file), path.join(ztoolsPublishRepoDir, file));
        }

        // ZTools plugin files → repo root (NOT as ztools/ subdirectory)
        copyRecursive(path.join(rootDir, 'ztools', 'plugin.json'), path.join(ztoolsPublishRepoDir, 'plugin.json'));
        copyRecursive(path.join(rootDir, 'ztools', 'preload.js'), path.join(ztoolsPublishRepoDir, 'preload.js'));
        copyRecursive(path.join(rootDir, 'public', 'logo.png'), path.join(ztoolsPublishRepoDir, 'logo.png'));
        copyRecursive(path.join(rootDir, 'README.md'), path.join(ztoolsPublishRepoDir, 'README.md'));
        copyRecursive(path.join(rootDir, 'docs', 'images'), path.join(ztoolsPublishRepoDir, 'docs', 'images'));
        // CI custom build script at root
        copyRecursive(path.join(rootDir, 'ztools', 'build-plugin.sh'), path.join(ztoolsPublishRepoDir, 'build-plugin.sh'));

        // package.json (keep build scripts for CI)
        const publishPackageJson = {
            ...JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')),
            private: true,
        };
        writeJson(path.join(ztoolsPublishRepoDir, 'package.json'), publishPackageJson, 2);

        // Sync version in plugin.json at root
        const publishPluginJsonPath = path.join(ztoolsPublishRepoDir, 'plugin.json');
        const publishPluginJson = JSON.parse(fs.readFileSync(publishPluginJsonPath, 'utf8'));
        publishPluginJson.version = newVersion;
        writeJson(publishPluginJsonPath, publishPluginJson, 4);

        // Local release record
        fs.writeFileSync(
            path.join(ztoolsPublishRepoDir, '.release-source.txt'),
            `source-only publish workspace for ztools v${newVersion}\n`,
            'utf8'
        );

        run('git init', { cwd: ztoolsPublishRepoDir });
        run('git add .', { cwd: ztoolsPublishRepoDir });
        run(`git commit -m "chore(release): ztools source v${newVersion}"`, { cwd: ztoolsPublishRepoDir });

        // plugin-cli reads plugin.json from cwd; plugin.json is at repo root
        run('npx @ztools-center/plugin-cli@latest publish', { cwd: ztoolsPublishRepoDir });
        console.log('✅ ZTools plugin published successfully');
    } catch (e) {
        console.error('❌ ZTools publish failed:', e.message);
        console.log('💡 You can retry manually:');
        console.log(`   cd .ztools-publish-repo && npx @ztools-center/plugin-cli@latest publish`);
    }

    // ═══════════════════════════════════════════
    // Done
    // ═══════════════════════════════════════════
    console.log(`\n🎉 v${newVersion} released successfully!`);
    console.log('   - Git: committed, tagged, pushed');
    console.log('   - uTools: dist-utools/ ready');
    console.log('   - ZTools: published to plugin repository');
} catch (error) {
    console.error('❌ Release failed:', error);
    process.exit(1);
}

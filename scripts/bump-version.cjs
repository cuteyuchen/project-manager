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

try {
    // 1. package.json
    const packageJsonPath = path.join(rootDir, 'package.json');
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    const oldVersion = packageJson.version;
    packageJson.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log(`✅ Updated package.json: ${oldVersion} -> ${newVersion}`);

    // 2. src-tauri/tauri.conf.json
    const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
    const tauriConfContent = fs.readFileSync(tauriConfPath, 'utf8');
    const tauriConf = JSON.parse(tauriConfContent);
    tauriConf.version = newVersion;
    fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
    console.log(`✅ Updated src-tauri/tauri.conf.json: ${oldVersion} -> ${newVersion}`);

    // 3. src-tauri/Cargo.toml
    const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
    let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    // Use regex to replace the version under [package]
    // This assumes version is near the top or distinct enough.
    // We'll look for `version = "..."` line.
    const cargoRegex = /^version = ".*"$/m;
    if (cargoRegex.test(cargoToml)) {
        cargoToml = cargoToml.replace(cargoRegex, `version = "${newVersion}"`);
        fs.writeFileSync(cargoTomlPath, cargoToml);
        console.log(`✅ Updated src-tauri/Cargo.toml to ${newVersion}`);

        // Update Cargo.lock by running cargo check or similar
        // Or simply wait for the user to build?
        // Actually, for consistency, we should try to update Cargo.lock if possible.
        // Running `cargo check` inside src-tauri should trigger a lock file update.
        try {
            console.log('🔄 Updating Cargo.lock...');
            execSync('cargo check', { stdio: 'inherit', cwd: path.join(rootDir, 'src-tauri') });
            console.log('✅ Updated src-tauri/Cargo.lock');
        } catch (e) {
            console.warn('⚠️ Failed to update Cargo.lock automatically. You may need to run "cargo check" manually.');
        }

    } else {
        console.warn('⚠️ Could not find version field in Cargo.toml');
    }

    // 4. utools/plugin.json
    const utoolsPluginPath = path.join(rootDir, 'utools', 'plugin.json');
    if (fs.existsSync(utoolsPluginPath)) {
        const utoolsPluginContent = fs.readFileSync(utoolsPluginPath, 'utf8');
        const utoolsPlugin = JSON.parse(utoolsPluginContent);
        utoolsPlugin.version = newVersion;
        fs.writeFileSync(utoolsPluginPath, JSON.stringify(utoolsPlugin, null, 4) + '\n');
        console.log(`✅ Updated utools/plugin.json to ${newVersion}`);
    } else {
        console.warn('⚠️ Could not find utools/plugin.json');
    }

    // 5. utools/preload.js
    const preloadPath = path.join(rootDir, 'utools', 'preload.js');
    if (fs.existsSync(preloadPath)) {
        let preloadContent = fs.readFileSync(preloadPath, 'utf8');
        const versionRegex = /(getAppVersion:\s*async\s*\(\)\s*=>\s*\{\s*return\s*")([^"]+)(")/;
        if (versionRegex.test(preloadContent)) {
            preloadContent = preloadContent.replace(versionRegex, `$1${newVersion}$3`);
            fs.writeFileSync(preloadPath, preloadContent);
            console.log(`✅ Updated utools/preload.js to ${newVersion}`);
        } else {
             console.warn('⚠️ Could not find getAppVersion pattern in utools/preload.js');
        }
    }

    // 6. ztools/plugin.json
    const ztoolsPluginPath = path.join(rootDir, 'ztools', 'plugin.json');
    if (fs.existsSync(ztoolsPluginPath)) {
        const ztoolsPluginContent = fs.readFileSync(ztoolsPluginPath, 'utf8');
        const ztoolsPlugin = JSON.parse(ztoolsPluginContent);
        ztoolsPlugin.version = newVersion;
        fs.writeFileSync(ztoolsPluginPath, JSON.stringify(ztoolsPlugin, null, 4) + '\n');
        console.log(`✅ Updated ztools/plugin.json to ${newVersion}`);
    } else {
        console.warn('⚠️ Could not find ztools/plugin.json');
    }

    // 7. ztools/preload.js
    const ztoolsPreloadPath = path.join(rootDir, 'ztools', 'preload.js');
    if (fs.existsSync(ztoolsPreloadPath)) {
        let ztoolsPreloadContent = fs.readFileSync(ztoolsPreloadPath, 'utf8');
        const versionRegex2 = /(getAppVersion:\s*async\s*\(\)\s*=>\s*\{\s*return\s*")([^"]+)(")/;
        if (versionRegex2.test(ztoolsPreloadContent)) {
            ztoolsPreloadContent = ztoolsPreloadContent.replace(versionRegex2, `$1${newVersion}$3`);
            fs.writeFileSync(ztoolsPreloadPath, ztoolsPreloadContent);
            console.log(`✅ Updated ztools/preload.js to ${newVersion}`);
        } else {
            console.warn('⚠️ Could not find getAppVersion pattern in ztools/preload.js');
        }
    }

    // 8. Git operations
    console.log('\n📦 Executing Git operations...');

    // git add
    execSync('git add .', { stdio: 'inherit', cwd: rootDir });
    console.log('✅ Staged changes');

    // git commit
    try {
        execSync('git diff --cached --quiet', { stdio: 'ignore', cwd: rootDir });
        // If exit code is 0, no changes. If 1, changes exist.
        // Wait, execSync throws on non-zero exit code usually? 
        // No, git diff --quiet returns 1 if there are differences.
        // So if it throws (exit code 1), we HAVE changes.
        // If it returns successfully (exit code 0), we have NO changes.
        console.log('ℹ️ No changes to commit.');
    } catch (e) {
        // Exit code 1 means changes exist, so we commit.
        execSync(`git commit -m "chore(release): v${newVersion}"`, { stdio: 'inherit', cwd: rootDir });
        console.log(`✅ Committed changes: chore(release): v${newVersion}`);
    }

    // git tag
    try {
        execSync(`git tag v${newVersion}`, { stdio: 'inherit', cwd: rootDir });
        console.log(`✅ Created tag: v${newVersion}`);
    } catch (e) {
        console.log(`⚠️ Tag v${newVersion} might already exist. Skipping creation.`);
    }

    // git push
    console.log('🚀 Pushing to remote...');
    execSync('git push', { stdio: 'inherit', cwd: rootDir });
    execSync(`git push origin v${newVersion}`, { stdio: 'inherit', cwd: rootDir });
    console.log('✅ Pushed changes and tags to remote');

    console.log(`\n🎉 Version bumped to ${newVersion} successfully!`);
} catch (error) {
    console.error('❌ Error updating files:', error);
    process.exit(1);
}

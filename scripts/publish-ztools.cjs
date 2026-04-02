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

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractVersionChangelog(readmeContent, version) {
    const changelogIndex = readmeContent.indexOf('## 更新日志');
    if (changelogIndex === -1) return '';

    const changelogContent = readmeContent.slice(changelogIndex);
    const versionPattern = new RegExp(`###\\s+v${escapeRegExp(version)}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+v\\d+\\.\\d+\\.\\d+|\\n##\\s+|$)`);
    const match = changelogContent.match(versionPattern);

    if (!match) return '';

    return `### v${version}\n\n${match[1].trim()}\n`;
}

function normalizeChangelogForCommit(changelog) {
    return changelog
        .replace(/^###\s+/gm, '')
        .replace(/\*\*/g, '')
        .trim();
}

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) console.log('\n🧪 DRY RUN MODE — will not actually publish\n');

const version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
const readmePath = path.join(rootDir, 'README.md');
const readmeContent = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
const extractedChangelog = extractVersionChangelog(readmeContent, version);
const changelogContent = extractedChangelog || `### v${version}\n\n- 本次发布未在 README 中找到对应版本的更新日志，请在发布后补充说明。\n`;
const commitMessage = [
    `chore(release): ztools source v${version}`,
    '',
    '更新日志',
    '',
    normalizeChangelogForCommit(changelogContent),
    ''
].join('\n');

console.log(`\n Publishing ZTools plugin (v${version})...\n`);

try {
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

    // Sync version in plugin.json
    const publishPluginJsonPath = path.join(ztoolsPublishRepoDir, 'plugin.json');
    const publishPluginJson = JSON.parse(fs.readFileSync(publishPluginJsonPath, 'utf8'));
    publishPluginJson.version = version;
    writeJson(publishPluginJsonPath, publishPluginJson, 4);

    fs.writeFileSync(
        path.join(ztoolsPublishRepoDir, '.release-source.txt'),
        `source-only publish workspace for ztools v${version}\n`,
        'utf8'
    );
    fs.writeFileSync(
        path.join(ztoolsPublishRepoDir, 'CHANGELOG.md'),
        `# 更新日志\n\n${changelogContent.trim()}\n`,
        'utf8'
    );

    run('git init', { cwd: ztoolsPublishRepoDir });
    run('git add .', { cwd: ztoolsPublishRepoDir });
    fs.writeFileSync(
        path.join(ztoolsPublishRepoDir, '.release-commit-message.txt'),
        commitMessage,
        'utf8'
    );
    run('git commit -F .release-commit-message.txt', { cwd: ztoolsPublishRepoDir });

    if (isDryRun) {
        console.log('\n🧪 Dry run: skipping publish step.');
        console.log(`   Would run: npx @ztools-center/plugin-cli@latest publish`);
        console.log(`   In:        ${ztoolsPublishRepoDir}`);
        console.log(`\n✅ Dry run complete — publish workspace ready at .ztools-publish-repo/\n`);
    } else {
        // plugin-cli reads plugin.json from cwd; plugin.json is at repo root
        run('npx @ztools-center/plugin-cli@latest publish', { cwd: ztoolsPublishRepoDir });
        console.log(`\n✅ ZTools plugin v${version} published successfully\n`);
    }
} catch (e) {
    console.error('❌ ZTools publish failed:', e.message);
    console.log('💡 You can retry manually:');
    console.log(`   cd .ztools-publish-repo && npx @ztools-center/plugin-cli@latest publish`);
    process.exit(1);
}

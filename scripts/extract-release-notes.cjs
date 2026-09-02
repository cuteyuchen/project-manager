const fs = require('node:fs');
const path = require('node:path');
const {
    ROOT_DIR,
    assertReleaseVersion,
    extractReleaseNotes,
} = require('./release-utils.cjs');

function main() {
    const version = assertReleaseVersion(process.argv[2]);
    const changelogPath = path.join(ROOT_DIR, 'CHANGELOG.md');
    const content = fs.readFileSync(changelogPath, 'utf8');
    const notes = extractReleaseNotes(content, version);
    if (!notes) {
        throw new Error(`CHANGELOG.md does not contain a non-empty section for v${version}.`);
    }
    process.stdout.write(`${notes}\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Release notes extraction failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { main };

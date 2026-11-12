// Checks the file reader the launcher patches (patch 11) against the installed package.
//
//   node launcher/file-read-check.mjs <package dir>
//
// A path an agent writes as ~/x must open the file in the home directory, and
// the writing side must still refuse anything outside the project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pkg = process.argv[2];
assert.ok(pkg && fs.existsSync(pkg), 'pass the package directory');
const lib = `${pkg}/dist-server/server`;
const { createFileTreeService } = await import(`${lib}/modules/file-tree/file-tree.service.js`);
const { resolveReadOnlyRootPath } = await import(`${lib}/shared/utils.js`);

const home = os.homedir();
const project = fs.mkdtempSync(path.join(home, '.kit-read-project-'));
const outside = fs.mkdtempSync(path.join(home, '.kit-read-outside-'));
process.on('exit', () => { for (const d of [project, outside]) fs.rmSync(d, { recursive: true, force: true }); });
fs.writeFileSync(path.join(outside, 'note.md'), 'hello');

const service = createFileTreeService({
  fileSystem: {
    readTextFile: (p) => fs.promises.readFile(p, 'utf8'),
    writeTextFile: (p, c) => fs.promises.writeFile(p, c),
    access: (p) => fs.promises.access(p), stat: (p) => fs.promises.stat(p), realpath: (p) => fs.promises.realpath(p),
  },
  projects: { getProjectPathById: async () => project },
  workspace: { rootPath: home, resolveReadOnlyRootPath, validatePath: async () => ({ valid: true }) },
  logger: { error() {}, warn() {}, info() {} },
});

const tilde = `~/${path.basename(outside)}/note.md`;
const read = await service.readTextFile('p', tilde);
assert.equal(read.content ?? read, 'hello', 'a ~/ path reads the file in the home directory');
await assert.rejects(service.saveTextFile('p', path.join(outside, 'note.md'), 'x'), /project root/,
  'a write to the same file, outside the project, is still refused');
assert.equal(fs.readFileSync(path.join(outside, 'note.md'), 'utf8'), 'hello');
console.log('file reads: all checks passed');

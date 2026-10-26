// tests/repo.test.ts — indexing, ignore rules, path safety, tools
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { createIgnoreMatcher } from '../src/repo/ignore.js';
import { buildIndex } from '../src/repo/indexer.js';
import { isSensitivePath, looksBinary, toRepoRelative } from '../src/repo/safety.js';
import { extractImports, extractSymbols, resolveImport } from '../src/repo/symbols.js';
import { RepoToolset } from '../src/repo/tools.js';
import { UsageError } from '../src/errors.js';
import { makeTempDir, makeTempRepo } from './helpers.js';

describe('safety', () => {
    test('detects sensitive files but allows env templates', () => {
        for (const p of ['.env', '.env.local', 'config/.env.production', 'id_rsa', 'keys/server.pem', '.npmrc', 'gcp/service-account-prod.json', 'infra/terraform.tfstate', 'home/.ssh/config', 'credentials.json']) {
            assert.equal(isSensitivePath(p), true, p);
        }
        for (const p of ['.env.example', '.env.sample', 'src/env.ts', 'src/keyboard.ts', 'docs/secrets-management.md']) {
            assert.equal(isSensitivePath(p), false, p);
        }
    });

    test('toRepoRelative rejects traversal and outside absolute paths', () => {
        const root = path.resolve('/repo/root');
        assert.equal(toRepoRelative(root, 'src/a.ts'), 'src/a.ts');
        assert.equal(toRepoRelative(root, './src/../src/a.ts'), 'src/a.ts');
        assert.equal(toRepoRelative(root, '@src/a.ts'), 'src/a.ts');
        assert.equal(toRepoRelative(root, '/repo/root/src/a.ts'), 'src/a.ts');
        assert.equal(toRepoRelative(root, '../secret.txt'), null);
        assert.equal(toRepoRelative(root, 'src/../../x'), null);
        assert.equal(toRepoRelative(root, '/etc/passwd'), null);
        assert.equal(toRepoRelative(root, ''), null);
        assert.equal(toRepoRelative(root, 'a\0b'), null);
        assert.equal(toRepoRelative(root, '.'), null);
    });

    test('looksBinary uses NUL bytes', () => {
        assert.equal(looksBinary(Buffer.from('hello')), false);
        assert.equal(looksBinary(Buffer.from([0x50, 0x00, 0x10])), true);
    });
});

describe('ignore rules', () => {
    test('defaults and gitignore patterns', () => {
        const m = createIgnoreMatcher('# comment\n*.log\n/generated\ndocs/*.tmp\ncache/\n!keep.log\n');
        assert.equal(m.isIgnored('node_modules', true), true);
        assert.equal(m.isIgnored('packages/a/node_modules', true), true);
        assert.equal(m.isIgnored('.git', true), true);
        assert.equal(m.isIgnored('dist', true), true);
        assert.equal(m.isIgnored('src/app.log', false), true);
        assert.equal(m.isIgnored('generated', true), true);
        assert.equal(m.isIgnored('src/generated', true), false, 'anchored pattern only matches at root');
        assert.equal(m.isIgnored('docs/a.tmp', false), true);
        assert.equal(m.isIgnored('cache', true), true);
        assert.equal(m.isIgnored('cache', false), false, 'dir-only pattern does not match files');
        assert.equal(m.isIgnored('src/index.ts', false), false);
        assert.deepEqual(m.unsupportedRules, ['!keep.log']);
    });
});

describe('symbols', () => {
    test('extracts TS symbols and imports', () => {
        const src = `import { a } from './a.js';\nexport async function loadUser() {}\nexport class UserStore {\n    async save(user: User): Promise<void> {\n        if (x) {}\n    }\n}\nexport const MAX = 3;\nexport interface User {}\nconst lazy = await import('./lazy.js');\n`;
        const symbols = extractSymbols('typescript', src);
        for (const s of ['loadUser', 'UserStore', 'save', 'MAX', 'User']) assert.ok(symbols.includes(s), s);
        assert.ok(!symbols.includes('if'));
        assert.deepEqual(extractImports('typescript', src).sort(), ['./a.js', './lazy.js']);
    });

    test('resolves TS ESM .js specifiers to .ts sources and python modules', () => {
        const files = new Set(['src/a.ts', 'src/lib/index.ts', 'pkg/mod.py', 'pkg/__init__.py', 'pkg/sub/x.py']);
        const exists = (p: string) => files.has(p);
        assert.equal(resolveImport('src/b.ts', './a.js', 'typescript', exists), 'src/a.ts');
        assert.equal(resolveImport('src/b.ts', './lib', 'typescript', exists), 'src/lib/index.ts');
        assert.equal(resolveImport('src/b.ts', 'express', 'typescript', exists), null);
        assert.equal(resolveImport('src/b.ts', '../../outside', 'typescript', exists), null);
        assert.equal(resolveImport('main.py', 'pkg.mod', 'python', exists), 'pkg/mod.py');
        assert.equal(resolveImport('pkg/sub/x.py', '..mod', 'python', exists), 'pkg/mod.py');
    });
});

describe('buildIndex', () => {
    test('applies ignore rules, size/binary limits, sensitive detection, and redaction', async () => {
        const root = await makeTempRepo({
            '.gitignore': 'logs/\n',
            'src/a.ts': "import { b } from './b.js';\nexport function a() { return b(); }\n",
            'src/b.ts': 'export function b() { return 1; }\n',
            'src/config.ts': 'export const API_KEY = "AIzaSyA1234567890abcdefghijklmnopqrstuv";\n',
            'node_modules/x/index.js': 'module.exports = 1;\n',
            '.git/HEAD': 'ref: refs/heads/main\n',
            'dist/a.js': 'compiled\n',
            'logs/app.txt': 'log\n',
            '.env': 'SECRET_TOKEN=supersecretvalue123\n',
            '.env.example': 'SECRET_TOKEN=\n',
            'keys/id_rsa': 'PRIVATE',
            'img/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            'data/blob.dat': new Uint8Array([0x41, 0x00, 0x42]),
            'big.txt': 'x'.repeat(5000),
            'package-lock.json': '{}',
        });
        const index = await buildIndex(root, { maxFileBytes: 1000 });
        const kinds = Object.fromEntries(index.files.map(f => [f.path, f.kind]));

        assert.equal(kinds['src/a.ts'], 'text');
        assert.equal(kinds['.env'], 'sensitive');
        assert.equal(kinds['keys/id_rsa'], 'sensitive');
        assert.equal(kinds['.env.example'], 'text');
        assert.equal(kinds['img/logo.png'], 'binary');
        assert.equal(kinds['data/blob.dat'], 'binary');
        assert.equal(kinds['big.txt'], 'too-large');
        assert.equal(kinds['package-lock.json'], 'generated');
        for (const ignored of ['node_modules/x/index.js', '.git/HEAD', 'dist/a.js', 'logs/app.txt']) {
            assert.equal(kinds[ignored], undefined, ignored);
        }
        assert.equal(index.byPath.get('.env')!.content, undefined, 'sensitive content is never read');

        const config = index.byPath.get('src/config.ts')!;
        assert.equal(config.redacted, true);
        assert.ok(!config.content!.includes('AIzaSy'), 'API key redacted');

        assert.deepEqual(index.byPath.get('src/a.ts')!.imports, ['src/b.ts']);
        assert.deepEqual(index.byPath.get('src/b.ts')!.importedBy, ['src/a.ts']);
    });

    test('does not follow symlinks (files or directories), including ones that escape the root', async () => {
        const outside = await makeTempRepo({ 'secret.txt': 'outside secret', 'dir/x.ts': 'export const x = 1;' });
        const root = await makeTempRepo({ 'src/a.ts': 'export const a = 1;\n' });
        await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
        await fs.symlink(path.join(outside, 'dir'), path.join(root, 'linkdir'));
        await fs.symlink(path.join(root, 'src'), path.join(root, 'loop'));
        const index = await buildIndex(root);
        assert.deepEqual(index.files.map(f => f.path), ['src/a.ts']);
        assert.equal(index.stats.symlinksSkipped, 3);
    });

    test('stops at maxFiles and reports truncation', async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 10; i++) files[`f${i}.ts`] = `export const v${i} = ${i};`;
        const index = await buildIndex(await makeTempRepo(files), { maxFiles: 4 });
        assert.equal(index.files.length, 4);
        assert.equal(index.stats.truncated, true);
    });

    test('rejects a missing repository with a usage error', async () => {
        const dir = await makeTempDir();
        await assert.rejects(buildIndex(path.join(dir, 'nope')), UsageError);
    });
});

describe('RepoToolset', () => {
    test('confines reads to indexed, non-sensitive files', async () => {
        const outside = await makeTempRepo({ 'secret.txt': 'TOP SECRET' });
        const root = await makeTempRepo({ 'src/a.ts': 'line1\nline2\nline3\n', '.env': 'X=1' });
        await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
        const tools = new RepoToolset(await buildIndex(root));

        const ok = tools.execute('read_file', { path: 'src/a.ts', startLine: 2, endLine: 2 });
        assert.equal(ok.ok, true);
        assert.match(ok.output, /2\| line2/);
        assert.doesNotMatch(ok.output, /line1/);

        for (const bad of ['../' + path.basename(outside) + '/secret.txt', path.join(outside, 'secret.txt'), '/etc/passwd', 'link.txt', '.env', 'missing.ts']) {
            const res = tools.execute('read_file', { path: bad });
            assert.equal(res.ok, false, bad);
            assert.doesNotMatch(res.output, /TOP SECRET|X=1/);
        }
        assert.equal(tools.execute('read_file', {}).ok, false);
        assert.equal(tools.execute('rm_rf', {}).ok, false);
    });

    test('search_code is a literal search (regex metacharacters are safe)', async () => {
        const root = await makeTempRepo({ 'a.ts': 'const re = /(a+)+$/;\nfoo(bar)\nFOO(bar)\n' });
        const tools = new RepoToolset(await buildIndex(root));
        const res = tools.execute('search_code', { query: 'foo(bar)' });
        assert.equal(res.ok, true);
        assert.equal(res.output.split('\n').length, 2, 'case-insensitive, both lines, no lastIndex skipping');
        assert.equal(tools.execute('search_code', { query: '(a+)+$' }).ok, true);
    });

    test('list_files filters with globs', async () => {
        const root = await makeTempRepo({ 'src/a.ts': '', 'src/b.js': '', 'README.md': '' });
        const tools = new RepoToolset(await buildIndex(root));
        assert.equal(tools.execute('list_files', { pattern: 'src/**/*.ts' }).output, 'src/a.ts');
        assert.equal(tools.execute('list_files', { pattern: '*.md' }).output, 'README.md');
    });
});

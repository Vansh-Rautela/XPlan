// tests/retrieval.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildIndex } from '../src/repo/indexer.js';
import { buildContextPack, excerptFile, extractMentionedPaths, extractTerms, rankFiles, renderRepoOverview, stem, tokenize } from '../src/repo/retrieval.js';
import { makeTempRepo, SAMPLE_APP } from './helpers.js';

describe('terms', () => {
    test('tokenize splits identifiers and stems', () => {
        assert.deepEqual(tokenize('createUser rate_limiter HTTPServer'), ['creat', 'user', 'rate', 'limit', 'http', 'serv']);
        assert.equal(stem('users'), 'user');
        assert.equal(stem('logging'), 'log');
        assert.equal(stem('logger'), 'log');
        assert.equal(stem('entries'), 'entry');
        // word families that should meet
        for (const [a, b] of [['validate', 'validation'], ['configure', 'configurable'], ['paginate', 'pagination'], ['limiting', 'limiter'], ['delete', 'deletion']]) {
            assert.equal(stem(a!), stem(b!), `${a} ~ ${b}`);
        }
    });

    test('extractTerms drops stopwords and generic verbs', () => {
        assert.deepEqual(extractTerms('Add pagination to the list users endpoint'), ['pagin', 'list', 'user', 'endpoint']);
    });
});

describe('rankFiles on the sample app', () => {
    const cases: Array<[string, string[]]> = [
        ['Validate email format when creating a user', ['src/utils/validation.ts', 'src/routes/users.ts', 'src/services/userService.ts']],
        ['Add pagination to the list users endpoint', ['src/routes/users.ts', 'src/services/userService.ts']],
        ['Make the server port configurable through environment variables', ['src/config.ts', 'src/server.ts']],
        ['Change the request logger middleware to include response time', ['src/middleware/requestLogger.ts']],
    ];
    for (const [goal, expected] of cases) {
        test(goal, async () => {
            const index = await buildIndex(SAMPLE_APP);
            const top = rankFiles(index, { goal }).slice(0, 5).map(r => r.path);
            for (const file of expected) assert.ok(top.includes(file), `${file} in top 5: ${top.join(', ')}`);
        });
    }

    test('every ranked file has reasons; neighbours get import reasons', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const ranked = rankFiles(index, { goal: 'soft delete users' });
        assert.ok(ranked.length > 0);
        for (const r of ranked) assert.ok(r.reasons.length > 0, r.path);
        assert.ok(ranked.some(r => r.reasons.some(x => x.startsWith('imports ') || x.startsWith('imported by '))));
    });

    test('mentioned and pinned paths come first', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const mentioned = extractMentionedPaths('Look at @src/routes/health.ts and src/db/client.ts please', index);
        assert.deepEqual(mentioned.sort(), ['src/db/client.ts', 'src/routes/health.ts']);
        const ranked = rankFiles(index, { goal: 'email', pinned: new Map([['src/routes/health.ts', 'mentioned in goal']]) });
        assert.equal(ranked[0]!.path, 'src/routes/health.ts');
        assert.equal(ranked[0]!.reasons[0], 'mentioned in goal');
    });
});

describe('ranking signals', () => {
    test('a coordinator importing several matches outranks a utility imported by them', async () => {
        const root = await makeTempRepo({
            'src/providers/alpha.ts': "import { log } from '../log.js';\nexport class AlphaProvider { connect() { log('provider alpha'); } }\n",
            'src/providers/beta.ts': "import { log } from '../log.js';\nexport class BetaProvider { connect() { log('provider beta'); } }\n",
            'src/registry.ts': "import { AlphaProvider } from './providers/alpha.js';\nimport { BetaProvider } from './providers/beta.js';\nexport const all = [AlphaProvider, BetaProvider];\n",
            'src/log.ts': 'export function log(m: string) { return m; }\n',
        });
        const ranked = rankFiles(await buildIndex(root), { goal: 'Add a gamma provider' });
        const pos = (p: string) => ranked.findIndex(r => r.path === p);
        assert.ok(pos('src/registry.ts') !== -1 && pos('src/registry.ts') < pos('src/log.ts'), ranked.map(r => r.path).join(', '));
        assert.match(ranked[pos('src/registry.ts')]!.reasons.join(), /imports 2 matching files/);
    });

    test('test files are dampened unless the goal is about tests', async () => {
        const body = 'export function parseInvoice(input: string) { return input; }\n';
        const root = await makeTempRepo({ 'src/invoice.ts': body, 'tests/invoice.test.ts': body + '// invoice invoice\n' });
        const index = await buildIndex(root);
        assert.equal(rankFiles(index, { goal: 'parse invoice totals' })[0]!.path, 'src/invoice.ts');
        assert.equal(rankFiles(index, { goal: 'add tests for invoice parsing' })[0]!.path, 'tests/invoice.test.ts');
    });

    test('goals naming a --flag boost files that define command-line options', async () => {
        const root = await makeTempRepo({
            'src/options.ts': "export const flags = ['--verbose', '--output', '--format', '--retries'];\n",
            'src/worker.ts': 'export function work(limit: number) { return limit; }\n',
        });
        const ranked = rankFiles(await buildIndex(root), { goal: 'Add a --limit flag for the worker' });
        const options = ranked.find(r => r.path === 'src/options.ts');
        assert.ok(options, 'options file ranked despite no lexical match');
        assert.match(options!.reasons.join(), /defines command-line options \(4 flags\)/);
    });
});

describe('buildContextPack', () => {
    test('respects file and character budgets and withholds non-text files', async () => {
        const index = await buildIndex(SAMPLE_APP);
        const ranked = rankFiles(index, { goal: 'users email validation route service', pinned: new Map([['.env.missing', 'x']]) });
        const pack = buildContextPack(index, ranked, { maxFiles: 2, maxChars: 3000, terms: ['user'] });
        assert.equal(pack.files.length, 2);
        assert.ok(pack.totalChars <= 3000);
        assert.ok(pack.omitted.length > 0);
    });

    test('sensitive files requested by pinning are withheld, not read', async () => {
        const root = await makeTempRepo({ '.env': 'TOKEN=abcdef', 'src/a.ts': 'export const token = 1;' });
        const index = await buildIndex(root);
        const pack = buildContextPack(index, [{ path: '.env', score: 1000, reasons: ['pinned'] }, { path: 'src/a.ts', score: 1, reasons: ['x'] }], { maxFiles: 5, maxChars: 10_000, terms: ['token'] });
        assert.deepEqual(pack.files.map(f => f.path), ['src/a.ts']);
        assert.equal(pack.withheld[0]!.path, '.env');
        assert.ok(!JSON.stringify(pack).includes('abcdef'));
    });

    test('duplicate files are included once', async () => {
        const body = 'export function sameThing() { return "user"; }\n';
        const root = await makeTempRepo({ 'a/user.ts': body, 'b/user.ts': body });
        const index = await buildIndex(root);
        const pack = buildContextPack(index, rankFiles(index, { goal: 'user sameThing' }), { maxFiles: 5, maxChars: 10_000, terms: ['user'] });
        assert.equal(pack.files.length, 1);
        assert.match(pack.omitted[0]!.reasons.join(), /duplicate of/);
    });

    test('excerptFile keeps the header and windows around matching lines', () => {
        const lines = Array.from({ length: 400 }, (_, i) => (i === 250 ? 'function rateLimit() {}' : `const filler${i} = ${i};`));
        const { text, truncated } = excerptFile(lines.join('\n'), ['rate'], 2500);
        assert.equal(truncated, true);
        assert.match(text, /^ {0,2}1\| const filler0/);
        assert.match(text, /251\| function rateLimit/);
        assert.ok(text.length <= 2600);
    });
});

test('renderRepoOverview summarises manifests and marks non-text files', async () => {
    const root = await makeTempRepo({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' }, dependencies: { zod: '1' } }), '.env': 'A=1', 'src/a.ts': '' });
    const overview = renderRepoOverview(await buildIndex(root));
    assert.match(overview, /scripts: \{"test":"node --test"\}/);
    assert.match(overview, /dependencies: zod/);
    assert.match(overview, /\.env \[sensitive\]/);
    assert.ok(!overview.includes('A=1'));
});

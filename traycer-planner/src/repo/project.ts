// src/repo/project.ts
// Detects how a project is built and tested, from its manifests. Used to tell a human or a coding
// agent how to verify each task. Only reads indexed manifests; never runs anything.
import type { RepoIndex } from './indexer.js';

export interface ProjectCommands {
    test?: string;
    build?: string;
    lint?: string;
    typecheck?: string;
}

function packageManager(index: RepoIndex): string {
    if (index.byPath.has('pnpm-lock.yaml')) return 'pnpm';
    if (index.byPath.has('yarn.lock')) return 'yarn';
    if (index.byPath.has('bun.lockb') || index.byPath.has('bun.lock')) return 'bun';
    return 'npm';
}

export function detectProjectCommands(index: RepoIndex): ProjectCommands {
    const pkg = index.byPath.get('package.json');
    if (pkg?.kind === 'text' && pkg.content) {
        try {
            const scripts = (JSON.parse(pkg.content) as { scripts?: Record<string, unknown> }).scripts ?? {};
            const pm = packageManager(index);
            const run = (name: string) => (name === 'test' ? `${pm} test` : `${pm} run ${name}`);
            const pick = (...names: string[]) => names.find(n => typeof scripts[n] === 'string');
            const commands: ProjectCommands = {};
            const test = pick('test');
            const build = pick('build');
            const lint = pick('lint');
            const typecheck = pick('typecheck', 'type-check', 'tsc');
            if (test) commands.test = run(test);
            if (build) commands.build = run(build);
            if (lint) commands.lint = run(lint);
            if (typecheck) commands.typecheck = run(typecheck);
            return commands;
        } catch {
            // malformed package.json: fall through
        }
    }
    if (index.byPath.has('go.mod')) return { test: 'go test ./...', build: 'go build ./...', lint: 'go vet ./...' };
    if (index.byPath.has('Cargo.toml')) return { test: 'cargo test', build: 'cargo build', lint: 'cargo clippy' };
    if (index.byPath.has('pyproject.toml') || index.byPath.has('setup.py') || index.byPath.has('requirements.txt')) {
        const pyproject = index.byPath.get('pyproject.toml')?.content ?? '';
        const commands: ProjectCommands = { test: 'pytest' };
        if (/\[tool\.ruff/.test(pyproject)) commands.lint = 'ruff check .';
        if (/\[tool\.mypy/.test(pyproject)) commands.typecheck = 'mypy .';
        return commands;
    }
    if (index.byPath.has('pom.xml')) return { test: 'mvn test', build: 'mvn package' };
    if (index.byPath.has('build.gradle') || index.byPath.has('build.gradle.kts')) return { test: './gradlew test', build: './gradlew build' };
    return {};
}

# XPlan Improvement Plan

Status legend: `[x]` done · `[~]` partially done · `[ ]` not started / deferred.
The checklist in §11 is the source of truth for implementation status.

---

## 1. Executive summary

XPlan is a TypeScript/Node.js CLI that is supposed to turn an engineering goal into a reviewed,
file-level implementation plan using an LLM in a Creator → Planner → Reviewer workflow.

The audit of the original code (`traycer-planner/src`, ~1,300 lines, 8 files) found that the
**workflow described in the README did not exist as a pipeline**: the three "agents" were three
independent chat sessions with different system prompts, and the user copied text between them by
hand. Nothing was structured, validated, or revised. In addition:

- The hardcoded model `gemini-2.0-flash` is listed as **shut down** in Google's model documentation,
  so every LLM call in the shipped tool fails.
- Every file-system tool accepted arbitrary absolute or `../` paths. The model (via function calls)
  or an `@mention` could read `~/.ssh/*`, `.env`, etc. and send it to a cloud API.
- `executor.ts` ran shell commands built from LLM-produced text (`mkdir ${folderName}`), which is a
  command-injection primitive in a tool that is meant to be read-only.
- There were no automated tests (the "test runner" always exits 0 and one of its checks fails).

The improvement work replaces the copy-paste flow with a real, bounded pipeline; adds safe repository
indexing and ranked retrieval; adds schema-validated outputs plus deterministic plan validation;
introduces a small provider interface with a REST Gemini provider and a **local Ollama provider**;
and adds a real test suite and an evaluation harness.

## 2. Original architecture and execution flow

```
npm start  →  tsc && node dist/main.js
main.ts
 ├─ new FileSystemTools()                 (tools.ts)
 ├─ 3 × new CodeSearchAgent({systemPrompt})  (codeAgent.ts, @google/generative-ai, gemini-2.0-flash)
 ├─ sharedTools.indexCodebase('.')         → indexes process.cwd() (i.e. XPlan itself)
 └─ readline menu loop
     1 Creator  ─┐
     2 Planner  ─┼─ agent.chat(text): inject @files → generateContent(tools) →
     3 Reviewer ─┘   execute ONE round of function calls → generateContent → return text
```

Unused/broken modules: `planner.ts` (uses a second SDK, `@google/genai` 0.3.1; `this.model` is never
assigned so any call throws), `executor.ts` (shell execution), `check_models.ts` (puts the API key in
a URL query string), `example.ts` (demo).

## 3. Strengths worth preserving

- Clear product idea: plan first, read-only, three distinct roles.
- ESM + strict TypeScript already configured.
- Function-calling idea (let the model look at code before answering) — kept, but sandboxed and bounded.
- `@path` mentions to force files into context — kept, but path-checked and size-limited.
- Small dependency surface; no heavyweight CLI framework.

## 4. Verified defects and technical debt

| ID | Pri | Finding | Evidence |
|----|-----|---------|----------|
| D1 | P0 | Hardcoded model `gemini-2.0-flash` is shut down; not configurable | `codeAgent.ts:31`; Google models page lists 2.0 Flash as "Shut down" |
| D2 | P0 | Unrestricted file access: `readFile`, `getFileInfo`, `listDirectory`, `grep`, `searchFile` resolve any path; secrets can be sent to the API | `tools.ts:155,170,207,228,468`; `codeAgent.ts:71-97` (`@mention` reads any path) |
| D3 | P0 | Shell command built from LLM text (`exec(\`mkdir ${folderName}\`)`) | `executor.ts:18` |
| D4 | P0 | `PlanningAgent` crashes on first call (`this.model` undefined) | `planner.ts:13,102` |
| D5 | P1 | Only one round of tool calls handled; a second round returns "No final text response." | `codeAgent.ts:190-210` |
| D6 | P1 | Errors converted into chat text; process exits 0 on failure | `codeAgent.ts:212-215`, `main.ts:166` |
| D7 | P1 | `grep` builds a `RegExp` from model input with the `g` flag and calls `.test()` repeatedly → `lastIndex` skips matches; invalid patterns throw; ReDoS possible; binary files scanned | `tools.ts:236-244` |
| D8 | P1 | No pipeline: agents are disconnected, no structured output, no revision loop, reviewer cannot change the plan | `main.ts:97-128` |
| D9 | P1 | Target repository is always `process.cwd()`; `npm start` must run inside `traycer-planner`, so the tool effectively plans only for itself | `main.ts:137`, `package.json` scripts |
| D10 | P1 | Two Gemini SDKs mixed (types from `@google/genai` 0.3.1, calls via deprecated `@google/generative-ai`) | `tools.ts:8`, `codeAgent.ts:2` |
| D11 | P1 | "Semantic search" is a hashed bag-of-words over 1,000-line chunks, returning only a chunk's first line | `tools.ts:277-291,312,412` |
| D12 | P1 | Unbounded history; `@mention` injects whole files with no size cap | `codeAgent.ts:107,141` |
| D13 | P1 | No automated tests; smoke script always exits 0 and its `readFile` check fails | `test_runner.ts:37` (expects `traycer-planner` in `package.json`, name is `codex-cli`) |
| D14 | P1 | No timeouts, retries, or rate-limit handling for LLM calls | `codeAgent.ts:132,196` |
| D15 | P2 | Tool logs (`console.log` with colors) are interleaved with output; no machine-readable output | `tools.ts` throughout |
| D16 | P2 | API key sent as URL query parameter; full error JSON printed | `check_models.ts:20,31` |
| D17 | P2 | Documentation mismatch: "Codex-CLI", "semantic embeddings", system prompt claims "Gemini 2.5 Flash" | `README.md`, `codeAgent.ts:40` |
| D18 | P2 | No local / offline model option (requested: Ollama) | — |
| D19 | P3 | Stray root `package.json` depending on `@google/generative-ai`; `node_modules/.bin` lost exec bits (likely extracted from an archive) so `npx tsc` fails with `Permission denied` | root `package.json`; baseline run |

## 5. Missing capabilities that matter to the product goal

1. One command that goes goal → requirements → plan → review → revision → validated result.
2. Choosing the target repository explicitly (`--repo`).
3. Retrieval that ranks files for the goal and explains *why* each was included.
4. Runtime-validated structured outputs (requirements, plan, review).
5. Deterministic checks that don't depend on the model: file existence, task references, cycles,
   requirement coverage.
6. Honest status: a plan is "validated" only when deterministic checks and the reviewer agree.
7. Local, private planning via Ollama.
8. JSON output for tooling, Markdown for humans, file output.

## 6. Prioritised improvements

| # | Pri | Improvement | Addresses | Files |
|---|-----|-------------|-----------|-------|
| I1 | P0 | Remove `executor.ts`, `planner.ts`, `check_models.ts`, `example.ts`, `codeAgent.ts`, `tools.ts`; replace with the modules below | D3, D4, D10, D16 | `src/*` |
| I2 | P0 | Safe repository index: root-confined paths, no symlink following, default ignore list + `.gitignore`, binary/size limits, sensitive-file detection (content never read), secret redaction in content | D2, D7, D12 | `src/repo/{safety,ignore,indexer}.ts` |
| I3 | P0 | Configurable model with a current default; provider interface; REST Gemini provider (API key in header, not URL) | D1, D10, D16 | `src/llm/*`, `src/config.ts` |
| I4 | P1 | Ollama provider (`/api/chat`, JSON-schema `format`, tools, `num_ctx`, seed) | D18 | `src/llm/ollama.ts` |
| I5 | P1 | HTTP layer with timeouts, cancellation, bounded retries with backoff, `Retry-After`, secret-safe errors | D14, D6 | `src/llm/http.ts`, `src/errors.ts`, `src/redact.ts` |
| I6 | P1 | Zod schemas + structured-output helper with one repair attempt | D8 | `src/agents/schemas.ts`, `src/llm/structured.ts` |
| I7 | P1 | Ranked retrieval with reasons, import-graph boost, snippet windows, char budget, deduplication | D11, D12 | `src/repo/{retrieval,symbols}.ts` |
| I8 | P1 | Pipeline: Creator → (bounded tool exploration) → Planner → [validate + Reviewer → revise]×N | D5, D8 | `src/pipeline.ts`, `src/agents/*` |
| I9 | P1 | Deterministic plan validation (paths, actions, ids, cycles, coverage, tests) | D8 | `src/plan/validate.ts` |
| I10 | P1 | CLI: `plan`, `context`, `doctor`, interactive mode; exit codes; stdout = result, stderr = progress | D6, D9, D15 | `src/cli.ts`, `src/main.ts`, `src/interactive.ts`, `src/logger.ts` |
| I11 | P1 | Real tests with `node:test`, mocked providers, temp-dir fixtures | D13 | `tests/*` |
| I12 | P2 | Markdown/JSON renderers; output file | D15 | `src/plan/render.ts` |
| I13 | P2 | Evaluation harness (retrieval recall offline; full pipeline against a local model) | — | `eval/*` |
| I14 | P2 | README + troubleshooting + security notes rewritten to match the implementation | D17 | `README.md` |

## 7. Task dependencies

```
I1 ─┬─ I2 ── I7 ──┐
    └─ I3 ─┬─ I4  ├─ I8 ── I10 ── I13
           └─ I5  │
       I6 ────────┤
       I9 ────────┘
I11 runs alongside every step; I14 last.
```

## 8. Risks, compatibility, migration

- **Behaviour change (intentional):** the three copy-paste modes are replaced by one pipeline.
  `npm start` with no arguments still opens an interactive session, now with "refine with feedback".
- **Environment variables:** `GOOGLE_API_KEY` still works; `GEMINI_API_KEY` is also accepted (Google's
  current convention) and takes precedence.
- **Provider auto-selection:** if no provider is configured, XPlan uses Gemini when an API key is set
  (previous behaviour) and Ollama otherwise. The chosen provider and whether code leaves the machine
  is always printed to stderr.
- **Gemini structured output:** uses `responseMimeType: application/json` + `responseJsonSchema`.
  If a model rejects the schema field, the provider retries once without it; runtime validation
  still applies. No live Gemini key was available during this work → Gemini is covered by mocked
  HTTP tests only.
- **Small local models** produce weaker plans and may lack tool support. Tool exploration is skipped
  with a warning when the model reports no tool support.
- **SDK removal:** both Gemini SDKs are removed in favour of `fetch` (Node ≥ 22). This removes the
  deprecated SDK and keeps provider code small and mockable.
- **Node version:** `engines.node >= 22` (`AbortSignal.any`, stable `fetch`). Tested on Node 26.

## 9. Test strategy and acceptance criteria

Unit tests (no network, no keys), run with `npm test`:

- CLI parsing: unknown flags, missing goal, invalid numbers → exit code 2 with a message.
- Index: ignores `.git`, `node_modules`, `dist`, `.gitignore` entries; skips binaries and large files;
  does not follow symlinks (including ones pointing outside the root); marks `.env`/keys as sensitive
  and never reads them; redacts secret-looking strings.
- Path safety: absolute paths, `..`, and symlink escapes are rejected by tools.
- Retrieval: expected files ranked in top-k for fixture goals; budget respected; reasons present.
- Structured output: fenced JSON, invalid JSON → repair, schema violations → repair → error.
- Plan validation: unknown files, create-existing, unknown deps, cycles, uncovered requirements.
- Pipeline: approve on first pass; revise once then approve; still failing after the limit →
  `status: "unresolved"` and exit code 4.
- Providers: request mapping, tool-call round trip, 429 + `Retry-After`, 5xx retry, timeout,
  401 hint, Ollama model-not-found and tools-unsupported errors, API key never in error text.

Acceptance criteria:

- `npm run build` and `npm test` pass.
- `xplan context "<goal>" --repo <path>` works with no credentials.
- `xplan plan` against a local Ollama model produces a plan, a review, and an honest status.
- No module reads files outside `--repo` or reads sensitive files.

## 10. Explicitly deferred

| Feature | Reason |
|---------|--------|
| Vector embeddings / persistent index | Lexical + symbol + import-graph ranking is deterministic and good enough for planning-sized repos; embeddings need a model, storage, and invalidation. Revisit once retrieval eval shows misses. |
| Tree-sitter / full AST symbol extraction | Regex extraction covers common TS/JS/Python/Go/Rust/Java declarations without native deps. |
| Nested `.gitignore` files and negation patterns | Root `.gitignore` + defaults cover the common cases; documented as a limitation. |
| Additional providers (OpenAI, Anthropic, …) | Not requested; the provider interface makes them straightforward. Ollama's OpenAI-compatible servers are not targeted. |
| Applying plans / executing code | Out of scope by design; XPlan stays read-only. |
| Streaming output to the user | Structured JSON must be complete before validation; progress is reported per stage instead. (Ollama responses *are* streamed internally — see §12.) |
| CI workflow | No git remote/CI exists in this checkout. |

## 11. Execution checklist

- [x] Phase 0 — inspect repo, back up originals, baseline (`tsc --noEmit` passes; smoke script exits 0 with one failing check; `.bin` not executable)
- [x] I1 remove unsafe/broken modules (`executor.ts`, `planner.ts`, `check_models.ts`, `example.ts`, `codeAgent.ts`, `tools.ts`, `test_runner.ts`; originals kept in an archive outside the repo)
- [x] I2 safe repository index — `src/repo/{indexer,ignore,safety,symbols}.ts`
- [x] I3 provider interface + Gemini REST provider + config — `src/llm/{types,gemini,index}.ts`, `src/config.ts`
- [x] I4 Ollama provider — `src/llm/ollama.ts` (streams internally, `num_ctx`, seed, tools, JSON-schema `format`)
- [x] I5 HTTP resilience + errors + redaction — `src/llm/http.ts`, `src/errors.ts`, `src/redact.ts`
- [x] I6 schemas + structured output helper — `src/agents/schemas.ts`, `src/llm/structured.ts`
- [x] I7 ranked retrieval — `src/repo/retrieval.ts`
- [x] I8 pipeline with bounded review/revision + bounded tool exploration — `src/pipeline.ts`, `src/agents/*`, `src/llm/toolLoop.ts`, `src/repo/tools.ts`
- [x] I9 deterministic plan validation — `src/plan/validate.ts` (incl. implicit-dependency check added after the live run, §12)
- [x] I10 CLI, interactive mode, doctor, exit codes — `src/{cli,interactive,main,logger}.ts`
- [x] I11 tests — 120 tests in `traycer-planner/tests` (`npm test`), ≈96% line / 86% branch coverage (`npm run coverage`)
- [x] I12 renderers — `src/plan/render.ts`
- [x] I13 evaluation harness — `eval/` (results in `docs/EVALUATION.md`)
- [x] I14 documentation — `README.md`, `.env.example`
- [ ] Not done: root-level `package.json`/`node_modules` (stray `@google/generative-ai` dependency) left untouched because it is outside the tool and may be used by something not in this checkout; safe to delete if unused.

## 12. Findings during implementation

These were discovered while building and running the new version, and fixed:

| Finding | Evidence | Fix |
|---------|----------|-----|
| Node's `fetch` aborts after 300 s without response headers (`UND_ERR_HEADERS_TIMEOUT`), regardless of XPlan's timeout. Ollama with `stream: false` sends no headers until generation ends, so slow local models failed and were retried (another 300 s). | Live run with `qwen2.5:7b-instruct` on a 4 GB GPU: the third Planner call hit the limit and was retried. | Ollama requests now stream (NDJSON, aggregated); undici timeouts are classified as non-retryable timeouts; the response body is read under the same deadline. Tests cover stalled bodies, mid-stream errors, truncated streams. |
| Retrieval missed `validation.ts` for "Validate email…": the stemmer did not conflate `validate`/`validation`, and path matches had flat weight. | Failing retrieval test. | Derivational suffix stemming; path matches weighted by inverse path frequency with a basename bonus. |
| Search terms from the model included `src`, `return`, `rout`, matching nearly every file. | Verbose ranking output from the live run. | Directory-name and language-keyword stopwords. |
| Import-graph boost summed across seeds, promoting widely imported utilities (logger, types). | `xplan context` on XPlan itself ranked `logger.ts` 7th with no lexical match. | Boost is the maximum over seeds, not the sum. |
| The 7B model produced a plan where T1 uses `validateEmail` but does not depend on T2, which adds it; the reviewer approved it. | Live run output. | New deterministic check: a task that uses a new symbol or modifies a file introduced by another task must depend on it (transitively). Reproduced as a unit test. |

## 13. Second iteration: from "works" to "dependable in daily use"

Selected after the first live runs and a benchmark on a real codebase. Each item fixes an observed failure mode or closes a gap in the end-to-end workflow.

| Item | Why | Where |
|------|-----|-------|
| Detect Ollama context truncation | Ollama drops the start of over-long prompts without an error, so the model may never see its instructions. Now: a token estimate before sending, a reported-token check afterwards, a warning recorded in the result, and a code budget that scales with `num_ctx`. | `src/llm/ollama.ts`, `src/config.ts`, `src/pipeline.ts` |
| `--format handoff` | Plans are increasingly carried out by coding agents. The brief gives dependency-ordered steps, verified file status, detected verification commands, stop rules, and unresolved findings at the top. | `src/plan/render.ts`, `src/repo/project.ts` |
| Real-codebase retrieval benchmark | The 12-file fixture made "recall within budget" nearly meaningless. 8 maintainer tasks on XPlan's own source exposed real gaps. | `eval/tasks-xplan.json` |
| Coordinator vs dependency import boost | The benchmark missed `src/llm/index.ts` (the provider factory) for "add a provider". Files that import several matches are wiring points; files imported by matches are utilities. | `src/repo/retrieval.ts` |
| CLI-flag signal, test-file dampening, signature cards | Goals naming `--flags` missed `config.ts`; test helpers outranked sources; files that don't fit the budget were reduced to bare names. | `src/repo/retrieval.ts`, `src/agents/format.ts` |
| Benchmark leakage fix | The task file containing the goals was itself indexed. | `eval/tasks-xplan.json` (`ignore`) |
| CI + coverage + recall gate | Retrieval changes can regress silently; the gate fails CI when mean recall within budget drops below 90%. | `.github/workflows/ci.yml`, `package.json`, `eval/run-eval.mjs` |

Retrieval results before → after this iteration (goal text only, Ollama default budget):

| Benchmark | recall within budget | recall@3 |
|-----------|---------------------|----------|
| XPlan source, 8 tasks | 88% → 96% | 69% → 85% |
| Fixture app, 6 tasks | 100% → 100% | 75% → 92% |

The "before" figure for the XPlan source includes the leakage bug, so it is approximate. (Recall@3 on the XPlan source later moved to 79% as files were added to XPlan itself; see `EVALUATION.md` §1.) Both benchmarks were also used to diagnose the problems, so treat these as development scores, not held-out results.

## 14. Third iteration: checking the reviewer

A real run (`docs/examples/`, goal "soft delete users") ended `unresolved`. Reading its findings against the code showed:

| Observation | Fix | Where |
|-------------|-----|-------|
| The reviewer "quoted" requirement R3 with text that R3 does not contain, and used it as evidence for a major finding. | **Evidence grounding:** quotes (≥ 20 characters) in reviewer evidence must appear in the goal, requirements, plan, or code context; otherwise the finding is downgraded to minor and labelled. Findings without quotes are unaffected. | `src/agents/grounding.ts`, `src/pipeline.ts` |
| The same two blocking findings repeated word for word for 3 rounds; 2 of the 9 calls changed nothing. | **Convergence:** if a revision leaves the blocking findings unchanged, the loop stops early and records a warning. | `src/agents/grounding.ts`, `src/pipeline.ts` |
| A task's tests pointed to `src/services/userService.test.ts`, which does not exist; the real file is `tests/userService.test.ts`. | **Test-file check:** test paths named in tasks must exist or be created by the plan (minor finding, with a suggestion). | `src/plan/validate.ts` |
| The Creator dropped "hides it from listings" from the requirements. | Not fixed: requirement extraction quality depends on the model. | — |
| In the final full eval, 2 of 3 `unresolved` statuses were reviewer errors: it reported planned-but-not-yet-written symbols and tests as "missing", and an open question as a missing requirement (diagnosis in `EVALUATION.md` §2). | The reviewer prompt now says to judge the plan against the code *after* the plan, and that open questions are not missing requirements. It also lists the files and symbols the plan introduces, computed by the validator against the index, so symbols that already exist are not presented as new. | `src/agents/reviewer.ts`, `src/plan/validate.ts` (`planIntroductions`), `src/pipeline.ts` |

| **My own grounding check misfired on its first real run.** It paired the closing backtick of `` `UserRecord` `` with the opening backtick of `` `listUsers` `` and downgraded a finding that contained no quote at all, and whose concern was real. Found by auditing the run by hand. | Quote marks are now paired strictly in order before the length filter is applied, and ambiguous text yields no quote, so the finding is kept. A regression test uses the exact evidence text from that run. | `src/agents/grounding.ts`, `tests/grounding.test.ts` |

Risk of the grounding check: a reviewer that paraphrases inside quotation marks will have a valid concern downgraded.
This is a deliberate trade-off; downgraded findings are still shown, and they are passed to any further revision.

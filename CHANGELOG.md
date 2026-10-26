# Changelog

## 2.0.0 — 2026-10-26

Complete rework of the original prototype. See `docs/IMPROVEMENT_PLAN.md` for the audit behind each change.

### Breaking
- The three copy-paste chat modes (Creator / Planner / Reviewer) are replaced by one pipeline: `xplan plan "<goal>"`. Running with no arguments in a terminal still opens an interactive session, now with "refine with feedback".
- Removed `executor.ts` (ran shell commands built from model output), `planner.ts` (crashed on first use), `check_models.ts` (replaced by `xplan doctor`), and the demo and smoke scripts.
- Requires Node.js 22 or newer.

### Added
- **Local models via Ollama:** streamed requests, `num_ctx` control, a code budget derived from the window, detection of silent context truncation, a fallback when the model has no tool support, and a remote-host warning.
- **Configurable Gemini model** (the hardcoded `gemini-2.0-flash` has been shut down by Google), using a small REST client with the key in a header. `GEMINI_API_KEY` is accepted; `GOOGLE_API_KEY` still works.
- **Bounded review → revise loop** with an honest final status (`validated` / `unresolved` / `unreviewed`) and exit code 4 for unresolved plans.
- **Schema-validated model output** (Zod) with native JSON-schema output and one repair attempt.
- **Deterministic plan checks:**
  - file existence (and new vs existing), paths outside the repo, secrets files
  - unknown and circular task dependencies, and implicit dependencies (a task using a symbol or file introduced by another task)
  - requirement coverage and missing tests
- **Checks on the reviewer:** quoted evidence that cannot be found in the requirements, plan, or code is downgraded, and the review loop stops early when a revision does not change the blocking findings. Test files named in a plan must exist or be created by it.
- **Retrieval with explanations:**
  - lexical signals (paths, symbols, content with BM25 weighting)
  - import-graph coordinator boost and CLI-flag detection
  - `@path` pinning
  - line-numbered excerpts within a budget, and signature cards for files that don't fit
- **Bounded, read-only tool exploration** (`list_files`, `read_file`, `search_code`) over the in-memory index.
- **New commands and output:** `xplan context` (what would be sent, and why, without a model), `xplan doctor`, and `--format json|handoff`. `handoff` is a step-by-step brief for coding agents that includes the project's verification commands.
- **Safety:**
  - repository confinement; symlinks are never followed
  - sensitive files are never read
  - secret redaction in prompts, logs, and errors
- **Resilience:** timeouts, cancellation (Ctrl+C), bounded retries with backoff, and `Retry-After` support.
- **Quality checks:**
  - 120 tests using `node:test` (about 96% line coverage)
  - two retrieval benchmarks with a CI regression gate
  - a full-pipeline evaluation harness
  - a GitHub Actions workflow

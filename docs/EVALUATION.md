# XPlan evaluation

Measured on 2026-10-26. Raw results are in `traycer-planner/eval/results/`. Real example output, with a hand review,
is in [`examples/`](examples/).

```bash
cd traycer-planner
npm run eval:retrieval                                                                   # no model, CI gate
node eval/run-eval.mjs --provider ollama --model qwen2.5:7b-instruct --max-revisions 1   # full pipeline
```

**Model setup for every run below:**
- `qwen2.5:7b-instruct` (Q4_K_M) on Ollama 0.17.4
- laptop RTX 3050 with 4 GB (about 52% of the model on CPU, 48% on GPU)
- `num_ctx` 16384, seed 7

## 1. Retrieval benchmarks (deterministic, no model)

The goal text only, without the Creator's hints, under the Ollama default budget of 8 files and about 26,000 characters.

| Benchmark | Tasks | recall within budget | recall@3 | unrelated files in context |
|-----------|-------|---------------------|----------|----------------------------|
| XPlan's own source (≈40 TS files) | 8 | **96%** | **79%** | 0 |
| Fixture app (12 files) | 6 | 100% | 92% | — |

Per-task numbers come from `npm run eval:retrieval`. The only miss within budget is `config.ts` for "reviewer-model".
Recall@3 on XPlan's source was 85% right after the second iteration. It is 79% now only because the corpus is XPlan
itself and has grown: for "nested-gitignore", a newly added file now outranks one of the two expected files in the
top 3, though both are still in the context. The ranking algorithm has not changed since. A benchmark built on a
codebase that is still changing drifts like this, which is why the CI gate measures recall within budget rather
than recall@3.

**Caveats:**
- These are *development* scores: the benchmarks were used to find the retrieval problems that were then fixed.
- There are only 14 tasks, and the expected-file lists are my judgement.
- On the fixture, "within budget" is nearly trivial (12 files against a budget of 8).
- CI fails if mean recall within budget drops below 90%.

## 2. Full pipeline: final run (all 6 fixture tasks)

| Task | Status | Expected files touched | Unrelated files | Calls | Time |
|------|--------|-----------------------|-----------------|-------|------|
| email-validation | validated | 50% | 0 | 5 | 118 s |
| pagination | validated | 100% | 0 | 5 | 154 s |
| soft-delete | unresolved | 100% | 0 | 7 | 444 s |
| configurable-port-loglevel | validated | 50% | 0 | 7 | 381 s |
| rate-limiting | unresolved | 100% (and created the middleware file) | 0 | 7 | 499 s |
| health-db-status | unresolved | 100% | 0 | 7 | 266 s |
| **Total** | **3/6 validated** | **83%** | **0** | 38 | 31 min |

The earlier full run, on the build before the second and third iterations, scored 100% expected-file recall, 0 unrelated files, and 3/6 validated, with a different 3 tasks validated.

### Finding-by-finding diagnosis

**Why the three `unresolved` plans were blocked** (each finding checked by hand against the fixture code):

| Task | Blocking finding | Verdict |
|------|------------------|---------|
| soft-delete | Modifies `src/models/user.ts`, which does not exist (validator) | **Real.** The planner invented a file. |
| soft-delete | Listings don't exclude soft-deleted users | **Real.** It's explicit in the goal. |
| soft-delete | "`UserRecord` is not defined anywhere" | **False.** `src/db/client.ts` defines it. |
| rate-limiting | "Reset-at-minute requirement not covered" | **Noise.** The evidence is an *open question*, not a requirement. |
| health-db-status | "`getUserCount` is missing from the codebase" | **Noise.** The plan *creates* it. |
| health-db-status | "No tests for `getUserCount` found" | **Noise.** The tests are planned, not existing. |

So **1 of the 3 `unresolved` statuses was justified**. The other 2 came from one repeatable reviewer error: judging
the plan against the current code instead of the code after the plan, and treating open questions as missing
requirements. The fix (§3) is to say this explicitly in the reviewer prompt and pass the list of files and symbols
the plan introduces, which the validator already computes against the index.

**The two 50% recalls:**
- *email-validation* put the check inline in the route instead of in `utils/validation.ts`. That is a legitimate
  design; my expected-file list was too strict.
- *configurable-port-loglevel* never touched `requestLogger.ts`, the code that has to honour the log level. That is a real miss.

**Unrelated files:** none across all 12 plans in the two full runs. The rate-limiting plan did add rate-limit tests
for both routes, which is broader than needed but not wrong.

## 3. Reviewer fix: controlled check

I reran the three `unresolved` tasks on the build with the reviewer fix. soft-delete was the control: its findings
were *justified*, so a good fix must keep it blocked.

| Task | Before the fix | After the fix (status still `unresolved` for all three) |
|------|----------------|--------------------------------------------------------|
| soft-delete (control) | Justified: invented file, missing listing exclusion | **Still justified:** modifies the non-existent `src/models/user.ts`, and no tests for listing exclusion. Real problems were not suppressed. |
| rate-limiting | Noise: an open question reported as a missing requirement | **Now justified:** modifies `src/server.test.ts`, which does not exist (should be `create`). The open-question noise did not recur. |
| health-db-status | Noise: planned `getUserCount` and its tests reported as missing | **Still noise:** "database unavailability is a requirement" (its own evidence calls it an open question), and a claim built on a search for a function name the plan never used. The planned-vs-existing error did not recur. |

**Result:** justified `unresolved` statuses went from 1/3 to 2/3. The planned-vs-existing error went from 2 findings
to 0. The open-question error went from 1 finding to 1 (in a different task). With three tasks and the run-to-run
variance in §4, this is encouraging but not conclusive.

**Remaining reviewer weaknesses with this 7B model:**
- It restates findings from the automated validation despite being told not to. This clutters the output but does
  not change the status, because the validator finding already blocks.
- It still sometimes treats open questions as requirements.
- It sometimes builds a claim on a `search_code` call that searched for the wrong thing.

Raw results: `eval/results/reviewer-fix-check.log` and the JSON beside it.

## 4. Run-to-run variance

Ollama is not fully deterministic when a model is split across CPU and GPU, even with a fixed seed.
- The same soft-delete goal gave three different plans: 9 calls / unresolved, 7 / validated, 5 / validated.
- The two full runs validated different subsets of tasks.

Treat single-run numbers here as indicative only. Every configuration needs repeated runs before its numbers can be compared.

## Not evaluated
- **Gemini:** no API key was available; it is covered only by mocked HTTP tests.
- **Larger local models,** and repositories much larger than about 40 files.
- **Whether `--format handoff` briefs lead coding agents to correct code.** This would need a harness that applies the changes and runs the tests.

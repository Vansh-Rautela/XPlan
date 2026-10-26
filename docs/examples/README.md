# Example: real output from a local 7B model

Unedited output from a single run. The only changes are machine-specific paths, replaced with relative ones.

```bash
cd traycer-planner
OLLAMA_MODEL=qwen2.5:7b-instruct node dist/main.js plan \
  "Make deleting a user a soft delete that keeps the record but hides it from listings" \
  --repo tests/fixtures/sample-app --seed 7 -o ../docs/examples/soft-delete.json
```

Setup: `qwen2.5:7b-instruct` (Q4_K_M) on Ollama 0.17.4, laptop RTX 3050 with 4 GB, default settings.
Result: `validated` after 5 model calls in 158 s.

| File | What it is |
|------|------------|
| [`soft-delete.md`](soft-delete.md) | The Markdown plan (default output) |
| [`soft-delete.handoff.md`](soft-delete.handoff.md) | The same plan as a brief for a coding agent (`--format handoff`) |
| [`soft-delete.json`](soft-delete.json) | The full machine-readable result (`schemaVersion: 1`) |
| [`run.log`](run.log) | The progress output from stderr |

## How good is this plan? (hand review against the fixture code)

**Correct**
- It targets the right layers: `src/services/userService.ts` and the `DELETE` handler in `src/routes/users.ts`, and
  switches the route from the hard `deleteUser` to a soft delete. That is the core of the goal.
- The ordering is right (T2 depends on T1), and both files are verified as existing.
- It used the read-only tools sensibly: `search_code("deleteUser")`, then read the route file.
- It includes a test that soft-deleted users are not returned by `listUsers`.

**Missing or wrong**
- Nothing adds `deletedAt` to `UserRecord` in `src/db/client.ts`, although requirement R2 depends on that field.
- No task changes `listUsers` to filter out deleted users, although a "done when" criterion requires it.
- The Creator turned "hides it from listings", which is explicit in the goal, into an *open question* instead of a
  requirement. The reviewer approved anyway.

**What this shows:** `validated` means the automated checks and the reviewer found no blocking problems. It does
not mean the plan is complete. With a 7B model, the targeting and structure are reliable, and the completeness
review is not. This is why the handoff brief tells the implementer to check the plan's claims against the code,
and why open questions are listed separately. A larger model is expected to catch these gaps, but this has not
been measured.

## Run-to-run variation

Three runs of this goal with the same seed produced different plans, because Ollama is not fully deterministic when
a model is split across CPU and GPU:
- 9 calls, `unresolved`
- 7 calls, `validated`
- 5 calls, `validated` (this one)

Two of those runs also exposed problems that have since been fixed (see `docs/IMPROVEMENT_PLAN.md` §14):
- a reviewer quoting a requirement that does not exist
- identical findings repeated across rounds
- a test path that does not exist
- a bug in the first version of the quote check

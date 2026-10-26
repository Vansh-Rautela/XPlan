# xplan

A command-line tool that plans code changes before you make them. It turns a goal into requirements, a file-level
plan, an automated review, and an honest pass/fail status, using Gemini or a local Ollama model. It never edits your code.

```bash
npm install && npm run build && npm link
xplan doctor
xplan plan "Add pagination to GET /users" --repo ./my-app            # Markdown plan
xplan plan "Add pagination to GET /users" --repo ./my-app -f handoff  # brief for a coding agent
xplan context "Add pagination to GET /users" --repo ./my-app         # what would be sent, and why (no model)
```

Full documentation (configuration, Ollama setup, exit codes, security, troubleshooting) is in the
[repository README](../README.md). Evaluation results are in [docs/EVALUATION.md](../docs/EVALUATION.md),
and real example output is in [docs/examples](../docs/examples).

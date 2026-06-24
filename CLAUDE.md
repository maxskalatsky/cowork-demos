# CLAUDE.md

## General rules

**Work in a full loop.** Make the change, verify it works, then stop. Never hand back half-done work.

**Commit and push after every completed task.** Stage only the relevant files. Write a commit message that says what changed and why. Push to `main`.

**Never touch the production worker.** The production worker at `sa-ai-audit.saaudit.workers.dev` is off-limits. Do not deploy to it, modify its config, or rotate its secrets under any circumstances.

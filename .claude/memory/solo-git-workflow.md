---
name: solo-git-workflow
description: Solo dev — routine work commits straight to develop, no feature branch or PR needed
metadata:
  node_type: memory
  type: feedback
---

This is a solo project. Routine work commits **straight to `develop`** with Conventional Commit messages — no feature branch, no PR. Only reach for a `feat/<task>` / `fix/<task>` branch when a change is big or risky enough to want it isolated.

`main` stays production-only: release by merging `develop` (or a `hotfix/*` branch) into `main`, tag `vX.Y.Z` + GitHub Release, then `npm run release`. That part is unchanged.

**Why:** the user is the only developer; the branch-per-task + PR ceremony added friction with no review benefit.

**How to apply:** when asked to commit/push, commit directly on `develop` and `git push origin develop` unless the user says otherwise. Source of truth for the full workflow is CLAUDE.md ("Branching (solo dev)") and [[project-clasp-deploy]] / DEPLOY.md.

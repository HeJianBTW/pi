# Pi Teamwork AMaster Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the AMaster provider correctness gaps called out in PR review before further functional validation.

**Architecture:** Keep `@amaster.ai/pi-teamwork` as a thin adapter over the AMaster Employee CLI. Workspace selection must be an explicit CLI argument, session auth must be scoped to child-process env without mutating global env or argv, parser failures must surface as errors, and mapped issue metadata must preserve provider context after redaction.

**Tech Stack:** TypeScript, Vitest, Pi extension API, AMaster Employee CLI.

---

## Review Checklist

- [x] Route workspace/company IDs into AMaster CLI commands instead of relying on the active profile.
- [x] Replace global `process.env.AMASTER_BOARD_API_KEY` mutation with per-child AMaster CLI auth env.
- [x] Fail strictly when create/comment CLI responses do not contain real result objects or IDs.
- [x] Stop converting malformed CLI responses into empty workspace/issue/project/user lists.
- [x] Preserve raw AMaster issue metadata/custom fields after sensitive-field redaction.
- [x] Parallelize status probes and keep workspace listing independent from runtime status.

## Tasks

### Task 1: Add Regression Coverage

**Files:**
- Modify: `packages/pi-teamwork/src/index.test.ts`

**Steps:**
1. Add tests proving non-current `workspaceId` becomes `-C <workspaceId>` for list/get/create/update/comment/project queries.
2. Add a test proving session API keys are passed via per-child env and do not touch global env or CLI argv.
3. Add tests proving malformed list/comment responses throw instead of returning empty or unknown IDs.
4. Add a test proving mapped issues retain metadata/custom fields and redact sensitive fields.
5. Run the targeted AMaster adapter tests and confirm these tests fail before implementation.

### Task 2: Fix AMaster Adapter Semantics

**Files:**
- Modify: `packages/pi-teamwork/src/adapters/amaster.ts`
- Modify: `packages/pi-teamwork/src/types.ts`

**Steps:**
1. Build common args without auth tokens, and append company args per command invocation.
2. Add workspace-aware helpers that convert `workspaceId` to `-C <workspaceId>` when meaningful.
3. Implement `company list --json` in `listWorkspaces()` and avoid calling `status()`.
4. Replace loose JSON parsing with required JSON helpers for arrays and objects.
5. Require a real comment ID for `issue comment` responses.
6. Merge raw metadata/custom fields plus unmodeled issue fields into `Issue.metadata`, using existing redaction.
7. Add workspace parameters to AMaster `user_directory_list`.
8. Parallelize employee/runtime probes in `status()`.

### Task 3: Verify And Update The PR

**Files:**
- Modify: `docs/plans/2026-06-16-pi-teamwork-amaster-review-fixes.md`

**Steps:**
1. Run `pnpm --filter @amaster.ai/pi-teamwork test`.
2. Run `pnpm --filter @amaster.ai/pi-teamwork typecheck`.
3. Run `pnpm --filter @amaster.ai/pi-teamwork build`.
4. Run Biome on changed package files.
5. Run `git diff --check` and a targeted scan for the removed remote IP and obvious secret literals.
6. Update this checklist with completed items and verification notes.
7. Amend the PR commit and push with `--force-with-lease`.

## Verification Notes

- 2026-06-16: Added regression coverage for workspace `-C` routing, `company list --json`, per-child auth env, strict malformed response failures, required comment IDs, issue metadata preservation, and AMaster read-only user-directory workspace filters.
- 2026-06-16: Confirmed the new tests fail against the previous implementation: auth used global env, workspace IDs were ignored, workspace list came from `status()`, comment/list failures were hidden, and metadata was dropped.
- 2026-06-16: `pnpm --filter @amaster.ai/pi-teamwork test` passed with 67 tests.
- 2026-06-16: `pnpm --filter @amaster.ai/pi-teamwork typecheck` passed.
- 2026-06-16: `pnpm --filter @amaster.ai/pi-teamwork build` passed.
- 2026-06-16: `pnpm exec biome check packages/pi-teamwork/src/adapters/amaster.ts packages/pi-teamwork/src/index.ts packages/pi-teamwork/src/types.ts packages/pi-teamwork/src/index.test.ts` passed.
- 2026-06-16: `git diff --check` passed.
- 2026-06-16: Targeted scans found no removed remote IP literal and no real bearer/connector/db/cookie secret pattern in changed implementation/docs files.
- 2026-06-16: Removed the AMaster-only `agent_list` LUI tool path from pi-teamwork registration, provider types, adapter implementation, README, tests, and stale plan wording. `user_directory_list` remains as the assignable-user discovery tool.

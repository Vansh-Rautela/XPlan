# Implementation brief: Implement soft deletion for user records by marking them as deleted without physically removing them from the database.

You are implementing a reviewed plan in the repository at `tests/fixtures/sample-app`. Goal: Make deleting a user a soft delete that keeps the record but hides it from listings

## Rules
- Implement the steps in order. Do not start a step before the steps it depends on are complete.
- Change only the files listed for each step unless a change is strictly required to make it work; if so, say which file and why.
- Follow the existing code style, structure, and test conventions of the files you edit.
- After each step, run the verification commands. If they fail, fix the cause before continuing; do not weaken or delete tests to make them pass.
- Do not decide open questions silently: ask the user, or take the most conservative option and state that you did.
- Statements below about the existing code are from a model and may be wrong. Check them against the actual files before relying on them.

## Verification commands
- `npm test`

## Requirements
- **R1** The `UserService` should provide a method to mark a user as deleted.
- **R2** When a user is soft-deleted, their `deletedAt` field should be set to the current timestamp.

The work is complete when:
- Calling the delete method on the UserService for a specific user updates their `deletedAt` field.
- The deleted user's record remains in the database but is not returned by any listing queries.

## Constraints
- Soft deletion should only be applied to users, not other entities like posts or comments.

## Out of scope — do not implement
- Hard deletion of user records
- Updating UI or notifications for deleted users

## Assumptions to confirm
- The `UserService` has access to the necessary database operations and fields.

## Steps

### Step 1 (T1): Add soft delete functionality to UserService

Modify the `UserService` to support marking users as deleted by setting their `deletedAt` field.

Why: The existing `deleteUser` method only removes records, which does not satisfy the requirement for soft deletion. Adding a new method will allow us to mark users as deleted without removing them from the database.

Files:
- `src/services/userService.ts` (modify existing file) — `deleteUser`, `UserService`: Add `softDeleteUser` and update `deleteUser` to mark users as deleted.

Tests to add or update:
- src/services/userService.ts: should update the user's deletedAt field when softDeleting a user
- tests/userService.test.ts: should test that softDeleted users are not returned by listUsers

Done when:
- Calling the `softDeleteUser` method on the UserService for a specific user updates their `deletedAt` field.
- The deleted user's record remains in the database but is not returned by any listing queries.

### Step 2 (T2): Update usersRouter to use soft delete

Requires: T1 completed.

Modify the `usersRouter` to call the new `softDeleteUser` method from UserService.

Why: The existing `deleteUser` endpoint only removes records, which does not satisfy the requirement for soft deletion. Updating this endpoint will ensure that soft deletion is used instead.

Files:
- `src/routes/users.ts` (modify existing file) — `usersRouter`, `deleteUser`: Replace `deleteUser` with `softDeleteUser` in the delete route.

Tests to add or update:
- src/routes/users.ts: should test that softDeleted users are not returned by listUsers

Done when:
- The `usersRouter` uses the new `softDeleteUser` method from UserService.

## Risks to watch
- Potential bugs in the implementation of `softDeleteUser` could lead to incorrect soft deletion. → Thoroughly test the `softDeleteUser` method and its integration with other parts of the application.
- The existing tests might not cover all edge cases for soft deletion, leading to potential regressions. → Review and update existing tests to ensure they cover all relevant scenarios.

## Open questions — ask before deciding
- How should soft-deleted users be excluded from listing queries?

## When you finish
Summarise what you changed per step, the verification results, and any deviation from this brief.

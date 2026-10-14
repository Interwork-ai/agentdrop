<!-- Thank you! The rules are in CONTRIBUTING.md and AGENTS.md; this list is a reminder, not a gate. -->

## What and why

## Checks

- [ ] `pnpm verify` passes (database tests ran with `TEST_DATABASE_URL`, not skipped)
- [ ] Dashboard or API change: `pnpm e2e` passes, and a new key page or button has a journey step
- [ ] A fixed bug has a test that failed before the fix
- [ ] A change people, operators or agents can notice has a line in `CHANGELOG.md` under Unreleased
- [ ] Every supported agent client gets the same behaviour (docs/HARNESSES.md), or this does not touch clients
- [ ] No secrets, real addresses, real names or personal setup (docs/PUBLIC_REPOSITORY.md)

# Working on FitDownloader

## Start here

1. Read `IMPROVEMENT_PLAN.md`, particularly **Resume checkpoint**, **Decisions and constraints**, and the current phase.
2. Inspect `git status --short`, the current branch, and recent commits before editing. Preserve unrelated user changes.
3. Check whether the recorded baseline still matches the checkout. Inspect the relevant source and tests; do not rely on a previous chat's claims.
4. Use the plan's next task as the starting point when the user asks to resume the plan. Follow newer user instructions if scope or priorities change.

## Project and scope

- Primary repository: `https://github.com/AlexanderArmua/FitDownloader` (`origin`).
- Original project: `https://github.com/axel-devs/FitDownloader` (`upstream`).
- Upstream contribution: `https://github.com/axel-devs/FitDownloader/pull/2`. This is context, not the default destination for new work.
- Work on the user's fork. Use a focused branch for implementation; do not rewrite existing history or change the upstream PR without current authorization.
- Do not infer permission to push, publish releases, create additional PRs, install the extension, or start large real downloads merely from this file. Follow the active user's request and existing session authorization.
- No sub-agent delegation is required by these instructions.

## Implementation order

- The user wants tests and reliable validation before production behavior changes.
- Start with truthful application coverage, realistic mocks, and characterization tests. Do not perform a broad architecture or UI rewrite first.
- For each recovery bug, reproduce it with a focused regression test, fix it, and show that the regression and existing suite pass.
- Keep default-branch CI green. Temporary failing tests belong in the local red/green cycle, not as an indefinitely failing default-branch suite. Do not conceal defects with unconditional skips or misleading coverage thresholds.
- Work in small reviewable steps. Establish a useful safety net, then fix recovery; do not delay important fixes until every possible test or a percentage target is complete.

## Behavior to preserve

- Resolve supported downloads without opening ad pages or executing remote scripts.
- Keep HTTPS enforcement, exact host checks, isolated page scanning, and narrow production permissions.
- Respect browser/host verification. Never disable browser security or automatically solve verification challenges.
- Keep concurrency configurable. It currently applies per batch; a global cap is a separate planned feature.
- Preserve manual file selection and standard Chrome download-manager behavior.
- Protect persisted download state and avoid starting duplicate downloads during recovery.

## Checks

- Use Node 24 (at least 24.8.0), then `npm ci --ignore-scripts` on a fresh checkout.
- Run `npm run check` for scoped lint, manifest validation, unit/DOM tests and application coverage. Run `npm run test:browser:install` once and `npm run test:browser` for real Chromium tests. See `tests/README.md` for scope and isolation details.
- `git diff --check` should pass before a handoff or commit.
- TEST-01 is implemented: use the c8-based `npm run test:coverage`, not the raw Node coverage command. All application files, including unexecuted scripts, must stay in the denominator; integrity checks reject empty/missing-file reports.
- `npm run test:regressions` intentionally fails on four tracked recovery defects. These are executable specifications, not skipped tests or passing coverage. Fix each regression, move it into the normal lifecycle suite, and remove the duplicate failing specification. Keep TEST-04 open until all four are fixed.
- CI includes an explicitly non-blocking known-defect job; remove that exception when recovery specifications all pass. Report passing checks and known failing checks separately.
- Tests must not depend on live file-host uptime, advertising, challenge pages, or downloading archives. Use local fixtures and tiny test downloads for browser integration tests.
- After development commands and CI exist, use the actual repository commands and update this section if they replace the baseline.

## Before ending work

Update `IMPROVEMENT_PLAN.md` in the same change as implementation:

- Check only tasks whose acceptance criteria are met.
- Set **Resume checkpoint** to the exact next task, current branch/commit, changed files, validation results, and blockers or pending decisions.
- Add a dated work-log entry describing the result and any tradeoffs.
- Distinguish automated tests, manual user confirmation, and unverified assumptions. Never describe mocked host responses as live compatibility evidence.
- Keep the task IDs stable; record deferred or superseded work rather than silently deleting it.

The plan is the durable source of progress. A future chat must be able to resume from the files alone.

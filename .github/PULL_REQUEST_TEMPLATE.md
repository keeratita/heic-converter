## What changes

<!-- What it does and why. Link the issue. -->

Fixes #

## How it was verified

<!-- Not "tests pass" — what did you run, and what did you see break when the change
     was reverted? If a test cannot fail, it does not belong in the PR. -->

- [ ] `npm run lint`
- [ ] `npm run test:coverage` (thresholds enforced)
- [ ] `npm run build` then `npm run test:e2e` — if anything under `src/` shipped
- [ ] `npm run verify:wasm` — if `src/wasm/` changed (plus `npm run wasm:hashes`)
- [ ] `npm run check:scripts` — if a dependency was added or bumped

## Risk notes

- Runtime dependencies added? **must be none**
- Any `eval` / `new Function` path introduced? **must be none** (CSP guarantee)
- Generated files touched (`src/wasm/**`, `dist/**`)? should be regenerated, not edited
- Public API or error-code surface changed? must be additive

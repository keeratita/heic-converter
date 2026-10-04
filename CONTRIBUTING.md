# Contributing

Thanks for taking the interest. This is a small library with two hard constraints, and they decide most design arguments before anything else does:

1. **Zero runtime dependencies.** Nothing may be added to `dependencies`.
2. **No dynamic code execution.** The decoder is compiled with `-s DYNAMIC_EXECUTION=0`, so `eval()` and `new Function()` never appear. This is the reason the package exists — it converts HEIC under a strict CSP.

AI agents and contributors alike should read [AGENTS.md](AGENTS.md) first: it maps the source, the WASM build, and the traps.

## Getting set up

```bash
git clone https://github.com/keeratita/heic-converter
cd heic-converter
npm ci
npm run build     # dist/ — required before the test suites that read it
npm test
```

Node `>=20`. Building the WASM decoder needs Docker and is only necessary when `build-wasm/` changes:

```bash
npm run build:wasm   # then: npm run wasm:hashes
```

## Before you open a PR

```bash
npm run lint
npm run typecheck       # src/ and test/ — the tests are excluded from tsconfig.json
npm run build && npm run test:coverage   # thresholds are enforced; the real-decode suites read dist/
npm run verify:wasm
npm run check:scripts
npm run test:e2e
```

- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`, optional scope). A `commit-msg` hook enforces it; a `pre-commit` hook runs the linter and the typecheck.
- **Never edit generated files**: `src/wasm/wrapper/heic-decoder.js`, `src/wasm/public/heic-decoder.wasm`, anything under `dist/`, or the C++ under `build-wasm/src/`. Regenerate with `npm run build:wasm`, then `npm run wasm:hashes`.
- **A WASM change is not done until it has been executed.** A smaller `heic-decoder.wasm` that fails to instantiate is worse than a bigger one; the real-decode and browser E2E suites must pass against the rebuilt artifact pair.
- **New behaviour needs a test that fails without it.** Prove a new assertion by breaking the source it guards, then reverting.
- Public API stays small and backwards compatible; new error codes are additive.
- If `npm run check:scripts` fails, a dev dependency now runs code at install time. Review the script, then `npm run check:scripts -- --write`.

## Reporting something sensitive

Use private vulnerability reporting — see [SECURITY.md](SECURITY.md).

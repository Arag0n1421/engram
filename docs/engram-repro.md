# Engram clean replay proof

Use Node 24.x with the repository's `package-lock.json`. The clean verifier copies the source into a fresh temporary directory, omits local state, `.env` files, installed dependencies, generated server/client output (`.output`, `.next`, `.nitro`, `.vercel`, `dist`), and work artifacts, then runs:

1. `npm ci --no-audit --no-fund` (add `--offline` only when `ENGRAM_CLEAN_OFFLINE=1`)
2. `npm test`
3. `npm run typecheck`
4. `npm run build`

The verifier takes npm's active CLI from the `npm run verify:clean` environment, puts the active Node binary directory first on `PATH`, and uses npm's default cache or the optional `npm_config_cache` value supplied when invoking it. It sets replay mode, disables inference and Eve telemetry, and points npm at separate empty user/global config files. Child processes receive only the npm CLI, `PATH`, cache and temporary-directory settings, and replay flags. Public package downloads may occur during a normal `npm ci`; this is separate from FDA, Zetaris, Meterless, and model services. To require a warmed cache instead, set `ENGRAM_CLEAN_OFFLINE=1`; the offline install then fails if any locked package is missing from the cache.

Run it with Node 24 active:

```sh
npm run verify:clean
```

If using a separate npm cache, set `npm_config_cache` for this command.

For a passing run only, `ENGRAM_CLEAN_EXPORT_DIR` may name a new path for an export of `.output`, `web/dist`, a SHA-256 manifest for the clean source copy, and `proof.json`. The destination must not already exist. This option is handled by the verifier itself and is not passed to its child commands.

This clean run is a dependency, test, typecheck, and build check for the local replay. It does not call FDA, Zetaris, Meterless, or a model. It does not establish remote view registration, live source freshness, model end-to-end correctness, or physical handling of any product.

## Latest clean proof — 23 October 2026

Root's latest clean replay proof passed with Node 24.22.1. The proof ran offline `npm ci`, tests, typecheck and production build with replay enabled and inference disabled. All 140 tests passed. The proof record is `/private/tmp/engram-clean-export-20261023-10/proof.json`; the verifier reports `npmCache: "active npm cache; offline install only"`. This verifies the locked install against packages already present in that active cache. It is not a fresh-cache install. Root initially matched all 130 manifest files to the clean export before this documentation refresh. The final gate confirmed 124 program files unchanged, excluding six documentation files; only documentation was updated after the build. No FDA, Zetaris, Meterless or model request was made by this replay proof.

The 23 October 140-test proof supersedes the 97-test result as the latest full gate. The earlier proof remains useful dated evidence: Node 24.22.1/npm 10.9.8, public downloads into a fresh cache, `npm ci` installing 154 packages, 97 tests, typecheck and production build all passed. Its output is `/private/tmp/engram-clean-proof-20261023-2.log`, with exported artifacts and `proof.json` under `/private/tmp/engram-clean-export-20261023-2/`. An earlier fresh-cache attempt stopped at `npm ci` because package.json and package-lock.json disagreed about `undici@7.29.0`; that mismatch was later reconciled. Its log is `/private/tmp/engram-clean-proof-20261023.log`.

## Accepted local state backup

After the two actual live/UI cases passed, root preserved the isolated acceptance workspace plus H-MEM state and ledger as three hashed files under ignored `state/engram-demo-final`. The hashes are recorded in `../work/engram-demo-backup-evidence.json`. This is simulated operator acceptance state, kept separately from the original live workspace; the original two receipt IDs and state hash were rechecked unchanged. State and credentials remain excluded from the clean replay proof.

Root's final source, state, backup, direct-runtime readback and UI checks passed on 23 October 2026 and are recorded in the [final verification report](../../outputs/engram-build-verification.json). The final 08:04:26 UTC readback is separate from the actual model runs around 02:xx UTC.

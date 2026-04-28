# Releasing

Versioning + npm publishes are automated via [changesets](https://github.com/changesets/changesets) and a [trusted-publisher](https://docs.npmjs.com/trusted-publishers) OIDC flow on push to `main`. The release pipeline lives in [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Routine release flow

1. Make code changes in a `packages/<pkg>/` directory.
2. Run `pnpm exec changeset` and answer the prompts — pick affected packages, bump level, summary.
3. Open a PR. The `Check packages` workflow gates README + manifest drift.
4. On merge to `main`, the `Release` workflow opens (or updates) a `chore(release): version packages` PR that consumes the pending changesets, bumps versions, and writes CHANGELOG entries.
5. Merge the version PR. The post-merge `Release` run publishes every newly-bumped package to npm via the trusted-publisher OIDC flow with provenance attestations.

## Adding a new adapter package

The release pipeline assumes each package is already discoverable on npm and has a configured trusted publisher. If either is missing for a never-before-published package, the OIDC publish silently fails with `404 Not Found - PUT https://registry.npmjs.org/<scope>%2f<name>` (npm's wording for "this OIDC identity is not authorized to publish here") — see the [v0.2.1 incident on `@superbiche/copilot-paperclip-adapter`](../.claude/progress-copilot-adapter.md) for a worked example.

To avoid that, bootstrap the package on npm with a stub release **before** writing any real code, then wire up the trusted publisher, then ship the real `0.1.0`.

### Bootstrap order (mandatory)

1. Scaffold the package directory: `packages/<pkg>/` with at minimum `package.json` (version `0.0.1`, `name: "@superbiche/<pkg>-paperclip-adapter"`, `description`, `license: "MIT"`, `files: ["dist", "README.md"]`, `paperclip.adapterUiParser: "1.0.0"`) and a `README.md` that explains what the package will wrap. No `src/`, no `dist/`, no `.changeset/` yet.
2. Publish `0.0.1` manually from your machine to claim the npm name:
   ```bash
   cd packages/<pkg>
   npm publish --access public
   ```
3. Configure the npm trusted publisher BEFORE the first OIDC publish:
   - Visit `https://www.npmjs.com/package/@superbiche/<pkg>-paperclip-adapter/access`.
   - Under **Publishing access**, add a Trusted Publisher entry:
     - Publisher: `GitHub Actions`
     - Organization or user: `superbiche`
     - Repository: `paperclip-adapters`
     - Workflow filename: `release.yml`
     - Environment name: leave blank
4. Add the package to the [`README.md`](../README.md) "Packages" table — the `Check packages` workflow will fail until you do.
5. **Now** start writing real code. The first real-content release is `0.1.0`, shipped through the normal changeset flow.

If you skip step 3, the post-merge `Release` workflow will fail with the 404 above and v0.1.0 will not publish until OIDC is configured retroactively.

## Why this is necessary

- npm trusted publishers must be explicitly configured per-package — the config doesn't auto-extend to new packages in the same monorepo, even when the workflow file is identical.
- A 404 from npm on `PUT /<package>` looks like "package doesn't exist" but actually means "you don't have authority to publish here." That ambiguity is what costs debugging time on first-publish failures.
- Claiming the npm name with `0.0.1` is also defensive: it prevents typosquatting and makes the package URL valid for README badges before any code ships.

## When release fails

- Read the workflow logs first. The most common failure modes:
  - **404 PUT on every OIDC publish, regardless of trusted-publisher config** → the runner's bundled npm is too old. Trusted-publisher OIDC requires **npm 11.5.1+**. Node 20 and Node 22 ship npm 10.x; only Node 24+ ships npm 11. The release workflow pins `node-version: 24` for this reason — `engines.node: ">=20"` controls runtime, not the CI runner. Symptom in the log: provenance attestation signs successfully but the registry PUT 404s anyway. Self-upgrading via `npm install -g npm@latest` mid-run breaks because npm overwrites its own modules — bump the runner's Node version instead.
  - **404 PUT on first OIDC publish for a specific new package** → trusted publisher not configured. Fix per "Bootstrap order" step 3, then `gh run rerun <id> --failed`.
  - **`packages failed to publish: ... is not in this registry`** → same as above two; npm's wording is identical for "not authorized," "doesn't exist," and "tokenless OIDC handshake never completed."
  - **`Check packages` failed in release.yml** → README or `paperclip.adapterUiParser` drift. Fix the underlying issue, push, the workflow re-runs.
- Manual `npm publish` is a last resort, not a workaround. Each manual publish breaks provenance attestation and skips the OIDC chain we rely on for supply-chain integrity (per Berceuse's threat model).

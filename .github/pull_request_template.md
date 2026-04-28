<!-- Thanks for contributing! Keep the PR description tight; bullets over prose. -->

## What changed

-

## Why

-

## Verification

- [ ] `pnpm -r build` clean
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm -r test` green
- [ ] `pnpm check:packages` green
- [ ] Added a changeset (`pnpm exec changeset`) for any user-visible package change

## New package? (delete this section if N/A)

If this PR adds a new directory under `packages/`:

- [ ] Bootstrap publish (`0.0.1`) of the empty package was done manually to claim the npm name (see [`docs/RELEASING.md`](../docs/RELEASING.md)).
- [ ] npm trusted publisher is configured for the new package on npmjs.com (`Publishing access → Trusted Publisher → release.yml @ superbiche/paperclip-adapters`).
- [ ] New row added to [`README.md`](../README.md) "Packages" table.
- [ ] `paperclip.adapterUiParser` field set in the new `package.json`.

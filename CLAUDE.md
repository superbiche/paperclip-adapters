# paperclip-adapters — Claude working notes

Monorepo for external adapters that plug into [paperclipai/paperclip](https://github.com/paperclipai/paperclip) via its external-adapter system. Each `packages/*` directory ships as its own npm package under `@superbiche/*`.

For the project overview, install instructions, and full release flow, read [`README.md`](./README.md). This file is for directives that apply when working in the repo.

## Commands

- `pnpm install` — bootstrap workspace.
- `pnpm -r build` — compile every package via `tsc`.
- `pnpm -r typecheck` — type-only.
- `pnpm -r test` — run vitest in every package.
- `pnpm exec changeset` — record a release intent. Required before merging any change that affects a published package.

## Conventions

- TypeScript ESM. `package.json#type: "module"`.
- Each adapter package depends on `@paperclipai/adapter-utils` for the runtime contract — that package's exported types are the source of truth.
- A new adapter is a new directory under `packages/`. Mirror an existing adapter (`cline-local` or `qwen-local`) for layout: `package.json`, `tsconfig.json`, `src/`, `tests/`, own `README.md`.
- `package.json#paperclip.adapterUiParser` declares the UI-parser ABI version the adapter targets.
- Build artifacts live in each package's `dist/` (gitignored). Don't commit them.

## Releases

Versioning + npm publish are automated via [changesets](https://github.com/changesets/changesets) and a [trusted-publisher](https://docs.npmjs.com/trusted-publishers) OIDC flow on push to `main`. Full process in [`README.md` §Release process](./README.md#release-process). Never run `npm publish` manually; never commit a long-lived `NPM_TOKEN`.

## Authoring gaps in upstream paperclip

Contract gaps discovered while building adapters are tracked in [`docs/authoring-gaps.md`](./docs/authoring-gaps.md), grouped **Active** (branch on `superbiche/paperclip` awaiting upstream review) vs **Deferred** (catalogued, no branch). When a fix merges upstream, move the entry to a closed section with the merged PR link.

## Contributing fixes back to paperclipai/paperclip

Before opening a PR against [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip), read its `.github/PULL_REQUEST_TEMPLATE.md` (or `CONTRIBUTING.md` if no template file) and apply every required section in full — Thinking Path, What Changed, Verification, Risks, Checklist, or whatever the template expects. No ad-hoc structures, no section omissions.

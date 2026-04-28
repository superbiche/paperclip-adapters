#!/usr/bin/env node
/**
 * Drift check between `packages/*` and the repo's release surface.
 *
 * Catches the two ways a newly-added adapter can silently miss its release:
 *   1. Missing from the README "Packages" table (users can't discover it).
 *   2. Missing the `paperclip.adapterUiParser` field (paperclip refuses to load it).
 *
 * The npm trusted-publisher gap (which is what made @superbiche/copilot-paperclip-adapter
 * v0.2.1 fail to publish) is NOT mechanically detectable from inside the repo —
 * see `docs/RELEASING.md` for the human checklist that covers it.
 *
 * Exits 0 on success, 1 on any failure. Prints a punch list of every problem.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = resolve(repoRoot, "packages");
const readmePath = resolve(repoRoot, "README.md");

const failures = [];

const readme = readFileSync(readmePath, "utf8");

const packageDirs = readdirSync(packagesDir).filter((entry) => {
  const full = resolve(packagesDir, entry);
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
});

for (const dir of packageDirs) {
  const manifestPath = resolve(packagesDir, dir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    failures.push(`packages/${dir}: cannot read package.json (${err.message})`);
    continue;
  }

  if (manifest.private === true) continue;

  const name = manifest.name;
  if (!name) {
    failures.push(`packages/${dir}: package.json has no "name" field`);
    continue;
  }

  if (!readme.includes(name)) {
    failures.push(
      `packages/${dir}: "${name}" is missing from README.md packages table — add a row pointing at ./packages/${dir}`,
    );
  }

  if (!manifest.paperclip?.adapterUiParser) {
    failures.push(
      `packages/${dir}: package.json is missing "paperclip.adapterUiParser" — paperclip will refuse to load this adapter`,
    );
  }
}

if (failures.length > 0) {
  console.error("Package drift check failed:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nFix the issues above, then re-run `pnpm check:packages`. See docs/RELEASING.md for the new-package onboarding flow.",
  );
  process.exit(1);
}

console.log(
  `Package drift check: OK (${packageDirs.length} package${packageDirs.length === 1 ? "" : "s"} present in README + manifest fields valid).`,
);

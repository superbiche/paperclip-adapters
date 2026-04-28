# @superbiche/cline-paperclip-adapter

## 0.1.3

### Patch Changes

- 4666700: Smoke-test the npm trusted-publisher OIDC flow on a previously-manually-bootstrapped package.

  No source change. The release pipeline has never actually exercised an OIDC publish on this repo — cline 0.1.0/0.1.1/0.1.2 and qwen 0.1.0/0.1.1/0.1.2 were all published manually before the GitHub Actions workflow was wired up, and the only OIDC publish attempts since (copilot 0.2.0/0.2.1) have failed with `404 Not Found - PUT`. This patch bumps cline to 0.1.3 with no code change to disambiguate whether the failure is package-specific (only copilot's trusted publisher misconfigured) or repo-wide (org-level setting overriding OIDC). Resolution path documented in `docs/RELEASING.md` "When release fails."

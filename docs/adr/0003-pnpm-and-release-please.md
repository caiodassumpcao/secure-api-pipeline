# 0003. pnpm and release-please for versioning

- Status: Accepted
- Date: 2026-11-10

## Context

- Installs must be reproducible on laptops, in CI and in the image build, with the same package manager version everywhere.
- The npm ecosystem is a recurring attack vector: hijacked maintainer accounts publishing malicious versions, install scripts that run on every machine, packages that silently lose their provenance.
- Releases should cost no manual work: version, changelog, tag and GitHub Release derived from the history.
- `main` only accepts **squash merges** of pull requests with signed commits, so the PR title becomes the commit that tools read.

## Decision

### pnpm through Corepack

- `packageManager` pins pnpm to an exact version **with its sha512 integrity**; Corepack verifies it before running. CI and the Dockerfile use the same mechanism.
- `pnpm-lock.yaml` is committed; CI and the image build install with `--frozen-lockfile`. Direct dependencies are pinned to exact versions.
- Supply-chain policy in `pnpm-workspace.yaml`:
  - `minimumReleaseAge: 4320` — versions younger than **3 days** are refused (strict), giving the ecosystem time to detect and unpublish compromised releases;
  - `trustPolicy: no-downgrade` — installation fails if a version has weaker trust evidence (trusted publishing, provenance) than earlier versions of the same package;
  - `strictDepBuilds: true` with an empty `allowBuilds` — dependency install scripts never run unless explicitly approved;
  - `engineStrict: true`.
- Dependabot proposes updates weekly with a matching 3-day cooldown (security updates are not delayed), grouping minor and patch updates.

### release-please

- release-please (manifest configuration, `release-type: node`) reads the Conventional Commits on `main`, maintains a release PR with the next version and changelog, and creates the `vX.Y.Z` tag and GitHub Release when that PR is merged.
- `feat` → minor; `fix`, `perf` and `revert` → patch; other types (`docs` included) do not release. With `bump-minor-pre-major`, breaking changes bump the minor version until 1.0.
- `initial-version: 0.1.0`: with the manifest at `0.0.0` and no tag, release-please would otherwise make `1.0.0` the first release, while the roadmap reserves 1.0 for Phase 5.
- Because merges are squashed, the **PR title is validated with commitlint** by the `pr-title` check, using the same configuration as the `commit-msg` hook. Dependabot titles map onto the same semantics: production dependencies and the base image use `fix(deps)`, tooling uses `chore(deps-dev)`, actions use `ci(deps)`.
- `CHANGELOG.md` is generated and never edited by hand.
- Phase 0 adds the configuration. The workflow is added with the first release (Phase 1), together with the choice of token for release PRs: a pull request opened with the default `GITHUB_TOKEN` does not trigger workflows, so its required status checks would never report and the ruleset (no bypass) would block the merge.

## Alternatives considered

- **npm.** Bundled with Node and adequate, but without pnpm's strict dependency isolation and with fewer built-in supply-chain policies (release-age cutoff, trust downgrade, build-script allowlist).
- **Yarn Berry.** Capable, but Plug'n'Play adds friction with tooling, and its policies would need plugins.
- **semantic-release.** Publishes on every merge without a reviewable release step, and its plugin chain needs a write token at merge time.
- **Changesets.** Designed for libraries and monorepos; requires a changeset file in every PR, duplicating what Conventional Commits already express.
- **Manual tags and changelog.** Error-prone and easy to forget.

## Consequences

- The toolchain is pinned and verifiable end to end; a new version of any dependency waits at least three days.
- No dependency code runs at install time unless someone approves it in review.
- A security fix younger than three days needs a temporary, reviewed `minimumReleaseAgeExclude` entry.
- PR titles carry real weight; the `pr-title` check keeps them honest.
- Before the first release, a token strategy for release PRs must be chosen (a GitHub App token is the usual choice).

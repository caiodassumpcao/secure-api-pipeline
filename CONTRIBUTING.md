# Contributing

Thanks for your interest! This guide covers the local setup, the conventions every change follows and what a pull request needs before it can be merged. The [design specification](docs/DESIGN.md) is the technical source of truth; decisions are recorded as [ADRs](docs/adr/).

## Prerequisites

- **Node.js 24** — `nvm use` reads `.nvmrc`.
- **pnpm via Corepack** — `corepack enable`. The exact version and its integrity hash are pinned in `package.json` (`packageManager`).
- **Docker** with Compose v2 — for the local stack and the secret scan in the pre-commit hook.
- Optional: a local [gitleaks](https://github.com/gitleaks/gitleaks#installing) binary. Without it the pre-commit hook runs gitleaks from its pinned container image.

## Setup

```bash
corepack enable
pnpm install                    # also installs the git hooks
cp .env.example .env            # local development values
docker compose up -d postgres   # database on 127.0.0.1:5432
pnpm dev                        # http://localhost:3000/health/ready
```

To run the whole stack in containers instead: `docker compose up -d --build --wait`.

## Scripts

| Command              | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`           | Runs `src/main.ts` with Node's built-in TypeScript support, in watch mode |
| `pnpm build`         | Compiles to `dist/`                                                       |
| `pnpm start`         | Runs the compiled build                                                   |
| `pnpm lint`          | ESLint (type-aware, security rules) and the Prettier check                |
| `pnpm lint:fix`      | Fixes what ESLint and Prettier can fix                                    |
| `pnpm typecheck`     | TypeScript in strict mode                                                 |
| `pnpm test`          | Unit tests                                                                |
| `pnpm test:coverage` | Unit tests with the coverage gate (85 %)                                  |

Run `pnpm lint && pnpm typecheck && pnpm test` before every push; CI runs the same checks.

## Branches, commits and pull requests

- Branch from `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `docs/<topic>`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): imperative, lower case, at most 72 characters, no trailing period, with a body that explains _why_ when it is not obvious. The `commit-msg` hook runs commitlint.
- Keep commits atomic; each one should pass lint, typecheck and tests. Tidy local history with `git commit --fixup` and `git rebase --autosquash` before pushing.
- Commits must be **signed**. `main` only accepts signed commits.
- `main` is protected: changes land through pull requests that are **squash-merged**. The **PR title becomes the commit on `main`**, so it must be a Conventional Commit — the `pr-title` check validates it — and its type must describe the whole PR.
- Do not start lines of the PR body with `type:` or `type(scope):`. The body becomes the squash commit body, and release-please would read those lines as extra commits.
- Fill in the [pull request template](.github/pull_request_template.md), including the security considerations.

### Commit types and releases

[release-please](https://github.com/googleapis/release-please) derives versions and the changelog from the commits on `main`:

| Type                                                        | Release |
| ----------------------------------------------------------- | ------- |
| `feat`                                                      | minor   |
| `fix`, `perf`, `revert`                                     | patch   |
| `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style` | none    |

Breaking changes (`feat!:` or a `BREAKING CHANGE:` footer) bump the minor version before 1.0. Discuss them in an issue first. `CHANGELOG.md` is generated — do not edit it by hand.

## Git hooks

| Hook         | Runs                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `pre-commit` | lint-staged (ESLint + Prettier on staged files) and a gitleaks secret scan |
| `commit-msg` | commitlint                                                                 |

Never bypass them with `--no-verify`; fix the cause instead. If gitleaks flags a false positive, discuss it in the PR before adding an allowlist entry.

## Code guidelines

- TypeScript `strict` with `noUncheckedIndexedAccess`, ESM, no `any` (justify it in a comment if it is truly unavoidable).
- Layers: `*.routes.ts` (HTTP and zod schemas) → `*.service.ts` (business rules, authorization) → `*.repository.ts` (SQL, always scoped by `workspaceId`). Dependencies are passed in explicitly; no global singletons.
- Validate every input with zod `.strict()` schemas. Response schemas strip unknown fields, so internal columns never leak.
- Errors are RFC 9457 problems produced by the single error handler: throw `HttpProblem` with a type from `src/lib/problem.ts` and document new types in [`docs/problems.md`](docs/problems.md).
- Log through the request logger (`request.log`) or the injected pino logger — never `console`. Never log passwords, tokens, cookies or authorization headers; the logger redacts known keys and a test guards it.
- SQL only through Drizzle or parameterized queries; migrations are generated, reviewed and committed (expand/contract).
- GitHub Actions: least-privilege `permissions`, actions pinned by full commit SHA with the version in a comment.

## Tests

- [Vitest](https://vitest.dev/). Unit tests live in `tests/unit/` and mirror `src/`; build the app with `buildApp()` and use `app.inject()` for HTTP-level tests.
- Coverage must stay at or above **85 %** (lines, branches, functions, statements).
- From v0.1, every new endpoint needs an integration test, a case in the authorization matrix, a cross-tenant test and its schema in the OpenAPI document.

## Dependencies

pnpm refuses versions published less than three days ago and dependency install scripts that are not explicitly allowed (see [ADR-0003](docs/adr/0003-pnpm-and-release-please.md)). Add a dependency only when it pulls its weight, pin it to an exact version and explain the choice in the PR.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

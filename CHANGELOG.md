# Changelog

## [0.4.0](https://github.com/caiodassumpcao/secure-api-pipeline/compare/v0.3.1...v0.4.0) (2026-11-24)


### Features

* devsecops pipeline with signed and attested release images ([#18](https://github.com/caiodassumpcao/secure-api-pipeline/issues/18)) ([67aafc8](https://github.com/caiodassumpcao/secure-api-pipeline/commit/67aafc8203477dd2261cc18f6d3e20502538001e))


### Bug Fixes

* **api:** reject nul characters in text input ([#21](https://github.com/caiodassumpcao/secure-api-pipeline/issues/21)) ([c2efb6b](https://github.com/caiodassumpcao/secure-api-pipeline/commit/c2efb6be09e55bf612a456eb5441b62be514edc6))

## [0.3.1](https://github.com/caiodassumpcao/secure-api-pipeline/compare/v0.3.0...v0.3.1) (2026-11-24)


### Bug Fixes

* **deps:** bump the production group across 1 directory with 4 updates ([#13](https://github.com/caiodassumpcao/secure-api-pipeline/issues/13)) ([6ae5c05](https://github.com/caiodassumpcao/secure-api-pipeline/commit/6ae5c0534e17a8f46ec6844ee00cefb4db84825d))

## [0.3.0](https://github.com/caiodassumpcao/secure-api-pipeline/compare/v0.2.0...v0.3.0) (2026-11-24)


### Features

* opentelemetry traces, metrics and correlated logs ([#11](https://github.com/caiodassumpcao/secure-api-pipeline/issues/11)) ([b9733df](https://github.com/caiodassumpcao/secure-api-pipeline/commit/b9733df7e5faa3c8072ed4d5d29b899e6191c0b7))

## [0.2.0](https://github.com/caiodassumpcao/secure-api-pipeline/compare/v0.1.1...v0.2.0) (2026-11-17)


### ⚠ BREAKING CHANGES

* `POST /v1/workspaces/:wsId/members` is removed. To add a member, create an invitation with `POST /v1/workspaces/:wsId/invitations` (a role and, optionally, the email of the only account allowed to accept it), share the single-use token it returns, and have the invitee accept it with `POST /v1/invitations/accept` while logged in. Every `/v1` route now also requires an access token from `POST /v1/auth/login`, and the API needs Ed25519 signing keys (`JWT_PRIVATE_KEY_FILE` and `JWT_PUBLIC_KEY_FILE`) to start.

### Features

* authentication, audit log and member invitations ([#9](https://github.com/caiodassumpcao/secure-api-pipeline/issues/9)) ([98b29fc](https://github.com/caiodassumpcao/secure-api-pipeline/commit/98b29fc04fd6835a7373a2b703f58b1d131369a5))

## [0.1.1](https://github.com/caiodassumpcao/secure-api-pipeline/compare/v0.1.0...v0.1.1) (2026-11-17)


### Bug Fixes

* **deps:** bump node from 24.22.2-alpine to 24.22.3-alpine ([#2](https://github.com/caiodassumpcao/secure-api-pipeline/issues/2)) ([9930c3e](https://github.com/caiodassumpcao/secure-api-pipeline/commit/9930c3e617d7c3ca78d9f692856f63a461756c5a))

## 0.1.0 (2026-11-17)


### Features

* domain model with workspace-scoped crud and openapi ([#5](https://github.com/caiodassumpcao/secure-api-pipeline/issues/5)) ([5274f90](https://github.com/caiodassumpcao/secure-api-pipeline/commit/5274f908a5740f7757298553b75d863827492b43))

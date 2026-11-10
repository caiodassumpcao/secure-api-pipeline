# Architecture decision records

Significant technical decisions, why they were made and what they cost. An accepted ADR is not edited to change its decision: a new ADR supersedes it.

| #                                                        | Title                                                        | Status   |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| [0001](0001-fastify-with-zod-type-provider.md)           | Fastify with zod type provider                               | Accepted |
| [0002](0002-drizzle-orm-with-reviewed-sql-migrations.md) | Drizzle ORM with reviewed SQL migrations                     | Accepted |
| [0003](0003-pnpm-and-release-please.md)                  | pnpm and release-please for versioning                       | Accepted |
| 0004                                                     | Token strategy: short JWT + rotating opaque refresh tokens   | Planned  |
| 0005                                                     | Tenant isolation enforced at repository layer                | Planned  |
| 0006                                                     | OpenTelemetry for traces and metrics                         | Planned  |
| 0007                                                     | Supply-chain security: SBOM, cosign keyless, SLSA provenance | Planned  |
| 0008                                                     | Expand/contract migrations for safe rollbacks                | Planned  |

## Format

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

## Decision

## Alternatives considered

## Consequences
```

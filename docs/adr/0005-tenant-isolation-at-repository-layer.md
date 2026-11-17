# 0005. Tenant isolation enforced at the repository layer

- Status: Accepted
- Date: 2026-11-17

## Context

The API is multi-tenant: every project, task and membership belongs to a workspace, and all tenants share one PostgreSQL database and schema. Broken object-level authorization (OWASP API Security Top 10, API1) is the most likely serious flaw in such an API: a handler that loads a resource by id alone lets any authenticated user read or change another tenant's data by guessing or harvesting ids.

Isolation has to hold even when a single query, route or service is written carelessly, and it has to be verifiable by tests rather than by inspection alone.

## Decision

Isolation is enforced in four layers, each of which would stop a cross-tenant access on its own.

1. **Repositories require the workspace.** Every repository method on tenant data takes `workspaceId` as a required argument and filters by it, writes included (`UPDATE … WHERE workspace_id = $1 AND id = $2`). No method reads tenant data by id alone. The two exceptions are explicit and documented in code: the `workspaces` table, which is the tenant itself and is only read through the caller's membership, and the lookup of an account by email when adding a member.
2. **Services authorize before acting.** `authorize(db, workspaceId, userId, action)` resolves the caller's role from `memberships` and checks it against the permission matrix (`src/modules/auth/permissions.ts`, DESIGN §2.1). A caller who is not a member gets **404**, identical to a workspace that does not exist, so responses never confirm that another tenant's resources exist; a member whose role lacks the permission gets **403**.
3. **The schema keeps references inside one tenant.** `workspace_id` is denormalized on `tasks`, and composite foreign keys tie it to the referenced rows: `(workspace_id, project_id)` → `projects (workspace_id, id)` and `(workspace_id, assignee_id)` → `memberships (workspace_id, user_id)`. A service bug cannot link a task to a project or an assignee of another workspace: the database rejects it.
4. **Tests cover every route and role.** A cross-tenant suite sends every request against another tenant's workspace, and another tenant's ids under the caller's own workspace, expecting 404 with no data in the body. A table-driven authorization suite runs every action for every role over HTTP and derives the expected status from the same permission table, which a unit test pins to DESIGN §2.1.

Invariants that span rows are protected with row locks inside the transaction: membership changes lock the workspace row (a workspace always keeps an owner), and removing a member locks the membership row so that a concurrent task assignment either completes first and is unassigned, or fails the foreign key check.

## Alternatives considered

- **PostgreSQL row-level security** (policies on `current_setting('app.workspace_id')`, set with `SET LOCAL` in every transaction). Strong defense in depth, but every request needs a transaction with session state on a pooled connection, the table owner bypasses policies unless `FORCE ROW LEVEL SECURITY` is set, and a missing setting fails in ways that are hard to see in tests. It remains a candidate additional layer, not a replacement for explicit scoping.
- **Schema or database per tenant.** Strong isolation, but migrations, connection pools and backups multiply with the number of tenants: out of proportion for this service.
- **Implicit scoping** (ORM global scopes, request-scoped repositories that inject the tenant). Drizzle has no global scopes, and implicit filters are easy to bypass unknowingly; explicit arguments keep the scope visible in every query under review.
- **Authorization checks in routes only.** Leaves repositories able to read any tenant's rows, so one forgotten check exposes data.

## Consequences

- Every new repository method and endpoint must take the workspace explicitly, and every new endpoint needs a case in the authorization matrix and in the cross-tenant suite. Reviews check this; a Semgrep rule (Phase 4) will flag queries on tenant tables without a `workspace_id` filter.
- Each request pays one primary-key lookup on `memberships` to resolve the role.
- The composite foreign keys need a unique `(workspace_id, id)` constraint on `projects`, and `(workspace_id, user_id)` is the primary key of `memberships`.
- Non-members cannot distinguish "not found" from "not allowed", which hides tenant data but makes some client errors less specific by design.

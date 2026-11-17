# Threat model

> Status: **started in v0.1** with the residual risks known so far. The full model (STRIDE per component for client → Nginx → API → PostgreSQL and CI/CD → GHCR → VPS, data-flow diagram, trust boundaries, assets) arrives with v0.2, as planned in [DESIGN §5.2](DESIGN.md#52-threat-model). Controls in place are listed in [DESIGN §5.1](DESIGN.md#51-controls).

## Residual risks

Risks that are known and accepted for now, each with the version that revisits it.

| ID   | Risk                                        | Status                    | Revisit |
| ---- | ------------------------------------------- | ------------------------- | ------- |
| RR-1 | Account enumeration through member addition | Accepted                  | v0.2    |
| RR-2 | Test identity stub trusts a request header  | Accepted, removed in v0.2 | v0.2    |

### RR-1. Account enumeration through member addition

- **Where:** `POST /v1/workspaces/:wsId/members` (add an existing account by email).
- **Threat:** the endpoint answers **404** when no account uses the address and **201** (or **409** for an existing member) otherwise. Any authenticated user can create a workspace, becoming its owner, and use it to probe which email addresses have an account. A successful probe also returns the account's name and adds that account to the prober's workspace without its consent.
- **Impact:** disclosure that a person has an account (privacy), input for credential stuffing and phishing, unwanted workspace memberships.
- **Why accepted in v0.1:** there is no registration or real authentication yet; outside the test environment every `/v1` route answers 401, so the endpoint cannot be reached. Uniform responses need an invitation flow, which v0.1 does not have.
- **Planned for v0.2:**
  - a per-user rate limit on `POST /members` (on top of the per-IP limit), so probing at scale is impractical;
  - the `member.added` audit event (DESIGN §5.3), so probing and unwanted additions are traceable;
  - an evaluation of an invitation flow: the invitee accepts a pending invitation, and the endpoint answers the same way whether or not the address has an account. The decision will be recorded in an ADR.

### RR-2. Test identity stub trusts a request header

- **Where:** `src/plugins/authentication.ts` (`createTestAuthenticator`).
- **Threat:** under `NODE_ENV=test` the caller is whoever the `x-test-user-id` header names. A deployment running with that value would let anyone act as any user.
- **Mitigations:** the stub cannot be constructed outside `NODE_ENV=test` (it throws), the API logs a warning when it is enabled, and every other environment uses an authenticator that rejects all requests. Unit tests cover the guard and both authenticators.
- **Planned for v0.2:** JWT authentication replaces the stub, and the stub is deleted.

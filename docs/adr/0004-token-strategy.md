# 0004. Token strategy: short JWT + rotating opaque refresh tokens

- Status: Accepted
- Date: 2026-11-17

## Context

Clients need to call `/v1` without sending a password each time, sessions must survive for days on the devices people use, and a stolen credential must stop working quickly. Access checks happen on every request, so they must be cheap; revoking a session must be possible and immediate for whatever lets it continue. Browser clients are exposed to XSS and CSRF; the API has a single verifier (itself) today.

## Decision

Two credentials with different jobs:

- **Access token**: a JWT signed with **Ed25519** (`alg: Ed25519`, the fully-specified identifier of RFC 9864), typed `at+jwt` (RFC 9068), valid **15 minutes**, carrying only the user id (`sub`), `iss`, `aud`, `iat` and `exp`. Sent as `Authorization: Bearer`. Verification pins the algorithm, type, issuer and audience, with 5 seconds of clock tolerance. Roles are not in the token: they are read from the database on each request (ADR-0005), so a membership change applies at once.
- **Refresh token**: 256 random bits, stored only as SHA-256, sent in a `__Secure-refresh` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/v1/auth`) and never readable by scripts. Tokens belong to a **family** (one login): each refresh exchanges the token for a new one (**rotation**); presenting an already exchanged token means two parties hold it, so the **whole family is revoked** and the event audited. A token exchanged less than **10 seconds** ago gets a 401 without revoking anything (two tabs refreshing at once). Idle lifetime **7 days**, renewed by each rotation; absolute lifetime of the family **30 days**. Logout revokes the family; it is authenticated by the cookie, so it works after the access token expired, and it always answers 204.
- **CSRF**: the only cookie-authenticated routes are refresh and logout. Besides `SameSite=Strict` and the cookie path, they refuse requests with `Sec-Fetch-Site: cross-site` or an `Origin` other than the API's own and `CORS_ORIGINS`.
- **Keys**: PEM files given by `JWT_PRIVATE_KEY_FILE` and `JWT_PUBLIC_KEY_FILE` (Docker secrets; `pnpm keys:generate` in development). The `kid` is the RFC 7638 thumbprint of the public key. Verification uses a local key set with the current public key and, during a rotation, the previous one (`JWT_PREVIOUS_PUBLIC_KEY_FILE`); signing always uses the current key. To rotate: deploy the new pair with the old public key as previous, wait at least 15 minutes, remove it (runbook, Phase 5). The API refuses to start without keys, with a key of another type, or with a public key that does not match the private one. No public JWKS endpoint: nothing else verifies these tokens yet.

## Alternatives considered

- **Server-side sessions only** (opaque token checked on every request): immediate revocation, but a database read per request for authentication, and no stateless option for future services.
- **Long-lived JWTs** or **JWTs as refresh tokens**: revocation would need a deny list consulted on every request, losing the benefit of stateless verification.
- **Refresh token in the response body**, kept by the client: readable by any script running in the page, so an XSS steals the session.
- **Access token in a cookie**: every `/v1` route would become a CSRF target.
- **RS256 or ES256**: larger keys and signatures (RSA) or nonce pitfalls (ECDSA); Ed25519 is deterministic, fast and compact.
- **A deny list for access tokens**: shared state on every request to save at most 15 minutes after a logout (threat model RR-6).

## Consequences

- A stolen access token is usable for at most 15 minutes; a stolen refresh token is detected the next time either holder refreshes, and both are logged out.
- Clients refresh on a 401 with `error="invalid_token"`; browser clients must refresh one request at a time or tolerate the grace-period 401.
- Logging out does not invalidate access tokens already issued (RR-6).
- Key rotation needs an overlap of at least one access-token lifetime.
- Sessions, device cookies and their tables need cleanup: an hourly job deletes expired rows.

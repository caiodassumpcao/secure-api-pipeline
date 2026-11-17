# 0009. Brute-force protection: rate limits, lockout and device cookies

- Status: Accepted
- Date: 2026-11-17

## Context

Login is exposed to password guessing and credential stuffing. Locking an account after repeated failures stops guessing, but a naive lockout lets anyone lock anyone out by failing on purpose. Several API instances may run behind the proxy, so counters kept in memory would be multiplied and reset by every deploy. Responses must not reveal whether an account exists or is locked, by content or by timing.

## Decision

- **Rate limits** with fixed windows, counted in a PostgreSQL table shared by every instance (`rate_limits`, `UNLOGGED`: counters need no durability; one atomic upsert per request; keys are SHA-256 hashes, never addresses or emails):

  | Route             | Limit                                                              |
  | ----------------- | ------------------------------------------------------------------ |
  | login             | 10/min per IP; 5/min per email for clients without a device cookie |
  | register          | 5/hour per IP                                                      |
  | refresh           | 30/min per IP                                                      |
  | create invitation | 20/hour per user                                                   |
  | accept invitation | 10/min per user                                                    |

  The per-email limit counts whether or not the account exists. A coarse limit of 600 requests/min per IP, in memory, runs before routing on every request but the health probes. Exceeding a limit answers 429 with `Retry-After`. Limits are constants changed by review, not configuration.

- **Client IP**: taken from `X-Forwarded-For` only through the proxies listed in `TRUST_PROXY` (hop count or addresses/CIDR ranges). Off by default; `true` is refused, since any client could then pick its IP.
- **Lockout with device cookies** (OWASP, "Slow down online guessing attacks with device cookies"): a successful login sets a `__Secure-device` cookie (random, stored hashed, 90 days, path `/v1/auth/login`). Ten consecutive failures from clients **without** a valid device cookie lock the account for 15 minutes, **for those clients only**. A client presenting the device cookie of that account is not locked out; five failures with it revoke that cookie, and its successful logins do not lift the lock for others. Attempts while locked neither count nor extend the lock.
- **Uniform failures**: a wrong password, an unknown email and a locked account get the same 401, and argon2 runs in every case, against a dummy hash when there is no usable stored one. Tests assert both.

## Alternatives considered

- **Lock per account for everyone**: one attacker request every few minutes keeps the owner locked out indefinitely.
- **Lock per (account, IP)**: does not stop distributed guessing, and locks out everyone behind a shared NAT with the attacker.
- **CAPTCHA**: a third-party dependency and a UI the API does not have.
- **Redis or Valkey for counters**: the standard choice at scale, but another service to run, secure and back up; PostgreSQL handles the volume of the routes that need shared counters. Revisit if the load requires it.
- **In-memory counters only**: multiplied by the number of instances and reset by each deploy.

## Consequences

- An attacker cannot keep the owner out of a device they already used; on a new device the owner may wait 15 minutes during an attack.
- Each failed login costs an argon2 hash, a few writes and an audit event; rate limits bound that cost.
- Behind a proxy, `TRUST_PROXY` must be set, or every client shares the proxy's address.
- The global per-IP limit is per instance (threat model RR-7).

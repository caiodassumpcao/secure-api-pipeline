# 0010. Member invitations by single-use link

- Status: Accepted
- Date: 2026-11-17

## Context

v0.1 added members by the email of an existing account (`POST /v1/workspaces/:wsId/members`). Once registration opened in v0.2, any user could create a workspace and use that endpoint to learn whether an address had an account (404 or 201), and the account was added to the workspace without its consent (threat model RR-1). The API sends no email, and addresses are not verified (RR-4), so "the address" proves nothing about who receives an invitation.

## Decision

Members join through **invitation links**:

- `POST /v1/workspaces/:wsId/invitations {role, email?}` (owner, admin; only owners invite owners) returns a **single-use token** of 256 bits, stored only as SHA-256, valid **7 days**. It looks no account up, so its answer is the same for any address. The inviter shares the link over a channel they trust.
- `POST /v1/invitations/accept {token}`, by the invitee **while logged in**, creates the membership with the invited role. The token is consumed under a row lock, so it works once. If the invitation names an email, only the account with that email can accept. An unknown, used, revoked, expired or mismatched token gets the same 404.
- Pending invitations can be listed and revoked by owners and admins (owner invitations by owners only).
- `member.invited`, `invitation.revoked` and `member.added` (on acceptance, with the inviter) are audited; invitation creation and acceptance are rate limited per user.
- `POST /v1/workspaces/:wsId/members` is **removed**: a breaking change of v0.2.

## Alternatives considered

- **Keep adding by email, with a rate limit and an audit event**: slows enumeration down without removing it, and still adds people without their consent.
- **Invitation by email, accepted from a list in `/v1/me`**: no enumeration, but whoever registers the invitee's address first receives the invitation, since addresses are not verified.
- **Email delivery of invitations**: the proper long-term answer together with email verification, but it needs an email service, which v1 does not have.

## Consequences

- No endpoint discloses whether an address has an account, except registration (RR-3).
- Joining a workspace takes an explicit acceptance; the link is the proof of who was invited.
- Inviters handle the link themselves, like any shared secret; it expires after 7 days and can be revoked.
- API clients of v0.1 must switch to invitations (the BREAKING CHANGE note of v0.2 explains how).

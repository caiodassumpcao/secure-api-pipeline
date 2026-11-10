# 0001. Fastify with zod type provider

- Status: Accepted
- Date: 2026-11-10

## Context

The API is small, but it is the reference for how the service is built. The HTTP layer has to:

- validate every input at runtime — unknown fields included, to prevent mass assignment;
- give handlers static types derived from the same rules, so types and validation cannot drift;
- control what leaves the service, so internal fields never reach a response;
- generate the OpenAPI document from the code (Phase 1), feeding `/docs` and the DAST scan;
- report every error in one format (RFC 9457 problem details);
- offer maintained security plugins (headers, CORS, rate limiting, cookies), OpenTelemetry instrumentation and in-process HTTP testing.

Environment configuration also needs runtime validation, so a schema library is required regardless of the framework.

## Decision

Use **Fastify 5** with **zod 4** through **`fastify-type-provider-zod`**.

- Each route declares its `params`, `querystring`, `body` and `response` schemas once, in zod. The type provider compiles them into Fastify's validator and serializer and infers the handler types.
- **Request schemas are `.strict()`**: unknown fields are rejected with a `validation-error` problem.
- **Response schemas strip unknown fields**. A response that does not match its schema fails closed with a generic 500, and nothing of the invalid payload is returned.
- One error handler (`src/plugins/error-handler.ts`) maps validation errors, Fastify errors and `HttpProblem` to `application/problem+json`. Unexpected errors return a generic message and are logged with full details under the same `traceId`.
- The response serialization error is detected with `instanceof ResponseSerializationError`; the library's `isResponseSerializationError` guard only checks for a `method` property and throws on non-objects.
- `buildApp()` creates the instance from injected dependencies without listening, so tests run against the real app with `app.inject()`.
- The same zod library validates the environment (`src/config/config.ts`).
- OpenAPI comes from `@fastify/swagger` with the type provider's JSON Schema transform (Phase 1).

## Alternatives considered

- **Express 5 + zod middleware.** Familiar, but no schema-driven serialization or OpenAPI, weaker handler typing and more hand-written plumbing for errors and validation.
- **NestJS.** A full framework with its own DI container and decorators. More structure and magic than a small service needs, and decorators are not erasable TypeScript syntax (incompatible with the `erasableSyntaxOnly` setup that lets Node run the sources directly).
- **Hono.** Excellent typing on Web-standard APIs, but a thinner ecosystem of Node security plugins and server instrumentation at the time of writing.
- **Fastify + TypeBox/AJV.** The fastest option (compiled validation, `fast-json-stringify`), but JSON Schema-first types are less ergonomic, and zod would still be needed for configuration: two schema languages.

## Consequences

- One schema language for configuration, requests, responses and documentation; the OpenAPI document cannot drift from the code.
- Fastify's encapsulation and hooks give natural places for authentication and tenant resolution (Phase 2).
- zod validation and serialization are slower than AJV and `fast-json-stringify`. Acceptable at this scale; revisit if profiling shows the HTTP layer as a bottleneck.
- The type provider is a community package. It is small and pinned, and the project depends on few of its exports.
- Response schemas must be kept complete: a missing field is stripped silently, which tests catch, while an invalid one returns 500.

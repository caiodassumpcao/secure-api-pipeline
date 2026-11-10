# Problem types

Every error response uses [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details with the `application/problem+json` media type. The `type` of each documented problem is a link to its section on this page.

```json
{
  "type": "https://github.com/caiodassumpcao/secure-api-pipeline/blob/main/docs/problems.md#validation-error",
  "title": "Validation Failed",
  "status": 400,
  "detail": "The request does not match the expected schema.",
  "instance": "/v1/workspaces/0190f3b2-7c1e-7d2a-9f00-1234567890ab/tasks",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    { "path": "body.title", "message": "Too small: expected string to have >=1 characters" }
  ]
}
```

| Member     | Description                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `type`     | Problem type URI. `about:blank` for statuses without a dedicated type.                                                               |
| `title`    | Short, stable summary of the problem type.                                                                                           |
| `status`   | HTTP status code.                                                                                                                    |
| `detail`   | Explanation of this occurrence, when it is safe to share.                                                                            |
| `instance` | Request path, without the query string.                                                                                              |
| `traceId`  | Correlation id, also returned in the `x-request-id` header. Quote it when reporting a problem.                                       |
| `errors`   | Validation errors only: `path` (`body`, `querystring`, `params` or `headers`, followed by the field path) and a `message` per field. |

Responses never contain stack traces, SQL or internal hostnames. Server errors are logged with full details under the same `traceId`.

## `bad-request`

**400** — The request could not be parsed: malformed JSON, an empty body sent with `content-type: application/json`, or a malformed URL (for example an invalid percent-encoding). Fix the request syntax before retrying.

## `validation-error`

**400** — The request is well formed but does not match the endpoint's schema: a field is missing, has the wrong type or format, or an unknown field was sent (request schemas are strict). `errors` lists every offending field.

## `not-found`

**404** — The route does not exist, or the resource does not exist **or is not visible to you**. Resources of other workspaces are reported as not found rather than forbidden, so their existence is not disclosed.

## `payload-too-large`

**413** — The request body exceeds the 100 KB limit.

## `unsupported-media-type`

**415** — The `content-type` is not supported. Request bodies must be `application/json`; `text/plain` and other types are rejected.

## `internal-error`

**500** — An unexpected error occurred on the server. The response carries no details; use the `traceId` to find them in the logs. Safe to retry for idempotent requests.

## `about:blank`

Statuses without a dedicated type use `"type": "about:blank"` with the standard HTTP status phrase as `title` ([RFC 9457 §4.2.1](https://www.rfc-editor.org/rfc/rfc9457#section-4.2.1)) — for example `414 URI Too Long` when a path parameter exceeds 100 characters.

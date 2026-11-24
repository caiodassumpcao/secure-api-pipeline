# 0007. Supply-chain security: SBOM, cosign keyless, SLSA provenance

- Status: Accepted
- Date: 2026-11-24

## Context

From v0.4 the API ships as a container image that a server (Phase 5) pulls and runs. Whoever runs it must be able to check, without trusting the registry, that the image was built by this repository's pipeline from a given commit, what it contains, and that it passed the same gates as every pull request. The image must hold as little as possible to attack: no shell, no package manager, no root. The pipeline itself is part of the supply chain: every action and scanner it runs could leak the tokens it receives, as the hijacked `aquasecurity/trivy-action` tags did in March 2026 (GHSA-69fq-xp46-6x23). Findings must block merges where they matter and stay visible where they do not, and no finding may disappear without a written reason.

## Decision

- **Distroless runtime.** `gcr.io/distroless/nodejs24-debian13:nonroot`, pinned by digest: Node.js and glibc, no shell, no package manager, uid 65532. Debian 13 rather than the Debian 12 variant first planned: Debian 12 left regular security support in June 2026. The entrypoint is `/nodejs/bin/node`; `CMD` adds the telemetry preload (`--import ./dist/telemetry/instrument.js dist/main.js`, ADR-0006), while `dist/migrate.js` and the `HEALTHCHECK` (`dist/healthcheck.js`) run without it.
- **Cross-platform build without emulation.** The Node.js stages run on the build machine's platform (`FROM --platform=$BUILDPLATFORM`): compiled JavaScript does not depend on the target. Production dependencies are installed for the target with `pnpm install --os linux --cpu <arch> --libc glibc`, so the image gets the `@node-rs/argon2` binary built for its own libc and CPU, never the Alpine (musl) one of the build stage. The runtime stage only copies files, so `linux/amd64` and `linux/arm64` build natively on one runner, without QEMU.
- **Build once, publish the bytes that were checked.** `container.yml` builds both platforms once, into an OCI archive. Every check reads that archive: the amd64 image is loaded from it and must log in for real, both platforms are scanned by Trivy and described by Syft, and arm64 runs the same checks on a native arm64 runner. On a release, `skopeo copy --all --preserve-digests` pushes that very archive to GHCR, so the published digests are those of the tested and scanned images.
- **Publish only on a release.** Pull requests and `main` build, test and scan. Only the `release: published` event, sent by the GitHub Release that release-please creates with its App token (ADR-0003), pushes to `ghcr.io/caiodassumpcao/secure-api-pipeline` (tags `X.Y.Z`, `X.Y`, `latest`). `packages: write`, `id-token: write` and `attestations: write` are granted to that publishing job alone.
- **Keyless signatures.** The publishing job signs the image index with cosign keyless: Sigstore issues a short-lived certificate for the workflow's GitHub OIDC identity (`container.yml` at `refs/tags/vX.Y.Z`) and records the signature in the Rekor transparency log. There is no private key to store, rotate or leak.
- **Attestations.** `actions/attest` adds, on the image index, a SLSA v1 build provenance and an SPDX SBOM per platform, signed through Sigstore, stored by GitHub and pushed to the registry. `cosign verify` and `gh attestation verify` check them (`docs/security-pipeline.md`). The release also carries the SBOMs (SPDX and CycloneDX) and the attestation bundles as assets. A last job verifies the published image with both tools before the release is considered done.
- **Scanners, one per kind of finding,** all reporting SARIF to code scanning:

  | Job (workflow)                  | Tool                                 | Fails on                                       |
  | ------------------------------- | ------------------------------------ | ---------------------------------------------- |
  | `codeql` (`security.yml`)       | CodeQL, `security-extended`          | an alert of security severity high or critical |
  | `semgrep` (`security.yml`)      | Semgrep, OWASP Top 10 and Node rules | a finding of severity `ERROR`                  |
  | `secrets` (`security.yml`)      | Gitleaks over the git history        | any finding                                    |
  | `dependencies` (`security.yml`) | OSV-Scanner, `pnpm audit --prod`     | a vulnerability of CVSS 7.0 or more            |
  | `trivy-config` (`security.yml`) | Trivy misconfiguration scan          | a HIGH or CRITICAL misconfiguration            |
  | `build-scan` (`container.yml`)  | Trivy on both images, image checks   | a fixable HIGH or CRITICAL vulnerability       |
  | `zap` (`dast.yml`)              | OWASP ZAP API scan, authenticated    | a High alert; an incomplete rule; any 5xx      |
  | `scorecard` (`scorecard.yml`)   | OpenSSF Scorecard                    | never (score and SARIF only)                   |

  Dependency vulnerabilities come from OSV-Scanner only; Trivy scans configuration in the repository and packages in the images. Two tools reporting the same advisory would open the same alert twice. `pnpm audit` stays as an independent second opinion on production dependencies, without SARIF.

- **Pinned tools.** Actions are pinned by full commit SHA, which the repository also enforces; Dependabot updates them after a three-day cooldown, as for npm packages. Scanners run as container images pinned by digest in `.github/scanners/compose.yaml`, which Dependabot's `docker-compose` ecosystem keeps current. Images referenced from workflow steps would be invisible to it. No scanner is fetched as "latest" at run time. Trivy runs from its image, not through `trivy-action`, whose tags were the attack vector in March 2026.
- **Required checks without trigger filters.** Every required job runs on every pull request and always reports. The heavy ones (`build-scan`, `zap`) skip their steps inside the job when no source, dependency, image or Compose file changed, as `observability` does. A trigger-level `paths` filter would leave the check pending forever. A check joins the ruleset only after passing three runs in a row.
- **DAST that reaches the handlers, in two modes, never cut short.** The first measurements of the `zap` job showed a scan that looked complete and covered little. 92.7 % of its 3,849 requests were answered 400. ZAP builds its base requests from the OpenAPI document and could not guess valid values: emails, patterns, seeded ids and opaque cursors. It also wrote nullable fields without quotes, so the task bodies were not JSON. Every attack on those requests stopped at validation. The scan ran on one thread with a 120 ms delay to stay under the API's global rate limit, ending 30 seconds short of its 10-minute budget, and nothing would have failed had it been cut. Hence:
  - The scanner gets a copy of the OpenAPI document in which nullable unions are collapsed and every value it cannot guess has a valid `example` (`scripts/dast-openapi.ts`). The API's own document is unchanged.
  - The DAST stack raises every rate limit a thousandfold with `RATE_LIMIT_MULTIPLIER`, which production refuses. Without it, 289 of the corrected scan's requests were answered 429, all on `register` and `login`, the routes most worth attacking. The integration tests still prove the limits at their real values.
  - The scanner logs in as the seeded member through a ZAP hook, sends the token through a Replacer rule restricted to the API, and logs in again every ten minutes, so a scan of any length stays within the 15-minute token lifetime.
  - Pull requests (`zap`, required) run a policy written for a JSON API on Node.js and PostgreSQL (`.zap/pr.policy`): SQL injection (generic and PostgreSQL time-based), OS command injection, path traversal, template injection, CRLF injection, parameter tampering, external redirect, `.env` leaks, directory browsing and cloud metadata. The scan has a 12-minute budget and takes about 80 seconds in CI. Every installed rule runs nightly, on each published release and on demand (`zap-full`, not required), with a 180-minute budget, reporting to code scanning under its own category. The one exception is Log4Shell, which needs an out-of-band callback service the CI does not run and targets Java's Log4j.
  - A scan that did not run every rule of its policy to the end fails, whatever it found (`scripts/zap-gate.ts`). This covers a rule cut by the budget, a skipped rule, and a rule of the policy missing from the ZAP image. The job summary shows each rule's status, time, requests and alerts, and the status codes the scan received.
  - Any 5xx during the scan fails the job, in ZAP's count or in the API's own request log (`scripts/api-status.ts`), whatever severity ZAP gives it. ZAP rates a server error below High, so the corrected scan's first runs passed while the API answered 500 to a NUL character in a text field. An error the API cannot handle is a bug to fix, not an alert to triage. An empty request log also fails, so that missing data cannot pass as a clean scan.
- **Dismissals are written down.** A false positive or an accepted risk is ignored only in the scanner's own ignore file, with a reason and, where the tool supports it, an expiry date, and is listed in `docs/security-pipeline.md`. Alerts are never dismissed in the Security tab alone.

## Alternatives considered

- **`node:24-alpine` or a Debian slim runtime**: familiar and debuggable through a shell, but the shell, the package manager and their CVEs ship with every release, for no use at run time.
- **Chainguard/Wolfi images**: similar minimal images with fast CVE fixes, but only the latest tag is free, so pinning a supported line means following their release cadence instead of Node.js 24 LTS.
- **QEMU emulation for arm64**: simpler Dockerfile, but every `RUN` of the arm64 build is emulated (slow) and a native module built or installed under emulation is only as good as the emulator.
- **Separate builds for testing and publishing**: the common pattern (`load` to test, then `push` to publish), but nothing proves the published layers are those that were tested; only a deterministic cache would.
- **cosign with a stored key pair**: works without Sigstore's public infrastructure, but the key becomes a long-lived secret to protect and rotate, and its compromise signs anything.
- **BuildKit's own provenance and SBOM attestations**: embedded in the image index, but signed by nobody and invisible to `gh attestation verify`; GitHub's attestations are signed and tied to the workflow identity.
- **Publishing every `main` commit**: more images, more to sign and keep, and a registry full of versions nobody released. Releases already follow every user-facing change.
- **A time-boxed DAST scan that passes when cut**: predictable duration, but a scan stopped by its budget would report the rules it reached as if they were all it had. Rejected: a gate must know what it covered.
- **A passive baseline on pull requests, the active scan only on `main` and nightly**: fast, but an injection would be found after the merge, when a release pull request may already contain it.
- **ZAP's own `API-Minimal` policy on pull requests**: maintained by ZAP, but half of it targets XML, SOAP, PHP, Java and C runtimes. It also leaves out path traversal and PostgreSQL time-based injection. Those rules still run in the full scan.
- **Valid values through ZAP's form handler, or `example`s in the API's document**: the form handler cannot fix nullable unions, which ZAP still writes unquoted. Examples in the public document would tie the contract to one scanner and to the ids of one seeded database.
- **Disabling rate limits in the DAST stack**: simpler than a multiplier, but a disabled limiter is a code path production never runs. A raised one is the same code with a larger number.
- **Vendor actions for every scanner** (`trivy-action`, `gitleaks-action`, `osv-scanner-action`, `action-api-scan`): updated by Dependabot as actions, but each one downloads its scanner at run time, and some write to issues or need a licence key. The images in `.github/scanners` give the same updates with one pinned digest per tool.

## Consequences

- An image is verified with one `cosign verify` and one `gh attestation verify` command, against an identity that names this repository, the workflow and the release tag (`docs/security-pipeline.md`).
- Nothing reaches GHCR outside a release; a fix to a published image is a new release.
- The image has no shell: debugging happens from outside (`docker cp`, an ephemeral debug container sharing its namespaces), and the Compose `migrate` service passes the script only, since the entrypoint is already `node`.
- The container user is uid 65532: development signing keys mounted as Compose secrets must be readable by it (`chmod 644 keys/jwt-private.pem`, a throwaway key); in production the deploy owns the files (Phase 5).
- A new native production dependency must ship glibc builds for amd64 and arm64; the image checks fail otherwise.
- The publish job needs the package to be linked to this repository; its visibility on GHCR is set once, by hand, in the package settings.
- Scanner images and actions change only through reviewed Dependabot pull requests, which run the same gates.
- A finding that blocks a merge is either fixed or recorded with its reason; the Security tab shows the rest.
- A pull request that adds an endpoint or a field with a value ZAP cannot guess must add its example to `scripts/dast-openapi.ts`. Otherwise its base request is answered 400, which shows in the job summary's status counts.
- Rules outside the pull request policy report the next night, or on the release, not before the merge. A High alert from `zap-full` is fixed in a follow-up pull request.
- `RATE_LIMIT_MULTIPLIER` exists in the API's configuration. It is refused when `NODE_ENV` is `production`, and the API logs a warning whenever it is above 1.

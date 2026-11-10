# Security policy

## Supported versions

The project is pre-1.0 and released from `main`. Security fixes go into the next release; only the latest release is supported.

| Version        | Supported |
| -------------- | :-------: |
| Latest release |    ✅     |
| Older releases |    ❌     |

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub: **[Report a vulnerability](https://github.com/caiodassumpcao/secure-api-pipeline/security/advisories/new)** (Security tab → _Report a vulnerability_).

Please include:

- the affected component (API endpoint, container image, workflow, configuration) and version or commit;
- steps to reproduce or a proof of concept;
- the impact you expect (data exposure, privilege escalation, denial of service, …);
- any suggested fix or mitigation.

## What to expect

| Step                          | Target                                        |
| ----------------------------- | --------------------------------------------- |
| Acknowledgement               | 3 business days                               |
| Initial assessment and triage | 7 days                                        |
| Fix for critical / high       | as soon as possible, typically within 30 days |
| Fix for medium / low          | next planned release                          |

Fixes are published as a GitHub Security Advisory together with the release that contains them. With your permission, you will be credited in the advisory.

## Scope

In scope:

- source code in this repository (API, configuration, scripts);
- GitHub Actions workflows and the supply chain they produce (container images, SBOMs, signatures, provenance);
- `Dockerfile`, Compose files and, from v1.0, the deployment configuration under `deploy/`.

Out of scope:

- vulnerabilities in third-party dependencies that are not exploitable through this project — please report them upstream (Dependabot tracks them here);
- denial-of-service or load testing against any running deployment;
- social engineering and physical attacks;
- findings from automated scanners without a demonstrated impact.

## Safe harbor

Good-faith research that follows this policy — no privacy violations, no data destruction, no service degradation, and private disclosure — will not be pursued or reported to law enforcement.

## Security controls

How the project is secured — threat model, controls and the CI security pipeline — is described in the [design specification](docs/DESIGN.md#5-security-design).

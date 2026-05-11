# Security Policy

## Supported Versions

orrith is a single-developer project. Only the latest released version on npm receives security fixes.

| Version | Supported |
| ------- | --------- |
| Latest  | ✅        |
| Older   | ❌        |

## Reporting a Vulnerability

**Please do not file a public GitHub issue for security vulnerabilities.**

Report via GitHub's [Private Vulnerability Reporting](https://github.com/orrith/orrith/security/advisories/new) (preferred), or email **seiya9shimizu@gmail.com** with subject `[orrith security]`.

You will receive an initial response within **7 days**. As a solo-developer project, full triage and fix may take **up to 30 days** depending on severity.

## Scope

In scope:
- Code in this repository (`src/`, `bin/`, `presets/`, `distribution/`)
- Supply chain (dependencies, build process, npm package contents)

Out of scope:
- Vulnerabilities in user-provided `orrith.config.js` (config is user-controlled)
- Issues that require local filesystem access (orrith is a local dev tool by design)
- Default-port collisions or other configuration issues

## Hardening

orrith is designed for local development use only:
- Bound to `127.0.0.1` by default (not exposed externally)
- Strict CORS (localhost origin only)
- iframe sandbox without `allow-same-origin`
- No telemetry or external network calls except user-configured adapters

If you find a way to escape these boundaries, please report it.

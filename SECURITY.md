# Security

ActiveFS turns application data into a programmable filesystem. The source
that provides the data remains responsible for authentication, authorization,
path visibility, and the interpretation of opaque `auth` and `meta` values.

## Supported versions

| Version | Security status |
|---|---|
| `0.1.1` | Supported. |
| `0.1.0` and earlier | No security-fix commitment. |

ActiveFS is pre-1.0. Fixes normally land in the current source and ship with
the next lockstep package release. See
[Versioning](docs/reference/versioning.md) for the package policy.

## Report a vulnerability

Do not disclose a suspected vulnerability in a public issue, pull request, or
discussion.

1. Sign in to GitHub and open the
   [private vulnerability report](https://github.com/ankitparasher/activefs/security/advisories/new).
2. Describe the affected package and version, impact, reproduction steps, and
   any proposed mitigation.
3. Remove secrets, live credentials, private source data, and unnecessary
   personal information from the report.

If you cannot use the private form, do not post vulnerability details publicly.
Open a public issue that asks only for a private security-reporting route; a
maintainer can arrange private contact before you share the report.

GitHub private vulnerability reporting is enabled for this repository. Reports
submitted through that form are private to the repository's security
maintainers. Use the [support process](SUPPORT.md) only for ordinary bugs that
can be described safely in public.

## Security boundaries

- ActiveFS core forwards opaque `auth` and `meta`. It does not define users,
  roles, tenants, or provider policy.
- A hosted Source API must derive authoritative identity from the HTTP request;
  request-body context is not a credential boundary.
- Source servers must fail closed when path existence or metadata would reveal
  data the caller cannot access.
- WebDAV credentials are separate from Source API credentials.
- Cache and session isolation must use opaque, non-secret scope identifiers,
  never raw bearer tokens, cookies, JWTs, or email addresses.
- Logs, errors, exports, caches, and runtime state must not expose credentials
  or escape their configured roots.

Implementation guidance is in
[Security and identity](docs/guides/security-and-identity.md).

# Versioning

`0.1.1` is ActiveFS's first supported public release. All nine package entries
and their npm `latest` tags were verified at `0.1.1` on 2026-07-28. Package
versions and the Source API wire protocol use separate version numbers.

## Check the installed package line

An unpinned install follows npm's current `latest` tag. Check the registry when
you need the exact package version:

```bash
npm view activefs version dist-tags --json
```

## Lockstep packages

The nine public packages use one version for the `0.1.x` line:

- `activefs`
- `@activefs/core`
- `@activefs/config`
- `@activefs/source-http`
- `@activefs/local`
- `@activefs/mount`
- `@activefs/cli`
- `@activefs/mcp`
- `@activefs/testing`

A package-set release is complete only when all nine registry entries carry
the intended version. Do not infer the other eight versions from `activefs`
alone.

## Semver policy

ActiveFS is pre-1.0:

- package versions follow semantic-versioning notation;
- public exports should avoid unnecessary churn;
- breaking TypeScript API changes may still occur before `1.0.0` and should be
  called out in the changelog;
- publishable packages move together rather than mixing package versions; and
- a feature is part of a supported release only after it appears in the
  published package set and changelog.

## Source API protocol version

Source API v1 uses `protocolVersion: 1`. Additive capability fields may be
introduced without changing that value when clients can safely ignore them.
A package version change does not automatically change the protocol version.

## Changelog

User-visible changes belong in [CHANGELOG.md](../../CHANGELOG.md).

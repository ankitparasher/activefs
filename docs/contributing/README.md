# Contributing

Start here when you want to run checks, add examples, or validate a source
implementation against ActiveFS behavior.

Read the [repository contribution policy](../../CONTRIBUTING.md) before you
prepare a change. Then choose the check or contributor task below.

## Local checks

- [Testing](testing.md): local lint, typecheck, build, test, and automated
  workflow checks.
- [Source API conformance](source-api-conformance.md): validate a custom source
  or transport against the shared Source API behavior.
- [Source-checkout example index](../../examples/README.md): build, run, and
  test the repository examples.

## Where documentation belongs

Use this table before adding a new documentation page:

| Change | Put it in | Keep it focused on |
|---|---|---|
| User first-run flow | `README.md`, `docs/quickstart.md`, or `docs/guides/` | Copy-paste commands, expected output, and recovery steps. |
| Source-authoring tutorial | `docs/guides/` | A complete runnable path from setup to verification. |
| Public examples | `docs/examples/`, `examples/README.md`, or an example README | One learning pattern, source-checkout setup, paths exposed, and next examples. |
| Package-specific API usage | `packages/*/README.md` | Install command, small runnable example, package ownership, and deeper docs. |
| Exhaustive API shape | `docs/reference/` | Implemented behavior, parameters, returns, errors, and exact source links. |

Keep public documentation focused on supported user and contributor workflows.
Publishing a release uses maintainer-only procedures. Ask the project
maintainers before adding those procedures or unpublished project evidence to
public documentation.

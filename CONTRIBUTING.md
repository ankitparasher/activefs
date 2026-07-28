# Contributing

ActiveFS is a standalone programmable filesystem project. Keep contributions
generic: product-specific adapters, UI-framework adapters, Markdown renderers,
SRE or compliance systems, and business-domain policy belong outside this
repository.

## Set up the workspace

You need Node.js 22 or newer and pnpm 11.7.0. Enable the workspace's pinned
pnpm version and verify both tools before installing dependencies:

```bash
node --version
corepack enable pnpm
corepack prepare pnpm@11.7.0 --activate
pnpm --version
```

Run the contributor checks from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm smoke:examples
pnpm conformance:source-api
```

## Choose focused checks

For package, API, mount, Source API, CLI, TUI, MCP, or export changes, also run
the focused verification or conformance command for the area you changed.
For mounted-folder changes, document the host prerequisites used for manual
verification.

See [Testing](docs/contributing/testing.md) for the check matrix and
[Source API conformance](docs/contributing/source-api-conformance.md) when a
change affects an `ActiveFSTree` or Source API implementation.

## Document current behavior

Update docs with the behavior that is actually implemented and verified. Keep
Source API and mounted-folder claims separate, and be explicit when behavior
depends on host mount support.

## Licensing

Do not add or change licensing text without explicit project-owner approval.

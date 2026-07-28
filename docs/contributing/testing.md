# Testing

ActiveFS uses Vitest for unit and integration tests across the pnpm workspace.
Tests should exercise behavior through package entrypoints or stable adapter
interfaces rather than only asserting that mocks were called.

## Commands

```bash
pnpm lint
pnpm format:check
pnpm docs:links
pnpm test
pnpm coverage
pnpm typecheck
pnpm build
pnpm api:report:check
pnpm smoke:examples
pnpm conformance:source-api -- --out artifacts/conformance/source-api-conformance.json
```

## Documentation checks

Use these checks when a change touches README files, guides, examples, package
docs, or contribution boundaries:

| Documentation area | Command | What it proves |
|---|---|---|
| README and quickstart first-run flow | `pnpm smoke:readme-first` | The demo remote, direct list/read/grep commands, and cleanup work from a fresh workspace. |
| Public docs style guardrails | `pnpm format:check` | Public docs use direct `activefs` commands, canonical path forms, and supported first-run syntax. |
| Local docs links and anchors | `pnpm docs:links` | Relative Markdown links and section anchors resolve in the current checkout. |
| Public contribution boundary | `git diff --check` plus focused review | Public files contain no private prompts, personal absolute paths, private planning, or release-operator material. |
| MCP guide and package docs | `pnpm smoke:mcp` | Stdio and Streamable HTTP MCP flows work through built package entrypoints. |
| Example docs and commands | `pnpm smoke:examples` | Commands listed in the runnable example catalog build and run. |
| API reference drift | `pnpm api:report:check` | Generated API report content is current. |

Checks used only to publish a release are not part of this public contributor
workflow.

`pnpm smoke:readme-first`, `pnpm smoke:examples`, and `pnpm smoke:mcp` can start
loopback servers. In a restricted sandbox, loopback may fail even when the
product flow is healthy. Typical runner-only errors include:

```text
listen EPERM: operation not permitted 127.0.0.1
Source API discovery URL is not reachable: fetch failed
```

Rerun them in an environment that allows local TCP before treating the failure
as a product or docs problem.

## Runnable documentation examples

When a public doc shows a command or code example for users, make the example
copy-paste runnable unless the page clearly labels it as reference-only.

Use command examples to reduce perceived complexity:

- explain why the reader is running the command before the command block;
- put mandatory setup in its own short block;
- split independent checks into separate blocks instead of one long sequence;
- label optional commands as optional;
- show expected output or the observable result after commands that users are
  meant to run;
- when a short command has short output, prefer one `console` transcript block
  with a blank line between the `$ command` and its output;
- keep cleanup commands separate from verification commands.

Include:

- where the command is run, such as a new npm project or a source checkout;
- the packages to install;
- the file to create, usually `example.mjs` or `server.mjs`;
- the command to run;
- the expected output or observable result;
- any long-running process, port, or second-terminal requirement.

Prefer `.mjs` and `js` code fences for runnable ESM snippets. Public user flows
install the packaged CLI globally and use direct `activefs` commands. Do not
substitute a project-local npm execution form in documentation, even though it
can run the same binary, because it obscures the canonical installation model.

## Package README example checks

Package README snippets are documentation examples. They are not automatically
executed by `packages/testing/src/public-api-docs.test.ts`; that test checks
TSDoc coverage for exported declarations.

Before changing package README commands or code snippets, run the package's
behavior check and the API-report check:

| README | Minimum check |
|---|---|
| `packages/activefs/README.md` | `pnpm smoke:readme-first`, `pnpm api:report:check` |
| `packages/core/README.md` | `pnpm test`, `pnpm typecheck`, `pnpm api:report:check` |
| `packages/config/README.md` | `pnpm test`, `pnpm typecheck`, `pnpm smoke:readme-first` |
| `packages/source-http/README.md` | `pnpm conformance:source-api -- --out artifacts/conformance/source-api-conformance.json`, `pnpm smoke:examples` |
| `packages/local/README.md` | `pnpm smoke:readme-first`, `pnpm test`, `pnpm typecheck` |
| `packages/mount/README.md` | `pnpm smoke:mount:doctor`, `pnpm smoke:mount:http`, and the relevant host-mounted check when claiming real mounts |
| `packages/mcp/README.md` | `pnpm smoke:mcp` |
| `packages/testing/README.md` | `pnpm conformance:source-api -- --out artifacts/conformance/source-api-conformance.json` |
| `packages/cli/README.md` | `pnpm smoke:readme-first`, `pnpm smoke:mcp` when MCP commands change |

If a README example cannot be run from a fresh project or source checkout, label
the prerequisite directly next to the example. Do not leave a command that looks
copy-paste runnable but depends on an unstated remote, port, build output, or
second terminal.

## Mount validation

Build first:

```bash
pnpm build
```

Mount-sensitive work should run the portable checks:

```bash
pnpm smoke:mount
pnpm smoke:mount -- --doctor
pnpm smoke:mount -- --rclone-check
pnpm smoke:mount:doctor
pnpm smoke:mount:http
pnpm smoke:mount:rclone
pnpm smoke:mount:writes
```

`pnpm smoke:mount -- --rclone-check` proves rclone can list and read through
the WebDAV adapter without a real mounted directory. `pnpm smoke:mount:writes`
proves direct WebDAV write policy, committed writes, and zero-byte `PUT` to
`truncate(length: 0)`.

Run host-mounted checks only on machines with rclone and FUSE, macFUSE, or
WinFsp:

```bash
pnpm smoke:mount -- --mount-check
pnpm smoke:mount:real
```

`pnpm smoke:mount:real` is host validation. It requires rclone plus FUSE, macFUSE,
or WinFsp and should not be treated as an ActiveFSTree failure when the host
dependency is missing.

Before claiming mounted-folder support for a host family, record:

- `activefs doctor --mounts --json`
- `activefs mount status --json`
- manual reads through ordinary tools such as `ls`, `cat`, and `rg`
- basic policy-allowed writes through ordinary tools, when write support is
  being claimed
- the host-mounted check output for that platform

## Coverage

`pnpm coverage` runs `vitest run --coverage` with the V8 provider. The enforced
package-source thresholds are:

| Metric | Enforced minimum |
|---|---:|
| Statements | 83% |
| Lines | 84% |
| Branches | 74% |
| Functions | 86% |

Use the latest `pnpm coverage` output as the source of truth for current
coverage. These thresholds are regression floors for Vitest 4's V8 coverage
accounting. Raise them as coverage improves.

Coverage includes only `packages/*/src/**/*.ts`. It excludes:

- `**/*.test.ts`, because tests validate behavior and are not product code.
- `**/dist/**`, because built output duplicates source and changes after build.
- `examples/**`, because examples have separate builds and
  `pnpm smoke:examples` coverage.
- `scripts/**`, because package, benchmark, and host-validation scripts depend
  on external tools and are validated by their named verification commands.

## Expected tests

Every public API change should cover:

- normal behavior through the public entrypoint;
- invalid input and expected failure behavior;
- path normalization, mounted-prefix routing, and cross-source rejection where
  relevant;
- opaque `auth` and `meta` context forwarding without interpretation;
- cache invalidation, persistence, journal, session, and activity side effects
  when those areas change;
- serialization/deserialization at HTTP, CLI, WebDAV, MCP, and config
  boundaries;
- `pnpm smoke:mcp` when the MCP server or package metadata changes;
- adapter security invariants such as credential redaction, private-token
  storage, remote-owned writable paths, symlink escape rejection, and cache
  trust downgrades.

Avoid tests that only assert a mock was called, snapshot-only tests for
important logic, and coverage-padding tests that do not validate behavior.

## Checks by area

Security tests should prove:

- Core passes `auth` and `meta` through without interpreting them.
- Trees enforce visibility for `info`, `list`, `read`, and `search`.
- Search does not return paths unreadable for the same opaque context.
- Cache keys do not contain raw credentials.
- WebDAV rejects unauthorized local requests when auth is enabled.
- Auth provider command strings are never evaluated by a shell.

Cache and freshness tests should prove:

- Context-sensitive results are not reused without a safe opaque cache scope.
- Version changes invalidate content.
- TTL expiry triggers revalidation.
- Support/debug invalidation clears recursive subtree entries.
- Search cache changes when tree index version changes.
- Mounted refresh failure is visible.
- Committed server writes invalidate affected paths.

Search tests should verify:

- Source search or a source command handler is used when available.
- ActiveFS scan produces the same default matching behavior through
  `list`/`read`.
- Limited or otherwise incomplete results include a typed reason.
- Nested mounts are included when search starts at a virtual parent or a root
  mount that contains more-specific mounts.
- Dynamic non-enumerable routes are not discovered by ActiveFS scan.
- Search results do not expose paths that `stat` or `read` would deny for the
  same opaque context.

Dynamic route tests should prove:

- Known authorized paths resolve and read.
- Unknown paths return not found.
- Unauthorized paths do not leak existence.
- Parent listing does not enumerate protected IDs.
- Export requires explicit concrete paths.
- ActiveFS scan does not discover non-enumerable paths.

TUI coverage should include:

- Example source browsing, preview, copy, and export.
- Local source browsing.
- Remote add, edit, test, and remove flows.
- Mount start, remount, unmount, and failure states.
- Cache clear and invalidate flows.
- Search prompt, result rendering, copy, and open-result flows.
- Health, session/freshness, operation journal, activity backlog, and diagnostic
  snapshot redaction.
- Settings tab source and mount config counts.
- Debug mode redaction boundaries.

MCP coverage should include:

- In-memory SDK client/server tests for resources, templates, tools, prompts,
  pagination, policy denial, and subscriptions.
- `pnpm smoke:mcp`, which checks both stdio and Streamable HTTP.

Export coverage should prove:

- Export uses direct core/tree calls, not mounted paths.
- Export preserves exact bytes.
- Manifests are written atomically.
- Explicit single-file export works.
- Incomplete exports are reported honestly.
- Raw credentials stay out of manifests.

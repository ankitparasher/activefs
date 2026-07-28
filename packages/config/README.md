# @activefs/config

Install `@activefs/config` when host code needs to discover or manage an
ActiveFS state root programmatically. Most users should let the `activefs` CLI
create and update `.activefs/config.json`.

The package requires Node.js 22 or newer.

## Install

```bash
npm install @activefs/config
```

## Read workspace configuration

Run this example from a project directory:

```js
import {
  loadActiveFSConfig,
  resolveActiveFSState
} from "@activefs/config";

const state = resolveActiveFSState(process.cwd());
const config = await loadActiveFSConfig(state.stateDir);

console.log(state.stateDir);
console.log(Object.keys(config.remotes));
```

In a new project, the remote list is empty. Loading missing configuration does
not create files; write helpers create the state directory only when they save
configuration.

## What this package owns

- state-root discovery and canonical state paths;
- `.activefs/config.json` loading, normalization, and saving;
- remote descriptors and optional mountpoint associations; and
- host-managed auth-provider descriptors and local policy helpers.

Configuration describes how to reach a source. It does not become the
authority for source data or final access decisions. Store credential
descriptors in config, not raw Source API secrets; the source still interprets
identity and policy.

## Documentation

- [CLI configuration and auth](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/cli.md)
- [Security and identity](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/security-and-identity.md)
- [Current limits](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/current-limits.md)

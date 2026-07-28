import type {
  ActiveFS,
  ActiveFSContext,
  ActiveFSPath,
  ActiveFSWatchSubscription
} from "@activefs/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ActiveFSMCPRemote } from "./index.js";
import {
  activeFSMCPRemotePath,
  activeFSMCPResourceUri,
  activeFSMCPRuntimePath,
  parseActiveFSMCPUri
} from "./uri.js";

interface ActiveFSMCPSubscription<Auth = unknown, Meta = unknown> {
  uri: string;
  remote: Required<Pick<ActiveFSMCPRemote, "name" | "rootPath">> & Pick<ActiveFSMCPRemote, "title">;
  path: ActiveFSPath;
  handle: ActiveFSWatchSubscription;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ActiveFSMCPSubscriptionManagerOptions<Auth = unknown, Meta = unknown> {
  filesystem: ActiveFS<Auth, Meta>;
  remotes: ActiveFSMCPRemote[];
  server: Server;
  debounceMs: number;
}

export class ActiveFSMCPSubscriptionManager<Auth = unknown, Meta = unknown> {
  private readonly subscriptions = new Map<string, ActiveFSMCPSubscription<Auth, Meta>>();

  constructor(private readonly options: ActiveFSMCPSubscriptionManagerOptions<Auth, Meta>) {}

  async subscribe(uri: string, context: ActiveFSContext<Auth, Meta>): Promise<void> {
    if (this.subscriptions.has(uri)) {
      return;
    }
    const parsed = parseActiveFSMCPUri(uri, this.options.remotes);
    const runtimePath = activeFSMCPRuntimePath(parsed.remote, parsed.path);
    const subscription: ActiveFSMCPSubscription<Auth, Meta> = {
      uri,
      remote: parsed.remote,
      path: parsed.path,
      handle: await this.options.filesystem.watch(
        context,
        runtimePath,
        (event) => {
          const remotePath = activeFSMCPRemotePath(parsed.remote, event.path);
          this.queueNotification(uri, activeFSMCPResourceUri(parsed.remote.name, remotePath));
        },
        { recursive: true }
      )
    };
    this.subscriptions.set(uri, subscription);
  }

  async unsubscribe(uri: string): Promise<void> {
    const subscription = this.subscriptions.get(uri);
    if (!subscription) {
      return;
    }
    this.subscriptions.delete(uri);
    if (subscription.timer) {
      clearTimeout(subscription.timer);
    }
    await subscription.handle.close();
  }

  async close(): Promise<void> {
    const subscriptions = [...this.subscriptions.keys()];
    await Promise.all(subscriptions.map((uri) => this.unsubscribe(uri)));
  }

  private queueNotification(subscriptionUri: string, updatedUri: string): void {
    const subscription = this.subscriptions.get(subscriptionUri);
    if (!subscription) {
      return;
    }
    if (subscription.timer) {
      clearTimeout(subscription.timer);
    }
    subscription.timer = setTimeout(() => {
      subscription.timer = undefined;
      void this.options.server.sendResourceUpdated({ uri: updatedUri }).catch(() => undefined);
      void this.options.server.sendResourceListChanged().catch(() => undefined);
    }, this.options.debounceMs);
  }
}

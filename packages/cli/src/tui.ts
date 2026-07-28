import {
  normalizeActiveFSPath,
  type ActiveFS,
  type ActiveFSDirEntry,
  type ActiveFSSearchMatch,
  type ActiveFSPath,
  type ActiveFSStat
} from "@activefs/core";
import {
  exportTree,
  type ExportTreeManifest
} from "@activefs/local";
import {
  clearMountCache,
  createMountLayout,
  loadActiveFSMountConfig,
  mountRcloneWebDAV,
  refreshRcloneMount,
  removeActiveFSMountRemote,
  remountRcloneWebDAV,
  tailMountLogs,
  unmountRcloneMount,
  type ActiveFSMountRemote,
  type MountCommandRunner,
  type RcloneMountActiveWaiter,
  type RcloneMountProcessSpawner,
  type RcloneMountStatus
} from "@activefs/mount";
import { upsertActiveFSRemote } from "@activefs/config";
import { parseActiveFSTreeRemoteSpec } from "@activefs/source-http";
import blessed from "blessed";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  createActiveFSStatusSummary,
  formatSessionStatus,
  writeActiveFSDiagnosticSnapshot,
  type ActiveFSRemoteStatusSummary,
  type ActiveFSTreeApiStatus,
  type ActiveFSStatusSummary
} from "./statusSummary.js";
import { activeFSAsTree, type ActiveFSTuiSourceDescriptor } from "./tuiSources.js";

export type ActiveFSTuiScreen = "health" | "remotes" | "mounts" | "cache" | "browser" | "search" | "logs" | "settings";

export interface ActiveFSTuiOptions {
  filesystem: ActiveFS;
  sources?: ActiveFSTuiSourceDescriptor[];
  rootDir?: string;
  exportDir?: string;
  commandRunner?: MountCommandRunner;
  mountProcessSpawner?: RcloneMountProcessSpawner;
  waitForMountActive?: RcloneMountActiveWaiter;
  enableRcloneRc?: boolean;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  debug?: boolean;
  input?: Readable;
  output?: Writable;
  openPath?: (path: string) => void | Promise<void>;
  writeClipboard?: (text: string) => void | Promise<void>;
}

export type TuiRemoteRow = ActiveFSRemoteStatusSummary;

export interface TuiMountRow {
  name: string;
  status: RcloneMountStatus;
  remote?: ActiveFSRemoteStatusSummary;
}

export interface TuiCacheRow {
  remote: string;
  mode: string;
  fileCount: number;
  byteSize: number;
  debugPath?: string;
}

export interface TuiBrowserView {
  path: ActiveFSPath;
  source?: ActiveFSTuiSourceDescriptor;
  stat: ActiveFSStat | null;
  entries: ActiveFSDirEntry[];
  selectedPath: ActiveFSPath;
  preview: string;
}

export interface TuiLogsView {
  remote: string;
  webdav: string;
  rclone: string;
}

export interface TuiSearchView {
  root: ActiveFSPath;
  pattern: string;
  strategy: string;
  complete: boolean;
  matches: ActiveFSSearchMatch[];
  error?: string;
}

export interface TuiSettingsView {
  rootDir: string;
  exportDir: string;
  sourceCount: number;
  mountRemoteCount: number;
  debug: boolean;
}

export interface TuiSnapshot {
  screen: ActiveFSTuiScreen;
  rootDir: string;
  exportDir: string;
  sources: ActiveFSTuiSourceDescriptor[];
  health: ActiveFSStatusSummary;
  remotes: TuiRemoteRow[];
  mounts: TuiMountRow[];
  cache: TuiCacheRow[];
  browser: TuiBrowserView;
  search: TuiSearchView;
  logs: TuiLogsView[];
  settings: TuiSettingsView;
  status: string;
  debug: boolean;
}

interface BlessedProgramKeys {
  key(keys: string[] | string, listener: () => void): void;
}

interface BlessedKeypress {
  full?: string;
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const SCREENS: ActiveFSTuiScreen[] = ["health", "remotes", "mounts", "cache", "browser", "search", "logs", "settings"];
const DEFAULT_ROOT_DIR = ".activefs";
const DEFAULT_EXPORT_DIR = ".activefs/exports";
const SEARCH_MAX_RESULTS = 100;
const THEME = {
  accent: "cyan",
  active: "green",
  danger: "red",
  muted: "gray",
  panel: "black",
  text: "white",
  warning: "yellow"
} as const;

export function createActiveFSTuiController(options: ActiveFSTuiOptions): ActiveFSTuiController {
  return new ActiveFSTuiController(options);
}

export class ActiveFSTuiController {
  private readonly filesystem: ActiveFS;
  private readonly sources: ActiveFSTuiSourceDescriptor[];
  private readonly rootDir: string;
  private readonly exportDir: string;
  private readonly commandRunner: MountCommandRunner | undefined;
  private readonly mountProcessSpawner: RcloneMountProcessSpawner | undefined;
  private readonly waitForMountActive: RcloneMountActiveWaiter | undefined;
  private readonly enableRcloneRc: boolean;
  private readonly platform: NodeJS.Platform | undefined;
  private readonly fetcher: typeof fetch | undefined;
  private readonly debug: boolean;
  private readonly openPathHandler: (path: string) => void | Promise<void>;
  private readonly clipboardWriter: (text: string) => void | Promise<void>;
  private screen: ActiveFSTuiScreen = "health";
  private browserPath: ActiveFSPath = "/";
  private searchView: TuiSearchView = {
    root: "/",
    pattern: "",
    strategy: "idle",
    complete: true,
    matches: []
  };
  private statusMessage = "Ready.";
  private readonly selections = new Map<ActiveFSTuiScreen, number>();

  constructor(options: ActiveFSTuiOptions) {
    this.filesystem = options.filesystem;
    this.sources = options.sources ?? [
      {
        id: "default",
        label: "Default",
        kind: "example",
        mountPath: "/",
        detail: "Caller-provided ActiveFS filesystem."
      }
    ];
    this.rootDir = resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
    this.exportDir = resolve(options.exportDir ?? DEFAULT_EXPORT_DIR);
    this.commandRunner = options.commandRunner;
    this.mountProcessSpawner = options.mountProcessSpawner;
    this.waitForMountActive = options.waitForMountActive;
    this.enableRcloneRc = options.enableRcloneRc !== false;
    this.platform = options.platform;
    this.fetcher = options.fetch;
    this.debug = Boolean(options.debug);
    this.openPathHandler = options.openPath ?? openPathWithPlatform;
    this.clipboardWriter = options.writeClipboard ?? writeOsc52Clipboard;
  }

  get activeScreen(): ActiveFSTuiScreen {
    return this.screen;
  }

  setScreen(screen: ActiveFSTuiScreen): void {
    this.screen = screen;
  }

  cycleScreen(delta: 1 | -1): void {
    const current = SCREENS.indexOf(this.screen);
    this.screen = SCREENS[(current + delta + SCREENS.length) % SCREENS.length]!;
  }

  moveSelection(delta: number, itemCount: number): void {
    if (itemCount <= 0) {
      this.selections.set(this.screen, 0);
      return;
    }
    const current = this.selectedIndex(this.screen);
    this.selections.set(this.screen, clamp(current + delta, 0, itemCount - 1));
  }

  selectedIndex(screen = this.screen): number {
    return this.selections.get(screen) ?? 0;
  }

  setStatus(message: string): void {
    this.statusMessage = message;
  }

  async refresh(): Promise<TuiSnapshot> {
    const health = await createActiveFSStatusSummary({
      rootDir: this.rootDir,
      commandRunner: this.commandRunner,
      platform: this.platform,
      fetch: this.fetcher,
      timeoutMs: 500
    });
    const remotes = health.remotes;
    const [browser, logs] = await Promise.all([
      this.readBrowser(),
      this.readLogs(remotes)
    ]);
    const mounts = this.listMounts(health);
    const cache = this.listCache(health);
    return {
      screen: this.screen,
      rootDir: this.rootDir,
      exportDir: this.exportDir,
      sources: this.sources,
      health,
      remotes,
      mounts,
      cache,
      browser,
      search: this.searchView,
      logs,
      settings: {
        rootDir: this.rootDir,
        exportDir: this.exportDir,
        sourceCount: this.sources.length,
        mountRemoteCount: remotes.length,
        debug: this.debug
      },
      status: this.statusMessage,
      debug: this.debug
    };
  }

  async addRemote(spec: string): Promise<void> {
    const remote = parseActiveFSTreeRemoteSpec(spec);
    await upsertActiveFSRemote(this.rootDir, {
      name: remote.name,
      url: remote.url,
      mountPath: remote.mountPath,
      remoteRoot: "/",
      managedWebDAV: { enabled: true, host: "127.0.0.1" },
      adapterCapabilityProfile: "full-filesystem-semantics",
      cacheMode: "off"
    });
    this.statusMessage = `Added remote ${remote.name}.`;
  }

  async editRemote(existingName: string, spec: string): Promise<void> {
    const remote = parseActiveFSTreeRemoteSpec(spec);
    if (existingName !== remote.name) {
      await removeActiveFSMountRemote(this.rootDir, existingName);
    }
    await upsertActiveFSRemote(this.rootDir, {
      name: remote.name,
      url: remote.url,
      mountPath: remote.mountPath,
      remoteRoot: "/",
      managedWebDAV: { enabled: true, host: "127.0.0.1" },
      adapterCapabilityProfile: "full-filesystem-semantics",
      cacheMode: "off"
    });
    this.statusMessage = `Saved remote ${remote.name}.`;
  }

  async removeRemote(name: string): Promise<void> {
    const result = await removeActiveFSMountRemote(this.rootDir, name, {
      commandRunner: this.commandRunner,
      platform: this.platform,
      fetch: this.fetcher,
      timeoutMs: 500,
      cleanupRuntime: true
    });
    this.statusMessage = result.removed
      ? `Removed remote ${name}. Runtime state was cleaned when possible.`
      : `Remote ${name} was not configured.`;
  }

  async testRemote(name: string): Promise<ActiveFSTreeApiStatus | undefined> {
    const summary = await createActiveFSStatusSummary({
      rootDir: this.rootDir,
      remoteName: name,
      commandRunner: this.commandRunner,
      platform: this.platform,
      fetch: this.fetcher,
      timeoutMs: 1500
    });
    const source = summary.remotes[0]?.source;
    this.statusMessage = `${name}: Source API ${source?.reachable ? "reachable" : "unreachable"}.`;
    return source;
  }

  async mount(name: string): Promise<RcloneMountStatus> {
    const remote = await this.requireRemote(name);
    const layout = createMountLayout(this.rootDir, remote.name);
    const result = await mountRcloneWebDAV({
      remote,
      layout,
      commandRunner: this.commandRunner,
      processSpawner: this.mountProcessSpawner,
      waitForMountActive: this.waitForMountActive,
      platform: this.platform,
      enableRc: this.enableRcloneRc,
      daemon: true,
      readOnly: true
    });
    this.statusMessage = `${remote.name}: ${result.status.state}.`;
    return result.status;
  }

  async unmount(name: string): Promise<RcloneMountStatus> {
    const layout = createMountLayout(this.rootDir, name);
    const status = await unmountRcloneMount(layout, {
      commandRunner: this.commandRunner,
      platform: this.platform
    });
    this.statusMessage = `${name}: ${status.state}.`;
    return status;
  }

  async remount(name: string): Promise<RcloneMountStatus> {
    const remote = await this.requireRemote(name);
    const layout = createMountLayout(this.rootDir, remote.name);
    const result = await remountRcloneWebDAV({
      remote,
      layout,
      daemon: true,
      readOnly: true,
      commandRunner: this.commandRunner,
      processSpawner: this.mountProcessSpawner,
      waitForMountActive: this.waitForMountActive,
      platform: this.platform,
      enableRc: this.enableRcloneRc
    });
    this.statusMessage = `${remote.name}: ${result.status.state}.`;
    return result.status;
  }

  async openMountedPath(name: string): Promise<void> {
    const layout = createMountLayout(this.rootDir, name);
    await this.openPathHandler(layout.vfsDir);
    this.statusMessage = `Opened ${layout.vfsDir}.`;
  }

  async clearCache(remote: string): Promise<void> {
    const layout = createMountLayout(this.rootDir, remote);
    const result = await clearMountCache(layout);
    this.statusMessage = `Cleared ${formatBytes(result.clearedBytes)} from ${remote}.`;
  }

  async invalidatePath(remote: string, path: string): Promise<void> {
    const normalizedPath = normalizeActiveFSPath(path);
    const layout = createMountLayout(this.rootDir, remote);
    const config = await loadActiveFSMountConfig(this.rootDir);
    const mountRemote = config.remotes[remote];
    const result = await refreshRcloneMount(layout, {
      remote: mountRemote,
      path: normalizedPath,
      recursive: true,
      commandRunner: this.commandRunner,
      platform: this.platform,
      fetch: this.fetcher
    });
    if (!result.ok) {
      throw new Error(result.error ?? `Could not invalidate ${remote}:${normalizedPath}`);
    }
    this.statusMessage = `Invalidated ${remote}:${normalizedPath}.`;
  }

  async openBrowserSelection(): Promise<void> {
    const view = await this.readBrowser();
    const entry = view.entries[this.selectedIndex("browser")];
    if (!entry) {
      return;
    }
    if (entry.kind === "directory") {
      this.browserPath = entry.path;
      this.selections.set("browser", 0);
      this.statusMessage = `Opened ${entry.path}.`;
    } else {
      this.statusMessage = `Previewing ${entry.path}.`;
    }
  }

  goBrowserParent(): void {
    if (this.browserPath === "/") {
      return;
    }
    const parent = this.browserPath.split("/").slice(0, -1).join("/") || "/";
    this.browserPath = normalizeActiveFSPath(parent);
    this.selections.set("browser", 0);
    this.statusMessage = `Opened ${this.browserPath}.`;
  }

  async copySelectedVirtualPath(): Promise<string> {
    const path = await this.selectedBrowserPath();
    await this.clipboardWriter(path);
    this.statusMessage = `Copied ${path}.`;
    return path;
  }

  async copySelectedSearchPath(): Promise<string | undefined> {
    const match = this.searchView.matches[this.selectedIndex("search")];
    if (!match) {
      return undefined;
    }
    await this.clipboardWriter(match.path);
    this.statusMessage = `Copied ${match.path}.`;
    return match.path;
  }

  cycleBrowserSource(delta: 1 | -1): void {
    if (this.sources.length === 0) {
      return;
    }
    const currentSource = this.sourceForPath(this.browserPath);
    const currentIndex = Math.max(
      0,
      this.sources.findIndex((source) => source.id === currentSource?.id)
    );
    const next = this.sources[(currentIndex + delta + this.sources.length) % this.sources.length]!;
    this.browserPath = next.mountPath;
    this.selections.set("browser", 0);
    this.statusMessage = `Selected source ${next.label}.`;
  }

  async exportSelectedPath(outDir?: string): Promise<ExportTreeManifest> {
    const path = await this.selectedBrowserPath();
    const targetDir = outDir ?? join(this.exportDir, pathToDirectoryName(path));
    const source = activeFSAsTree(this.filesystem);
    const manifest = await exportTree(source, targetDir, {
      rootPath: path
    });
    this.statusMessage = `Exported ${manifest.entries.length} file${manifest.entries.length === 1 ? "" : "s"} to ${targetDir}.`;
    return manifest;
  }

  async search(pattern: string): Promise<void> {
    const trimmed = pattern.trim();
    if (!trimmed) {
      this.statusMessage = "Search cancelled.";
      return;
    }
    const root = this.browserPath;
    try {
      const result = await this.filesystem.search({}, root, {
        pattern: trimmed,
        maxResults: SEARCH_MAX_RESULTS,
        includeNonEnumerable: false
      });
      this.searchView = {
        root,
        pattern: trimmed,
        strategy: result.strategy,
        complete: result.complete,
        matches: result.matches
      };
      this.selections.set("search", 0);
      this.screen = "search";
      this.statusMessage = `Search found ${result.matches.length} match${result.matches.length === 1 ? "" : "es"}.`;
    } catch (error) {
      this.searchView = {
        root,
        pattern: trimmed,
        strategy: "error",
        complete: false,
        matches: [],
        error: error instanceof Error ? error.message : String(error)
      };
      this.screen = "search";
      this.statusMessage = this.searchView.error ?? "Search failed.";
    }
  }

  async openSearchSelection(): Promise<void> {
    const match = this.searchView.matches[this.selectedIndex("search")];
    if (!match) {
      return;
    }
    const parent = parentPath(match.path);
    this.browserPath = parent;
    const view = await this.readBrowser();
    const index = view.entries.findIndex((entry) => entry.path === match.path);
    this.selections.set("browser", Math.max(index, 0));
    this.screen = "browser";
    this.statusMessage = `Selected ${match.path}.`;
  }

  async saveDiagnosticSnapshot(): Promise<string> {
    const summary = await createActiveFSStatusSummary({
      rootDir: this.rootDir,
      commandRunner: this.commandRunner,
      platform: this.platform,
      fetch: this.fetcher,
      timeoutMs: 500
    });
    const path = join(this.rootDir, "diagnostics", `tui-health-${timestampForFile(new Date())}.json`);
    await writeActiveFSDiagnosticSnapshot(path, summary, this.screen);
    this.statusMessage = `Saved diagnostics to ${path}.`;
    return path;
  }

  private listMounts(health: ActiveFSStatusSummary): TuiMountRow[] {
    return health.remotes
      .filter((remote) => remote.mount)
      .map((remote) => ({
        name: remote.name,
        status: remote.mount!,
        remote
      }));
  }

  private listCache(health: ActiveFSStatusSummary): TuiCacheRow[] {
    return health.remotes.map((remote) => ({
      remote: remote.name,
      mode: remote.cache.mode,
      fileCount: remote.cache.fileCount ?? 0,
      byteSize: remote.cache.byteSize ?? 0,
      debugPath: this.debug ? createMountLayout(this.rootDir, remote.name).cacheDir : undefined
    }));
  }

  private async readBrowser(): Promise<TuiBrowserView> {
    const source = this.sourceForPath(this.browserPath);
    try {
      const statResult = await this.filesystem.stat({}, this.browserPath);
      let entries: ActiveFSDirEntry[] = [];
      if (statResult?.kind === "directory") {
        entries = await this.filesystem.list({}, this.browserPath);
        entries.sort(compareEntries);
      }
      const selected = entries[this.selectedIndex("browser")];
      const selectedPath = selected?.path ?? this.browserPath;
      return {
        path: this.browserPath,
        source,
        stat: statResult,
        entries,
        selectedPath,
        preview: await this.previewPath(selectedPath).catch((error) => `Preview unavailable: ${errorMessage(error)}`)
      };
    } catch (error) {
      return {
        path: this.browserPath,
        source,
        stat: null,
        entries: [],
        selectedPath: this.browserPath,
        preview: `Browser unavailable: ${errorMessage(error)}`
      };
    }
  }

  private async previewPath(path: ActiveFSPath): Promise<string> {
    const statResult = await this.filesystem.stat({}, path);
    if (!statResult) {
      return "Path not found.";
    }
    const lines = [
      `${statResult.kind.toUpperCase()} ${path}`,
      statResult.size === undefined ? undefined : `${statResult.size} bytes`,
      statResult.capabilities ? `capabilities: ${Object.keys(statResult.capabilities).filter((key) => Boolean(statResult.capabilities?.[key as keyof typeof statResult.capabilities])).join(", ")}` : undefined
    ].filter(Boolean) as string[];
    if (statResult.kind !== "file") {
      return lines.join("\n");
    }
    const readResult = await this.filesystem.read({}, path, {
      length: 16_384,
      encoding: "utf8"
    });
    return [...lines, "", contentPreview(readResult.content)].join("\n");
  }

  private async readLogs(remotes: TuiRemoteRow[]): Promise<TuiLogsView[]> {
    const logs: TuiLogsView[] = [];
    for (const remote of remotes) {
      const layout = createMountLayout(this.rootDir, remote.name);
      logs.push(await tailMountLogs(layout));
    }
    return logs;
  }

  private async requireRemote(name: string): Promise<ActiveFSMountRemote> {
    const config = await loadActiveFSMountConfig(this.rootDir);
    const remote = config.remotes[name];
    if (!remote) {
      throw new Error(`Unknown ActiveFS remote: ${name}. For a local demo, run activefs remote add repo --demo --port 3999.`);
    }
    return remote;
  }

  private async selectedBrowserPath(): Promise<ActiveFSPath> {
    const view = await this.readBrowser();
    return view.entries[this.selectedIndex("browser")]?.path ?? view.path;
  }

  private sourceForPath(path: ActiveFSPath): ActiveFSTuiSourceDescriptor | undefined {
    return this.sources
      .filter((source) =>
        source.mountPath === "/"
          ? path.startsWith("/")
          : path === source.mountPath || path.startsWith(`${source.mountPath}/`)
      )
      .sort((left, right) => right.mountPath.length - left.mountPath.length)[0];
  }
}

export async function runActiveFSTui(options: ActiveFSTuiOptions): Promise<void> {
  const controller = createActiveFSTuiController(options);
  const screen = blessed.screen({
    input: options.input as never,
    output: options.output as never,
    terminal: "xterm-256color",
    smartCSR: true,
    title: "ActiveFS TUI"
  });
  const tabs = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { fg: THEME.accent, bg: THEME.panel }
  });
  const list = blessed.list({
    parent: screen,
    top: 1,
    left: 0,
    width: "38%",
    height: "100%-3",
    keys: false,
    mouse: true,
    tags: true,
    border: "line",
    label: " Items ",
    style: {
      border: { fg: THEME.accent },
      selected: { bg: THEME.active, fg: THEME.panel, bold: true },
      item: { fg: THEME.text }
    }
  });
  const detail = blessed.box({
    parent: screen,
    top: 1,
    left: "38%",
    width: "62%",
    height: "100%-3",
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    border: "line",
    label: " Detail ",
    tags: true,
    style: {
      border: { fg: THEME.accent },
      fg: THEME.text,
      scrollbar: { bg: THEME.active }
    }
  });
  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 2,
    tags: true,
    style: { fg: THEME.text, bg: THEME.panel }
  });
  const prompt = blessed.prompt({
    parent: screen,
    border: "line",
    height: 7,
    width: "60%",
    top: "center",
    left: "center",
    label: " ActiveFS ",
    keys: true,
    vi: true,
    style: {
      border: { fg: THEME.warning },
      fg: THEME.text
    }
  });
  const question = blessed.question({
    parent: screen,
    border: "line",
    height: 7,
    width: "60%",
    top: "center",
    left: "center",
    label: " Confirm ",
    keys: true,
    style: {
      border: { fg: THEME.warning },
      fg: THEME.text
    }
  });
  const help = blessed.message({
    parent: screen,
    border: "line",
    height: "70%",
    width: "72%",
    top: "center",
    left: "center",
    label: " Help ",
    keys: true,
    vi: true,
    scrollable: true,
    style: {
      border: { fg: THEME.accent },
      fg: THEME.text
    }
  });
  prompt.hide();
  question.hide();
  help.hide();
  const programKeys = (screen as unknown as { program: BlessedProgramKeys }).program;
  let overlayActive = false;
  let tuiClosed = false;
  let programHandledKey: string | undefined;
  const inputKeyHandlers = new Map<string, () => void>();
  const inputKeypressFallback = (ch: string | undefined, key: BlessedKeypress = {}): void => {
    const full = normalizeBlessedKey(ch, key);
    if (!full) {
      return;
    }
    if (programHandledKey === full) {
      programHandledKey = undefined;
      return;
    }
    inputKeyHandlers.get(full)?.();
  };
  options.input?.on("keypress", inputKeypressFallback as never);

  let snapshot = await controller.refresh();

  const render = async (): Promise<void> => {
    if (tuiClosed) {
      return;
    }
    const nextSnapshot = await controller.refresh();
    if (tuiClosed) {
      return;
    }
    snapshot = nextSnapshot;
    tabs.setContent(renderTabs(snapshot.screen));
    const rendered = renderScreen(snapshot, controller.selectedIndex(snapshot.screen));
    list.setLabel(` ${titleCase(snapshot.screen)} `);
    list.setItems(rendered.items.length > 0 ? rendered.items : ["(empty)"]);
    list.select(Math.min(controller.selectedIndex(snapshot.screen), Math.max(rendered.items.length - 1, 0)));
    detail.setLabel(` ${rendered.detailTitle} `);
    detail.setContent(rendered.detail);
    detail.setScroll(0);
    footer.setContent(renderFooter(snapshot));
    screen.render();
  };

  const safeRender = async (): Promise<void> => {
    try {
      await render();
    } catch (error) {
      if (tuiClosed) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      controller.setStatus(message);
      footer.setContent(renderFooter({ ...snapshot, status: message }));
      screen.render();
    }
  };

  const runAction = async (action: () => Promise<void> | void): Promise<void> => {
    try {
      await action();
    } catch (error) {
      controller.setStatus(error instanceof Error ? error.message : String(error));
    }
    await safeRender();
  };

  const selectedRemoteName = (
    rows: Array<{ name?: string; remote?: string | ActiveFSRemoteStatusSummary }>
  ): string | undefined => {
    const row = rows[controller.selectedIndex(snapshot.screen)];
    if (!row) {
      return undefined;
    }
    if (typeof row.name === "string") {
      return row.name;
    }
    return typeof row.remote === "string" ? row.remote : undefined;
  };

  const bindKey = (
    keys: string[],
    handler: () => void,
    options: { allowDuringOverlay?: boolean } = {}
  ): void => {
    for (const key of expandBlessedKeys(keys)) {
      const guardedHandler = () => {
        if (overlayActive && !options.allowDuringOverlay) {
          return;
        }
        handler();
      };
      inputKeyHandlers.set(key, guardedHandler);
      programKeys.key(key, () => {
        programHandledKey = key;
        guardedHandler();
      });
    }
  };

  const askPrompt = (label: string, value: string, handler: (value: string) => void): void => {
    overlayActive = true;
    prompt.input(label, value, (_error: unknown, inputValue: unknown) => {
      overlayActive = false;
      if (inputValue) {
        handler(String(inputValue));
      }
    });
    screen.render();
  };

  const confirmAction = (message: string, action: () => Promise<void> | void): void => {
    overlayActive = true;
    question.ask(`${message} Type y to confirm.`, (_error: unknown, value: unknown) => {
      overlayActive = false;
      if (String(value).toLowerCase() === "y" || String(value).toLowerCase() === "yes") {
        void runAction(action);
      } else {
        controller.setStatus("Cancelled.");
        void safeRender();
      }
    });
    screen.render();
  };

  let closeTui: () => void = () => undefined;
  bindKey(["q"], () => closeTui());
  bindKey(["C-c"], () => closeTui(), { allowDuringOverlay: true });
  bindKey(["tab"], () => void runAction(() => controller.cycleScreen(1)));
  bindKey(["S-tab"], () => void runAction(() => controller.cycleScreen(-1)));
  bindKey(["j", "down"], () => {
    const count = currentItemCount(snapshot);
    controller.moveSelection(1, count);
    void safeRender();
  });
  bindKey(["k", "up"], () => {
    const count = currentItemCount(snapshot);
    controller.moveSelection(-1, count);
    void safeRender();
  });
  bindKey(["r"], () => void safeRender());
  bindKey(["?"], () => {
    overlayActive = true;
    help.display(helpText(), 0, () => {
      overlayActive = false;
    });
    screen.render();
  });
  bindKey(["enter"], () => {
    void runAction(async () => {
      if (snapshot.screen === "browser") {
        await controller.openBrowserSelection();
        return;
      }
      if (snapshot.screen === "search") {
        await controller.openSearchSelection();
        return;
      }
      if (snapshot.screen === "remotes") {
        const remote = selectedRemoteName(snapshot.remotes);
        if (remote) {
          await controller.testRemote(remote);
        }
      }
    });
  });
  bindKey(["backspace", "escape"], () => void runAction(() => controller.goBrowserParent()));
  bindKey(["a"], () => {
    if (snapshot.screen !== "remotes") {
      return;
    }
    askPrompt("Remote name:/mount=url", "", (value) => {
      void runAction(() => controller.addRemote(value));
    });
  });
  bindKey(["e"], () => {
    if (snapshot.screen !== "remotes") {
      return;
    }
    const remote = snapshot.remotes[controller.selectedIndex("remotes")];
    if (!remote) {
      return;
    }
    askPrompt("Edit remote name:/mount=url", `${remote.name}:/${remote.name}=${remote.endpoint}`, (value) => {
      void runAction(() => controller.editRemote(remote.name, value));
    });
  });
  bindKey(["x"], () => {
    if (snapshot.screen === "remotes") {
      const remote = selectedRemoteName(snapshot.remotes);
      if (remote) {
        confirmAction(`Remove remote ${remote}?`, async () => {
          await controller.removeRemote(remote);
        });
      }
      return;
    }
  });
  bindKey(["m"], () => {
    void runAction(async () => {
      if (snapshot.screen === "mounts") {
        const remote = selectedRemoteName(snapshot.mounts);
        if (remote) {
          await controller.mount(remote);
        }
        return;
      }
      if (snapshot.screen === "browser") {
        await controller.exportSelectedPath();
      }
    });
  });
  bindKey(["u"], () => {
    if (snapshot.screen !== "mounts") {
      return;
    }
    const remote = selectedRemoteName(snapshot.mounts);
    if (remote) {
      void runAction(async () => {
        await controller.unmount(remote);
      });
    }
  });
  bindKey(["R"], () => {
    if (snapshot.screen !== "mounts") {
      return;
    }
    const remote = selectedRemoteName(snapshot.mounts);
    if (remote) {
      void runAction(async () => {
        await controller.remount(remote);
      });
    }
  });
  bindKey(["o"], () => {
    if (snapshot.screen !== "mounts") {
      return;
    }
    const remote = selectedRemoteName(snapshot.mounts);
    if (remote) {
      void runAction(() => controller.openMountedPath(remote));
    }
  });
  bindKey(["c"], () => {
    if (snapshot.screen !== "cache") {
      return;
    }
    const remote = selectedRemoteName(snapshot.cache);
    if (remote) {
      confirmAction(`Clear cache for ${remote}?`, () => controller.clearCache(remote));
    }
  });
  bindKey(["i"], () => {
    if (snapshot.screen !== "cache") {
      return;
    }
    const remote = selectedRemoteName(snapshot.cache);
    if (!remote) {
      return;
    }
    askPrompt("Invalidate path", "/", (value) => {
      void runAction(() => controller.invalidatePath(remote, value));
    });
  });
  bindKey(["/"], () => {
    askPrompt("Search pattern", "", (value) => {
      void runAction(() => controller.search(value));
    });
  });
  bindKey(["d"], () => {
    void runAction(async () => {
      await controller.saveDiagnosticSnapshot();
    });
  });
  bindKey(["y"], () => {
    if (snapshot.screen === "browser") {
      void runAction(async () => {
        await controller.copySelectedVirtualPath();
      });
      return;
    }
    if (snapshot.screen === "search") {
      void runAction(async () => {
        await controller.copySelectedSearchPath();
      });
    }
  });
  bindKey(["p"], () => {
    if (snapshot.screen === "browser") {
      void runAction(() => controller.cycleBrowserSource(1));
    }
  });

  list.on("select", (_item: unknown, index: number) => {
    controller.moveSelection(index - controller.selectedIndex(snapshot.screen), currentItemCount(snapshot));
    void safeRender();
  });

  await render();
  await new Promise<void>((resolvePromise) => {
    closeTui = () => {
      tuiClosed = true;
      options.input?.off("keypress", inputKeypressFallback as never);
      screen.destroy();
      resolvePromise();
    };
  });
}

function renderScreen(
  snapshot: TuiSnapshot,
  selectedIndex: number
): { items: string[]; detailTitle: string; detail: string } {
  switch (snapshot.screen) {
    case "health": {
      const remote = snapshot.health.remotes[selectedIndex];
      return {
        items: snapshot.health.remotes.map((row) =>
          `${row.name.padEnd(16)} source ${sourceState(row.source).padEnd(11)} session ${String(row.session.state).padEnd(10)} mount ${String(row.mount?.state ?? "none").padEnd(12)} cache ${row.cache.mode} ops ${row.operations.unresolvedCount} activity ${row.activity.backlogCount}`
        ),
        detailTitle: remote ? `Health ${remote.name}` : "Health",
        detail: remote
          ? renderHealthDetail(remote)
          : [
              renderQuickKeys("health"),
              "",
              "No ActiveFS remotes configured.",
              "For a local demo, run activefs remote add repo --demo --port 3999.",
              "Press tab to Remotes, then a to add a Source API remote."
            ].join("\n")
      };
    }
    case "remotes": {
      const remote = snapshot.remotes[selectedIndex];
      return {
        items: snapshot.remotes.map((row) =>
          `${row.name.padEnd(16)} ${sourceState(row.source).padEnd(11)} ${String(row.session.state).padEnd(10)} ${String(row.mount?.state ?? "no-mount").padEnd(12)} ${row.cache.mode} ops ${row.operations.unresolvedCount}`
        ),
        detailTitle: remote ? `Remote ${remote.name}` : "Remotes",
        detail: remote ? renderRemoteDetail(remote) : "No remotes configured. Press a to add a Source API remote."
      };
    }
    case "mounts": {
      const mount = snapshot.mounts[selectedIndex];
      return {
        items: snapshot.mounts.map((row) => `${row.name.padEnd(16)} ${row.status.state}${row.status.mounted ? " mounted" : ""}`),
        detailTitle: mount ? `Mount ${mount.name}` : "Mounts",
        detail: mount ? renderMountDetail(mount) : "No configured mounts."
      };
    }
    case "cache": {
      const row = snapshot.cache[selectedIndex];
      return {
        items: snapshot.cache.map((item) =>
          `${item.remote.padEnd(16)} ${item.mode.padEnd(18)} ${formatBytes(item.byteSize).padStart(10)}  ${item.fileCount} files`
        ),
        detailTitle: row ? `Cache ${row.remote}` : "Cache",
        detail: row
          ? [
              `mode: ${row.mode}`,
              `size: ${formatBytes(row.byteSize)}`,
              `files: ${row.fileCount}`,
              snapshot.debug && row.debugPath ? `debug path: ${row.debugPath}` : undefined,
              "",
              "c clear cache  i invalidate mounted path"
            ].filter(Boolean).join("\n")
          : "No cache directories. Add a remote first."
      };
    }
    case "browser": {
      const selected = snapshot.browser.entries[selectedIndex];
      return {
        items: snapshot.browser.entries.map((entry) =>
          `${entry.kind === "directory" ? "/" : " "} ${basename(entry.path).padEnd(24)} ${entry.kind}${entry.enumerable === false ? " dyn" : ""}${entry.capabilities?.search ? " idx" : ""}`
        ),
        detailTitle: `Browser ${snapshot.browser.path}`,
        detail: [
          `source: ${snapshot.browser.source?.label ?? "Unknown"} (${snapshot.browser.source?.mountPath ?? "/"})`,
          `current: ${snapshot.browser.path}`,
          `selected: ${selected?.path ?? snapshot.browser.path}`,
          snapshot.debug && snapshot.browser.source ? `source detail: ${snapshot.browser.source.detail}` : undefined,
          "",
          snapshot.browser.preview,
          "",
          "enter open/preview  backspace parent  p source  m export  y copy virtual path"
        ].filter(Boolean).join("\n")
      };
    }
    case "search": {
      const match = snapshot.search.matches[selectedIndex];
      return {
        items: snapshot.search.matches.map((item) =>
          `${item.path}${item.line === undefined ? "" : `:${item.line}`}${item.column === undefined ? "" : `:${item.column}`} ${item.excerpt ?? ""}`.trim()
        ),
        detailTitle: snapshot.search.pattern ? `Search ${snapshot.search.pattern}` : "Search",
        detail: [
          `root: ${snapshot.search.root}`,
          `pattern: ${snapshot.search.pattern || "(none)"}`,
          `strategy: ${snapshot.search.strategy}`,
          `results: ${snapshot.search.matches.length}`,
          `complete: ${snapshot.search.complete ? "yes" : "no"}`,
          "hidden/non-enumerable: excluded",
          snapshot.search.error ? `error: ${snapshot.search.error}` : undefined,
          match ? "" : undefined,
          match ? `selected: ${match.path}` : undefined,
          match?.line === undefined ? undefined : `line: ${match.line}`,
          match?.column === undefined ? undefined : `column: ${match.column}`,
          match?.excerpt ? `excerpt: ${match.excerpt}` : undefined,
          "",
          "/ search  enter open result  y copy result path"
        ].filter(Boolean).join("\n")
      };
    }
    case "logs": {
      const row = snapshot.logs[selectedIndex];
      return {
        items: snapshot.logs.map((item) => item.remote),
        detailTitle: row ? `Logs ${row.remote}` : "Logs",
        detail: row
          ? [
              "WebDAV",
              row.webdav || "(no WebDAV log entries)",
              "",
              "rclone",
              row.rclone || "(no rclone log entries)",
            ].join("\n")
          : "No remotes configured."
      };
    }
    case "settings": {
      return {
        items: [
          "workspace",
          "sources",
          "mounts",
          "debug"
        ],
        detailTitle: "Settings",
        detail: [
          `root: ${snapshot.settings.rootDir}`,
          `export: ${snapshot.settings.exportDir}`,
          `ActiveFS remotes: ${snapshot.settings.sourceCount}`,
          `mount adapters: ${snapshot.settings.mountRemoteCount}`,
          `debug: ${snapshot.settings.debug ? "on" : "off"}`,
          "",
          "Remotes and mount adapter state load from .activefs/config.json."
        ].join("\n")
      };
    }
  }
}

function renderHealthDetail(remote: ActiveFSRemoteStatusSummary): string {
  return [
    renderQuickKeys("health"),
    "",
    sectionTitle("Chain"),
    `  Source API: ${sourceState(remote.source)} ${remote.source.endpoint}`,
    `  session/freshness: ${remote.session.state}${remote.mount?.freshness ? ` / ${remote.mount.freshness.mode}${remote.mount.freshness.active ? " active" : ""}` : " / none"}`,
    `  WebDAV: ${remote.mount?.webdav?.state ?? "none"} ${remote.mount?.webdav?.url ?? ""}`,
    `  rclone: ${remote.mount?.state ?? "none"}${remote.mount?.mounted ? " mounted" : ""}`,
    `  OS mount: ${remote.mount?.vfsDir ?? remote.mountpoint ?? "none"}`,
    "",
    sectionTitle("Failures"),
    `  source: ${remote.source.diagnostics ?? "none"}`,
    `  session: ${remote.session.lastFailureReason ?? "none"}`,
    `  freshness: ${remote.mount?.freshness?.error ?? remote.mount?.freshness?.message ?? "none"}`,
    `  mount: ${remote.mount?.error ?? remote.mount?.staleReason ?? remote.mount?.message ?? "none"}`,
    `  activity: ${remote.activity.backlogCount} backlog file${remote.activity.backlogCount === 1 ? "" : "s"}`,
    "",
    sectionTitle("Summary"),
    `  cache: ${remote.cache.mode}${remote.cache.fileCount === undefined ? "" : `, ${remote.cache.fileCount} files, ${formatBytes(remote.cache.byteSize ?? 0)}`}`,
    `  unresolved operations: ${remote.operations.unresolvedCount}`,
    "d save diagnostics"
  ].join("\n");
}

function renderRemoteDetail(remote: ActiveFSRemoteStatusSummary): string {
  return [
    sectionTitle("Source API"),
    `  discovery URL: ${remote.source.endpoint}`,
    `  reachable: ${remote.source.reachable ? "yes" : "no"}`,
    `  protocol: ${remote.source.protocol ?? "unknown"}`,
    `  protocol version: ${remote.source.protocolVersion ?? "unknown"}`,
    `  capabilities: ${formatSourceCapabilities(remote.source)}`,
    remote.source.diagnostics ? `  diagnostics: ${remote.source.diagnostics}` : undefined,
    "",
    sectionTitle("Config"),
    `  namespace: ${remote.mountPath ?? "unknown"}`,
    `  mountpoint: ${remote.mountpoint ?? "none"}`,
    `  remote root: ${remote.remoteRoot ?? "/"}`,
    `  adapter: ${remote.adapterCapabilityProfile ?? "unknown"}`,
    `  cache: ${remote.cache.mode}`,
    `  insecure http: ${remote.insecureHttp ? `${remote.insecureHttp.reason}, dev only` : "no"}`,
    "",
    sectionTitle("Auth and Policy"),
    `  auth: ${remote.auth.type}`,
    `  policy: ${remote.policy.defaultAccess}, ${remote.policy.ruleCount} rule${remote.policy.ruleCount === 1 ? "" : "s"}${remote.policy.revision ? `, revision ${remote.policy.revision}` : ""}${remote.policy.digest ? `, digest ${remote.policy.digest}` : ""}`,
    "",
    sectionTitle("Session and Freshness"),
    `  session: ${formatSessionStatus(remote.session)}`,
    `  cache trust: ${remote.session.cacheMode ?? remote.cache.mode}`,
    `  freshness: ${remote.mount?.freshness ? `${remote.mount.freshness.mode}${remote.mount.freshness.active ? " active" : ""}` : "none"}`,
    `  last failure: ${remote.session.lastFailureReason ?? remote.mount?.freshness?.error ?? "none"}`,
    "",
    sectionTitle("Mount Adapter"),
    `  WebDAV: ${remote.mount?.webdav?.state ?? "none"} ${remote.mount?.webdav?.url ?? ""}`,
    `  rclone: ${remote.mount?.state ?? "none"}${remote.mount?.rc ? `, RC ${remote.mount.rc.addr}` : ""}`,
    `  VFS: ${remote.mount?.vfsDir ?? "none"}`,
    `  logs: ${remote.mount?.logFile ?? "none"}`,
    "",
    sectionTitle("Operations and Activity"),
    `  unresolved operations: ${remote.operations.unresolvedCount}${remote.operations.ids.length > 0 ? ` (${remote.operations.ids.join(", ")})` : ""}`,
    formatRecentOperations(remote),
    `  activity: ${remote.activity.policy}, ${remote.activity.backlogCount} backlog file${remote.activity.backlogCount === 1 ? "" : "s"}`,
    "",
    "enter test Source API  a add  e edit  x remove  d save diagnostics"
  ].filter(Boolean).join("\n");
}

function renderMountDetail(row: TuiMountRow): string {
  const status = row.status;
  const remote = row.remote;
  return [
    sectionTitle("Mount"),
    `  state: ${status.state}`,
    `  mounted: ${status.mounted ? "yes" : "no"}`,
    `  backend: rclone WebDAV`,
    `  VFS: ${status.vfsDir}`,
    `  log: ${status.logFile}`,
    `  stale reason: ${status.staleReason ?? "none"}`,
    status.lastRefresh ? `  last refresh: ${status.lastRefresh.ok ? "ok" : "failed"} ${status.lastRefresh.path}` : undefined,
    status.error ? `  error: ${status.error}` : status.message ? `  message: ${status.message}` : undefined,
    "",
    sectionTitle("Session and Freshness"),
    `  session: ${remote ? formatSessionStatus(remote.session) : "unknown"}`,
    `  cache trust: ${remote?.session.cacheMode ?? remote?.cache.mode ?? "unknown"}`,
    `  freshness: ${status.freshness ? `${status.freshness.mode}${status.freshness.active ? " active" : ""}` : "none"}`,
    status.freshness?.error ? `  freshness error: ${status.freshness.error}` : undefined,
    status.freshness?.message ? `  freshness message: ${status.freshness.message}` : undefined,
    "",
    sectionTitle("Adapter Internals"),
    status.webdav ? `  WebDAV: ${status.webdav.state} ${status.webdav.url ?? ""}` : "  WebDAV: none",
    status.webdav?.error ? `  WebDAV error: ${status.webdav.error}` : undefined,
    status.rc ? `  rclone RC: ${status.rc.addr}, password ${status.rc.hasPassword ? "configured" : "none"}` : "  rclone RC: none",
    "",
    "m mount  u unmount  R remount  o open mounted path  d save diagnostics"
  ].filter(Boolean).join("\n");
}

function formatSourceCapabilities(source: ActiveFSTreeApiStatus): string {
  const capabilities = source.capabilities;
  if (!capabilities) {
    return "unknown";
  }
  const enabled = [
    capabilities.statable ? "stat" : undefined,
    capabilities.listable ? "list" : undefined,
    capabilities.readable ? "read" : undefined,
    capabilities.searchable ? "search" : undefined,
    capabilities.watchable ? "watch" : undefined,
    capabilities.writable ? "write" : undefined,
    ...Object.entries(capabilities.mutable)
      .filter((entry) => entry[1])
      .map(([operation]) => operation)
  ].filter(Boolean);
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

function formatRecentOperations(remote: ActiveFSRemoteStatusSummary): string {
  if (remote.operations.recent.length === 0) {
    return "  recent operations: none";
  }
  return [
    "  recent operations:",
    ...remote.operations.recent.map((record) =>
      `    ${record.operationId} ${record.status}${record.operation ? ` ${record.operation}` : ""}${record.path ? ` ${record.path}` : ""}${record.lastFailureReason ? ` failure=${record.lastFailureReason}` : ""}`
    )
  ].join("\n");
}

function sourceState(source: ActiveFSTreeApiStatus): string {
  return source.reachable ? "reachable" : "unreachable";
}

function renderTabs(active: ActiveFSTuiScreen): string {
  return SCREENS.map((screen) =>
    screen === active
      ? `{${THEME.active}-fg}{bold}[${titleCase(screen)}]{/bold}{/${THEME.active}-fg}`
      : `{${THEME.accent}-fg} ${titleCase(screen)} {/${THEME.accent}-fg}`
  ).join(" ");
}

function helpText(): string {
  return [
    "ActiveFS TUI",
    "",
    "tab / shift-tab   switch screens",
    "j/k or arrows     move selection",
    "enter             test remote, open browser directory, or open search result",
    "/                 search from the current browser path",
    "backspace         parent directory in browser",
    "p                 switch browser source",
    "a/e/x             add, edit, remove remote",
    "m/u/R/o           mount, unmount, remount, open mounted path",
    "c/i               clear cache, invalidate mounted path",
    "m/y               export or copy selected browser/search path",
    "d                 save redacted diagnostics snapshot",
    "health            shows Source API, session, freshness, WebDAV, rclone, cache, ops",
    "settings          shows remote and mount config roots",
    "r                 refresh",
    "q                 quit",
    "",
    "Browser and preview use ActiveFS core APIs, not the mounted VFS path.",
    "Destructive actions require confirmation."
  ].join("\n");
}

function renderFooter(snapshot: TuiSnapshot): string {
  const status = colorizeStatus(snapshot.status);
  return [
    status,
    `{${THEME.accent}-fg}tab screens | j/k move | enter action | / search | d diagnostics | ? help | q quit{/${THEME.accent}-fg}`
  ].join("\n");
}

function renderQuickKeys(screen: ActiveFSTuiScreen): string {
  const screenAction = screen === "health"
    ? "enter tests a remote from Remotes"
    : screen === "remotes"
      ? "enter tests Source API"
      : screen === "mounts"
        ? "m mount, u unmount, R remount"
        : screen === "cache"
          ? "c clear cache, i invalidate path"
          : screen === "browser"
            ? "enter open/preview, m export, y copy"
            : screen === "search"
              ? "enter open result, y copy"
              : screen === "logs"
                ? "r refresh logs"
                : "settings are read-only";
  return [
    sectionTitle("Keys"),
    `  tab/shift-tab screens | j/k move | ${screenAction}`,
    "  / search | d diagnostics | ? full help | q quit"
  ].join("\n");
}

function sectionTitle(value: string): string {
  return `{${THEME.accent}-fg}{bold}${value}{/bold}{/${THEME.accent}-fg}`;
}

function colorizeStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("failed") || normalized.includes("error") || normalized.includes("unreachable")) {
    return `{${THEME.danger}-fg}${status}{/${THEME.danger}-fg}`;
  }
  if (normalized.includes("cancelled") || normalized.includes("unavailable")) {
    return `{${THEME.warning}-fg}${status}{/${THEME.warning}-fg}`;
  }
  if (normalized.includes("saved") || normalized.includes("exported") || normalized.includes("copied") || normalized.includes("reachable")) {
    return `{${THEME.active}-fg}${status}{/${THEME.active}-fg}`;
  }
  return `{${THEME.muted}-fg}${status}{/${THEME.muted}-fg}`;
}

function expandBlessedKeys(keys: string[]): string[] {
  const expanded = new Set<string>();
  for (const key of keys) {
    expanded.add(key);
    if (key.length === 1 && key.toLowerCase() !== key.toUpperCase() && key === key.toUpperCase()) {
      expanded.add(`S-${key.toLowerCase()}`);
    }
  }
  return [...expanded];
}

function normalizeBlessedKey(ch: string | undefined, key: BlessedKeypress): string | undefined {
  if (key.full) {
    return key.full;
  }
  let name = key.name ?? ch;
  if (!name || name === "undefined") {
    return undefined;
  }
  if (name === "return" && key.sequence === "\r") {
    name = "enter";
  }
  if (name === "enter" && key.sequence === "\n") {
    name = "linefeed";
  }
  return `${key.ctrl ? "C-" : ""}${key.meta ? "M-" : ""}${key.shift && name ? "S-" : ""}${name}`;
}

function currentItemCount(snapshot: TuiSnapshot): number {
  switch (snapshot.screen) {
    case "health":
      return snapshot.health.remotes.length;
    case "remotes":
      return snapshot.remotes.length;
    case "mounts":
      return snapshot.mounts.length;
    case "cache":
      return snapshot.cache.length;
    case "browser":
      return snapshot.browser.entries.length;
    case "search":
      return snapshot.search.matches.length;
    case "logs":
      return snapshot.logs.length;
    case "settings":
      return 4;
  }
}

function parentPath(path: ActiveFSPath): ActiveFSPath {
  if (path === "/") {
    return "/";
  }
  return normalizeActiveFSPath(path.split("/").slice(0, -1).join("/") || "/");
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentPreview(content: string | Uint8Array): string {
  const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  return text.length > 16_384 ? `${text.slice(0, 16_384)}\n...` : text;
}

function compareEntries(left: ActiveFSDirEntry, right: ActiveFSDirEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function pathToDirectoryName(path: ActiveFSPath): string {
  if (path === "/") {
    return "root";
  }
  return path.split("/").filter(Boolean).join("__");
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function openPathWithPlatform(path: string): void {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function writeOsc52Clipboard(text: string): void {
  const encoded = Buffer.from(text).toString("base64");
  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

export const activeFSTuiTestInternals = {
  renderScreen,
  renderTabs,
  helpText,
  renderFooter,
  expandBlessedKeys,
  normalizeBlessedKey: normalizeBlessedKey as (
    ch: string | undefined,
    key: {
      full?: string;
      name?: string;
      sequence?: string;
      ctrl?: boolean;
      meta?: boolean;
      shift?: boolean;
    }
  ) => string | undefined,
  currentItemCount,
  contentPreview,
  compareEntries,
  pathToDirectoryName,
  formatBytes
};

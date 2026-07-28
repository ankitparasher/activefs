import {
  createActiveFS,
  file,
  fsTree,
  isActiveFSPathWithin,
  normalizeActiveFSPath,
  type ActiveFSPath,
  type ActiveFSSearchMatch,
  type ActiveFSSearchQuery
} from "@activefs/core";

export const logsFixtureVersion = "logs-fixture-2026-06-26-v1";

const logFiles = new Map<ActiveFSPath, string>([
  [
    "/services/api/2026-06-26.log",
    [
      "2026-06-26T09:00:00Z INFO service=api request_id=af-1001 route=/health status=200",
      "2026-06-26T09:01:12Z WARN service=api request_id=af-1002 route=/checkout latency_ms=921",
      "2026-06-26T09:02:10Z INFO service=api request_id=af-1003 route=/checkout status=200"
    ].join("\n") + "\n"
  ],
  [
    "/services/api/2026-06-25.log",
    [
      "2026-06-25T17:45:01Z INFO service=api request_id=af-0998 route=/search status=200",
      "2026-06-25T17:45:03Z ERROR service=api request_id=af-0999 route=/search error=timeout"
    ].join("\n") + "\n"
  ],
  [
    "/services/worker/2026-06-26.log",
    [
      "2026-06-26T09:00:30Z INFO service=worker job=invoice id=job-17 status=started",
      "2026-06-26T09:00:31Z INFO service=worker job=invoice id=job-17 status=finished"
    ].join("\n") + "\n"
  ]
]);

interface LogsDiagnostics {
  readonly reads: number;
}

export function createLogsTree() {
  let reads = 0;
  const searchIndex = buildSearchIndex(logFiles);

  return {
    diagnostics: {
      get reads() {
        return reads;
      }
    },
    tree: fsTree(logFileDeclarations(logFiles, () => {
      reads += 1;
    }), {
      name: "logs-fixture",
      async search({ path, query }) {
        const searchQuery = query!;
        const normalizedPath = normalizeActiveFSPath(path);
        const maxResults = searchQuery.maxResults ?? Number.POSITIVE_INFINITY;
        const matches: ActiveFSSearchMatch[] = [];
        for (const record of searchIndex) {
          if (!isActiveFSPathWithin(normalizedPath, record.path) || !matchesQuery(record.text, searchQuery)) {
            continue;
          }
          if (matches.length >= maxResults) {
            return { matches, complete: false, strategy: "source", incompleteReasons: ["max-results"] };
          }
          matches.push({
            path: record.path,
            line: record.line,
            column: matchColumn(record.text, searchQuery),
            excerpt: record.text
          });
        }
        return { matches, complete: true, strategy: "source" };
      }
    })
  };
}

export async function runLogsTreeExample() {
  const { tree, diagnostics } = createLogsTree();
  const fs = createActiveFS().mount("/logs", tree);

  const apiLogs = await fs.list({}, "/logs/services/api");
  const search = await fs.search({}, "/logs/services", { pattern: "request_id=af-1002" });
  const readsAfterSearch = diagnostics.reads;
  const file = await fs.read({}, "/logs/services/api/2026-06-26.log");

  return {
    fixtureVersion: logsFixtureVersion,
    apiLogs: apiLogs.map((entry) => entry.path),
    searchStrategy: search.strategy,
    searchMatches: search.matches.map((match) => `${match.path}:${match.line ?? 0}`),
    readsAfterSearch,
    firstLine: textContent(file).split("\n")[0]
  };
}

interface SearchRecord {
  path: ActiveFSPath;
  line: number;
  text: string;
}

function buildSearchIndex(files: Map<ActiveFSPath, string>): SearchRecord[] {
  return [...files.entries()].flatMap(([path, content]) =>
    content.split(/\r?\n/).flatMap((line, index) =>
      line === "" ? [] : [{ path, line: index + 1, text: line }]
    )
  );
}

function logFileDeclarations(files: Map<ActiveFSPath, string>, onRead: () => void) {
  return Object.fromEntries(
    [...files.entries()].map(([path, content]) => [
      path,
      file({
        type: "text/plain",
        content: () => {
          onRead();
          return content;
        }
      })
    ])
  );
}

function matchesQuery(text: string, query: ActiveFSSearchQuery): boolean {
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const needle = query.caseSensitive ? query.pattern : query.pattern.toLowerCase();
  return haystack.includes(needle);
}

function matchColumn(text: string, query: ActiveFSSearchQuery): number {
  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const needle = query.caseSensitive ? query.pattern : query.pattern.toLowerCase();
  return haystack.indexOf(needle) + 1;
}

function textContent(read: { content: string | Uint8Array }): string {
  return typeof read.content === "string" ? read.content : new TextDecoder().decode(read.content);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runLogsTreeExample();
  console.log(`logs-tree fixture: ${result.fixtureVersion}`);
  console.log(`logs-tree api files: ${result.apiLogs.join(", ")}`);
  console.log(`logs-tree search strategy: ${result.searchStrategy}`);
  console.log(`log read calls during search: ${result.readsAfterSearch}`);
  console.log(`logs-tree first line: ${result.firstLine}`);
  console.log(`logs-tree matches: ${result.searchMatches.length}`);
}

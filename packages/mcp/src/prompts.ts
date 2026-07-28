import * as z from "zod/v4";
import type { GetPromptResult, Prompt } from "@modelcontextprotocol/sdk/types.js";

const promptArgsSchema = z.object({
  remote: z.string().optional(),
  path: z.string().default("/"),
  query: z.string().optional()
});

export interface ActiveFSMCPPromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: NonNullable<Prompt["arguments"]>;
  get(args: Record<string, unknown> | undefined): GetPromptResult;
}

export function listActiveFSMCPPrompts(): ActiveFSMCPPromptDefinition[] {
  return [
    makePrompt(
      "activefs_browse_remote",
      "Browse ActiveFS Remote",
      "Browse an ActiveFS remote from a starting path.",
      ({ remote, path }) =>
        `Browse ActiveFS remote ${remote ?? "the default remote"} at ${path}. Use activefs_list for directories and activefs_read for files. Keep provider-specific assumptions out of the analysis.`
    ),
    makePrompt(
      "activefs_summarize_tree",
      "Summarize ActiveFS Tree",
      "Summarize visible files below an ActiveFS path.",
      ({ remote, path }) =>
        `Summarize the visible ActiveFS tree under ${remote ? `${remote}:` : ""}${path}. Use activefs_list to inspect the namespace, then activefs_read only for files that are necessary to summarize.`
    ),
    makePrompt(
      "activefs_investigate_path",
      "Investigate ActiveFS Path",
      "Inspect metadata and contents for one ActiveFS path.",
      ({ remote, path }) =>
        `Investigate ${remote ? `${remote}:` : ""}${path}. Use activefs_stat first, then activefs_read for file content or activefs_list for directory entries. Report missing or unauthorized paths plainly.`
    ),
    makePrompt(
      "activefs_search_then_read",
      "Search Then Read",
      "Search ActiveFS content and read the most relevant matches.",
      ({ remote, path, query }) =>
        `Search ${remote ? `${remote}:` : ""}${path} for ${query ?? "the user's query"} using activefs_grep. Read only the most relevant activefs:// resources returned by the search.`
    )
  ];
}

export function getActiveFSMCPPrompt(name: string, args: Record<string, unknown> | undefined): GetPromptResult {
  const prompt = listActiveFSMCPPrompts().find((candidate) => candidate.name === name);
  if (!prompt) {
    throw new Error(`Unknown ActiveFS MCP prompt: ${name}`);
  }
  return prompt.get(args);
}

function makePrompt(
  name: string,
  title: string,
  description: string,
  build: (args: { remote?: string; path: string; query?: string }) => string
): ActiveFSMCPPromptDefinition {
  return {
    name,
    title,
    description,
    arguments: [
      {
        name: "remote",
        description: "Optional ActiveFS remote name. Defaults to the server's default remote.",
        required: false
      },
      {
        name: "path",
        description: "ActiveFS path under the remote.",
        required: false
      },
      {
        name: "query",
        description: "Search query for search-oriented prompts.",
        required: false
      }
    ],
    get(args) {
      const parsed = promptArgsSchema.parse(args ?? {});
      return {
        description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: build(parsed)
            }
          }
        ]
      };
    }
  };
}

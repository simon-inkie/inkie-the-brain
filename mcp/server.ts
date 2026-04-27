import "../core/env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "../core/config.js";
import { embedText } from "../core/embedder/text.js";
import { search, ensureCollections } from "../core/qdrant/client.js";
import { getMessageContext } from "../core/indexer/messages.js";

const server = new McpServer({
  name: "the-brain",
  version: "1.0.0",
});

const allCollections = Object.values(config.collections);

server.tool(
  "remembering",
  "Semantic recall across the brain vault, observations, reflections, conversation messages, and multimodal assets (images, PDFs, audio). Returns ranked results with source paths and content snippets. Optionally scope to specific agents with `agents: ['name']` — pass `'__own__'` to self-scope to the calling session's AGENT_NAME.",
  {
    query: z.string().describe("Natural language search query"),
    collections: z
      .array(
        z.enum([
          "brain-vault",
          "io-observations",
          "io-reflections",
          "io-messages",
          "io-assets",
        ])
      )
      .optional()
      .describe("Which collections to search. Default: all five."),
    limit: z
      .number()
      .optional()
      .describe("Max results to return. Default: 10."),
    agents: z
      .array(z.string())
      .optional()
      .describe(
        "Scope results to specific agent silos (by AGENT_NAME). Omit or pass empty array for cross-agent default. Pass `'__own__'` to resolve to this session's AGENT_NAME env var at query time.",
      ),
    from: z
      .string()
      .optional()
      .describe(
        "ISO date or datetime string — only return results on or after this date. Example: '2026-04-01'. Filters io-messages by timestampMs and other collections by date field.",
      ),
    to: z
      .string()
      .optional()
      .describe(
        "ISO date or datetime string — only return results on or before this date. Example: '2026-04-30'.",
      ),
  },
  async ({ query, collections, limit, agents, from, to }) => {
    const searchCollections = collections ?? allCollections;
    const searchLimit = limit ?? config.searchDefaults.limit;

    let resolvedAgents: string[] | undefined;
    if (agents && agents.length > 0) {
      const own = process.env.AGENT_NAME?.trim();
      resolvedAgents = agents.flatMap((a) =>
        a === "__own__" ? (own ? [own] : []) : [a],
      );
      if (resolvedAgents.length === 0) resolvedAgents = undefined;
    }

    const queryVector = await embedText(query, "RETRIEVAL_QUERY");
    const filter: { agentNames?: string[]; from?: string; to?: string } = {};
    if (resolvedAgents) filter.agentNames = resolvedAgents;
    if (from) filter.from = from;
    if (to) filter.to = to;

    const results = await search(
      searchCollections,
      queryVector,
      searchLimit,
      config.searchDefaults.scoreThreshold,
      Object.keys(filter).length > 0 ? filter : undefined,
    );

    const response = {
      results: results.map((r) => {
        const base: Record<string, unknown> = {
          score: Math.round(r.score * 1000) / 1000,
          source: r.source,
          collection: r.collection,
          title: r.title,
          content: r.content,
          tags: r.tags,
          date: r.date,
        };
        if (r.assetType) base.assetType = r.assetType;
        if (r.mimeType) base.mimeType = r.mimeType;
        if (r.description) base.description = r.description;
        if (r.transcript) base.transcript = r.transcript;
        return base;
      }),
      totalResults: results.length,
      searchedCollections: searchCollections,
      ...(resolvedAgents ? { scopedToAgents: resolvedAgents } : {}),
      ...(from || to ? { dateRange: { from, to } } : {}),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get_message_context",
  "Retrieve conversation messages around a specific timestamp. Returns messages before and after the target time for full conversational context.",
  {
    timestamp: z
      .string()
      .describe(
        "ISO timestamp or epoch ms to centre the context window on"
      ),
    windowMinutes: z
      .number()
      .optional()
      .describe(
        "Minutes of context each side of the timestamp. Default: 15"
      ),
    limit: z
      .number()
      .optional()
      .describe("Max messages to return. Default: 30"),
  },
  async ({ timestamp, windowMinutes, limit }) => {
    const messages = await getMessageContext(
      timestamp,
      windowMinutes ?? 15,
      limit ?? 30
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { messages, totalMessages: messages.length },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  await ensureCollections();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("the-brain MCP server running on stdio");
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});

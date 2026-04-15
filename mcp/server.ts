import "../core/env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "../core/config.js";
import { embedText } from "../core/embedder/text.js";
import { search, ensureCollections } from "../core/qdrant/client.js";
import { getMessageContext } from "../core/indexer/messages.js";

const server = new McpServer({
  name: "io-memory",
  version: "1.0.0",
});

const allCollections = Object.values(config.collections);

server.tool(
  "remembering",
  "Semantic recall across Io's brain vault, observations, reflections, conversation messages, and multimodal assets (images, PDFs, audio). Returns ranked results with source paths and content snippets.",
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
      .describe(
        "Which collections to search. Default: all five."
      ),
    limit: z
      .number()
      .optional()
      .describe("Max results to return. Default: 10."),
  },
  async ({ query, collections, limit }) => {
    const searchCollections = collections ?? allCollections;
    const searchLimit = limit ?? config.searchDefaults.limit;

    const queryVector = await embedText(query, "RETRIEVAL_QUERY");
    const results = await search(
      searchCollections,
      queryVector,
      searchLimit,
      config.searchDefaults.scoreThreshold
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
        // Include asset-specific fields when present
        if (r.assetType) base.assetType = r.assetType;
        if (r.mimeType) base.mimeType = r.mimeType;
        if (r.description) base.description = r.description;
        if (r.transcript) base.transcript = r.transcript;
        return base;
      }),
      totalResults: results.length,
      searchedCollections: searchCollections,
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
  console.error("io-memory MCP server running on stdio");
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});

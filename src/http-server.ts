#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "french-competition-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Meta block (golden standard requirement) ---------------------------------

function buildMeta() {
  return {
    disclaimer:
      "This information is provided for research purposes only and does not constitute legal or regulatory advice. Verify all references against primary sources before making compliance decisions.",
    source_url: "https://www.autoritedelaconcurrence.fr/",
    copyright:
      "© Autorité de la concurrence — data sourced from official publications",
    generated_by: SERVER_NAME,
  };
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "fr_comp_search_decisions",
    description:
      "Full-text search across AdlC enforcement decisions (abuse of dominance, cartel, sector inquiries). Returns matching decisions with case number, parties, outcome, fine amount, and Code de commerce articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query (e.g., 'entente', 'abus de position dominante', 'concentration')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: {
          type: "string",
          description:
            "Filter by sector ID (e.g., 'digital_economy', 'energy', 'food_retail'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "fr_comp_get_decision",
    description:
      "Get a specific AdlC decision by case number (e.g., '18-D-24', '20-D-11').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description:
            "AdlC case number (e.g., '18-D-24', '20-D-11', '19-MC-01')",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "fr_comp_search_mergers",
    description:
      "Search AdlC merger control decisions. Returns merger cases with acquiring party, target, sector, and outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query (e.g., 'TF1 / M6', 'Fnac / Darty', 'télécommunications')",
        },
        sector: {
          type: "string",
          description:
            "Filter by sector ID (e.g., 'energy', 'food_retail', 'media'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "fr_comp_get_merger",
    description:
      "Get a specific AdlC merger control decision by case number (e.g., '19-DCC-215', '22-DCC-14').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description:
            "AdlC merger case number (e.g., '19-DCC-215', '22-DCC-14')",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "fr_comp_list_sectors",
    description:
      "List all sectors with AdlC enforcement activity, including decision and merger counts.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fr_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fr_comp_list_sources",
    description:
      "List all data sources used by this MCP server with provenance, licensing, and update cadence information.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "fr_comp_check_data_freshness",
    description:
      "Check how current the data is — returns the last-ingested date per data category and whether an update is available.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "merger", "sector_inquiry"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["prohibited", "cleared", "cleared_with_conditions", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "fr_comp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "fr_comp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.case_number);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.case_number}`);
          }
          const decisionRecord = decision as unknown as Record<string, unknown>;
          return textContent({
            ...decisionRecord,
            _citation: buildCitation(
              String(decisionRecord["case_number"] ?? parsed.case_number),
              String(decisionRecord["title"] ?? decisionRecord["case_number"] ?? parsed.case_number),
              "fr_comp_get_decision",
              { case_number: parsed.case_number },
              decisionRecord["url"] as string | undefined,
            ),
            _meta: buildMeta(),
          });
        }

        case "fr_comp_search_mergers": {
          const parsed = SearchMergersArgs.parse(args);
          const results = searchMergers({
            query: parsed.query,
            sector: parsed.sector,
            outcome: parsed.outcome,
            limit: parsed.limit,
          });
          return textContent({ results, count: results.length, _meta: buildMeta() });
        }

        case "fr_comp_get_merger": {
          const parsed = GetMergerArgs.parse(args);
          const merger = getMerger(parsed.case_number);
          if (!merger) {
            return errorContent(`Merger case not found: ${parsed.case_number}`);
          }
          const mergerRecord = merger as unknown as Record<string, unknown>;
          return textContent({
            ...mergerRecord,
            _citation: buildCitation(
              String(mergerRecord["case_number"] ?? parsed.case_number),
              String(mergerRecord["title"] ?? mergerRecord["case_number"] ?? parsed.case_number),
              "fr_comp_get_merger",
              { case_number: parsed.case_number },
              mergerRecord["url"] as string | undefined,
            ),
            _meta: buildMeta(),
          });
        }

        case "fr_comp_list_sectors": {
          const sectors = listSectors();
          return textContent({ sectors, count: sectors.length, _meta: buildMeta() });
        }

        case "fr_comp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "AdlC (Autorite de la concurrence) MCP server. Provides access to French competition law enforcement decisions and merger control cases.",
            data_source: "AdlC (https://www.autoritedelaconcurrence.fr/)",
            coverage: {
              decisions:
                "Abuse of dominance, cartel enforcement, and sector inquiries",
              mergers: "Merger control decisions — Phase I and Phase II",
              sectors:
                "numerique, energie, grande distribution, automobile, services financiers, sante, medias, telecommunications",
            },
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: buildMeta(),
          });
        }

        case "fr_comp_list_sources": {
          return textContent({
            sources: [
              {
                id: "adlc_decisions",
                name: "AdlC Enforcement Decisions",
                authority: "Autorité de la concurrence",
                url: "https://www.autoritedelaconcurrence.fr/fr/liste-des-decisions-et-avis",
                license: "Open data — official French government publication",
                coverage: "Abuse of dominance, cartel enforcement, sector inquiries",
                update_cadence: "Periodic — decisions published as issued",
              },
              {
                id: "adlc_mergers",
                name: "AdlC Merger Control Decisions",
                authority: "Autorité de la concurrence",
                url: "https://www.autoritedelaconcurrence.fr/fr/liste-des-decisions-et-avis?type_decision=concentrations",
                license: "Open data — official French government publication",
                coverage: "Phase I and Phase II merger control decisions",
                update_cadence: "Periodic — decisions published as issued",
              },
            ],
            _meta: buildMeta(),
          });
        }

        case "fr_comp_check_data_freshness": {
          return textContent({
            status: "unknown",
            note:
              "Freshness metadata is written at ingest time. Run npm run ingest to refresh. Check ADLC_DB_PATH database for last-inserted record dates.",
            categories: {
              decisions: { last_checked: null, source: "adlc_decisions" },
              mergers: { last_checked: null, source: "adlc_mergers" },
            },
            _meta: buildMeta(),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

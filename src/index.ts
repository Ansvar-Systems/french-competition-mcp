#!/usr/bin/env node

/**
 * AdlC Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying Autorite de la concurrence decisions, merger control
 * cases, and sector enforcement activity under Code de commerce (L.420-1 et suivants).
 *
 * Tool prefix: fr_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "french-competition-mcp";

// --- Tool definitions ---------------------------------------------------------

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
          description: "Search query (e.g., 'entente', 'abus de position dominante', 'concentration')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "merger", "sector_inquiry"],
          description: "Filter by decision type. Optional.",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID (e.g., 'digital_economy', 'energy', 'food_retail'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["prohibited", "cleared", "cleared_with_conditions", "fine"],
          description: "Filter by outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fr_comp_get_decision",
    description:
      "Get a specific AdlC decision by case number (e.g., '18-D-24', '19-DCC-215').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "AdlC case number (e.g., '18-D-24', '19-DCC-215')",
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
          description: "Search query (e.g., 'TF1 / M6', 'Fnac / Darty')",
        },
        sector: {
          type: "string",
          description: "Filter by sector ID (e.g., 'energy', 'food_retail', 'real_estate'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_phase1", "cleared_with_conditions", "prohibited"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fr_comp_get_merger",
    description:
      "Get a specific AdlC merger control decision by case number (e.g., '18-D-24', '19-DCC-215').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "AdlC merger case number (e.g., '18-D-24', '19-DCC-215')",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "fr_comp_list_sectors",
    description:
      "List all sectors with AdlC enforcement activity, including decision counts and merger counts per sector.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fr_comp_about",
    description:
      "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fr_comp_list_sources",
    description:
      "List all data sources used by this MCP server with provenance, licensing, and update cadence information.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fr_comp_check_data_freshness",
    description:
      "Check how current the data is — returns the last-ingested date per data category and whether an update is available.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

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

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
            String(decisionRecord.case_number ?? parsed.case_number),
            String(decisionRecord.title ?? decisionRecord.case_number ?? parsed.case_number),
            "fr_comp_get_decision",
            { case_number: parsed.case_number },
            decisionRecord.url as string | undefined,
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
            String(mergerRecord.case_number ?? parsed.case_number),
            String(mergerRecord.title ?? mergerRecord.case_number ?? parsed.case_number),
            "fr_comp_get_merger",
            { case_number: parsed.case_number },
            mergerRecord.url as string | undefined,
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
            "AdlC (Autorite de la concurrence) MCP server. Provides access to French competition law enforcement decisions, merger control cases under the Code de commerce.",
          data_source: "AdlC (https://www.autoritedelaconcurrence.fr/)",
          coverage: {
            decisions: "Abuse of dominance, cartel enforcement, and sector inquiries",
            mergers: "Merger control decisions — Phase I and Phase II",
            sectors: "numerique, energie, grande distribution, automobile, services financiers, sante, medias, telecommunications",
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

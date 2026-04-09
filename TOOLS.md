# Tools Reference

All tools use the `fr_comp_` prefix. There are 8 tools total.

---

## Search & Retrieval Tools

### `fr_comp_search_decisions`

Full-text search across AdlC enforcement decisions.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `'entente'`, `'abus de position dominante'`) |
| `type` | string | No | Filter: `abuse_of_dominance`, `cartel`, `merger`, `sector_inquiry` |
| `sector` | string | No | Filter by sector ID (e.g., `'digital_economy'`, `'energy'`) |
| `outcome` | string | No | Filter: `prohibited`, `cleared`, `cleared_with_conditions`, `fine` |
| `limit` | number | No | Max results (default 20, max 100) |

**Returns:** `{ results: Decision[], count: number, _meta: MetaBlock }`

---

### `fr_comp_get_decision`

Retrieve a single AdlC decision by its case number.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `case_number` | string | Yes | AdlC case number (e.g., `'18-D-24'`, `'20-D-11'`) |

**Returns:** Full decision record with `_citation` and `_meta` blocks.

---

### `fr_comp_search_mergers`

Full-text search across AdlC merger control decisions.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `'TF1 / M6'`, `'Fnac / Darty'`) |
| `sector` | string | No | Filter by sector ID |
| `outcome` | string | No | Filter: `cleared`, `cleared_phase1`, `cleared_with_conditions`, `prohibited` |
| `limit` | number | No | Max results (default 20, max 100) |

**Returns:** `{ results: Merger[], count: number, _meta: MetaBlock }`

---

### `fr_comp_get_merger`

Retrieve a single AdlC merger decision by its case number.

**Arguments:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `case_number` | string | Yes | AdlC merger case number (e.g., `'19-DCC-215'`, `'22-DCC-14'`) |

**Returns:** Full merger record with `_citation` and `_meta` blocks.

---

### `fr_comp_list_sectors`

List all sectors with AdlC enforcement activity.

**Arguments:** None.

**Returns:** `{ sectors: Sector[], count: number, _meta: MetaBlock }`

---

## Meta Tools

### `fr_comp_about`

Server metadata: version, data source, coverage summary, and tool list.

**Arguments:** None.

**Returns:** Server info object with `_meta` block.

---

### `fr_comp_list_sources`

List all data sources with provenance, licensing, and update cadence.

**Arguments:** None.

**Returns:** `{ sources: Source[], _meta: MetaBlock }`

---

### `fr_comp_check_data_freshness`

Check data currency — last-ingested date per category.

**Arguments:** None.

**Returns:** `{ status: string, categories: { decisions, mergers }, _meta: MetaBlock }`

---

## Response Envelope

Every response includes a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "...",
    "source_url": "https://www.autoritedelaconcurrence.fr/",
    "copyright": "© Autorité de la concurrence — data sourced from official publications",
    "generated_by": "french-competition-mcp"
  }
}
```

Single-record tools (`get_decision`, `get_merger`) also include a `_citation` block for deterministic reference linking:

```json
{
  "_citation": {
    "canonical_ref": "18-D-24",
    "display_text": "Décision 18-D-24",
    "source_url": "...",
    "lookup": {
      "tool": "fr_comp_get_decision",
      "args": { "case_number": "18-D-24" }
    }
  }
}
```

/**
 * Ingestion crawler for the Autorité de la concurrence (AdlC) website.
 *
 * Scrapes decisions, merger-control decisions, and opinions from
 * autoritedelaconcurrence.fr and inserts them into the SQLite database.
 *
 * Usage:
 *   npx tsx scripts/ingest-autorite.ts                 # full crawl
 *   npx tsx scripts/ingest-autorite.ts --resume        # skip already-ingested case numbers
 *   npx tsx scripts/ingest-autorite.ts --dry-run       # parse but do not write to DB
 *   npx tsx scripts/ingest-autorite.ts --force          # delete DB and start fresh
 *   npx tsx scripts/ingest-autorite.ts --max-pages 5   # limit listing pages (for testing)
 *   npx tsx scripts/ingest-autorite.ts --mergers-only  # only crawl merger decisions
 *   npx tsx scripts/ingest-autorite.ts --decisions-only # only crawl decisions/opinions
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";
import * as cheerio from "cheerio";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = "https://www.autoritedelaconcurrence.fr";
const DECISIONS_LIST_PATH = "/fr/liste-des-decisions-et-avis";
const MERGERS_LIST_PATH = "/fr/liste-de-controle-des-concentrations";
const DB_PATH = process.env["ADLC_DB_PATH"] ?? "data/adlc.db";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FLAG_RESUME = args.includes("--resume");
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_FORCE = args.includes("--force");
const FLAG_MERGERS_ONLY = args.includes("--mergers-only");
const FLAG_DECISIONS_ONLY = args.includes("--decisions-only");

function getFlagValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const MAX_PAGES = getFlagValue("--max-pages")
  ? parseInt(getFlagValue("--max-pages")!, 10)
  : Infinity;

// ---------------------------------------------------------------------------
// French month map
// ---------------------------------------------------------------------------

const FRENCH_MONTHS: Record<string, string> = {
  janvier: "01",
  février: "02",
  fevrier: "02",
  mars: "03",
  avril: "04",
  mai: "05",
  juin: "06",
  juillet: "07",
  août: "08",
  aout: "08",
  septembre: "09",
  octobre: "10",
  novembre: "11",
  décembre: "12",
  decembre: "12",
};

/**
 * Parse a French date string like "19 décembre 2019" into "2019-12-19".
 * Returns null if unparseable.
 */
function parseFrenchDate(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  // Try "DD monthName YYYY"
  const match = cleaned.match(/^(\d{1,2})\s+(\S+)\s+(\d{4})$/);
  if (!match) return null;
  const [, day, monthName, year] = match;
  const month = FRENCH_MONTHS[monthName!];
  if (!month || !day || !year) return null;
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<string> {
  await rateLimit();
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "AnsvarAdlCIngester/1.0 (+https://ansvar.eu; competition-law-research)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
        },
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      return await res.text();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        log(`  WARN: attempt ${attempt}/${retries} failed for ${url}: ${msg} — retrying in ${backoff}ms`);
        await sleep(backoff);
      } else {
        throw new Error(`Failed after ${retries} attempts for ${url}: ${msg}`);
      }
    }
  }
  // Unreachable, but TypeScript wants it
  throw new Error("fetchWithRetry fell through");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const stats = {
  decisionsScraped: 0,
  decisionsInserted: 0,
  decisionsSkipped: 0,
  mergersScraped: 0,
  mergersInserted: 0,
  mergersSkipped: 0,
  errors: 0,
  sectorsUpserted: 0,
};

function log(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log(`Created directory ${dir}`);
  }

  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  log(`Database ready at ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Sector normalisation
// ---------------------------------------------------------------------------

/** Map common French sector names from the site to our sector IDs. */
const SECTOR_MAP: Record<string, { id: string; name: string; name_en: string }> = {
  numérique: { id: "numerique", name: "Economie numérique", name_en: "Digital Economy" },
  numerique: { id: "numerique", name: "Economie numérique", name_en: "Digital Economy" },
  "économie numérique": { id: "numerique", name: "Economie numérique", name_en: "Digital Economy" },
  énergie: { id: "energie", name: "Energie", name_en: "Energy" },
  energie: { id: "energie", name: "Energie", name_en: "Energy" },
  distribution: { id: "grande_distribution", name: "Grande distribution", name_en: "Retail" },
  "grande distribution": { id: "grande_distribution", name: "Grande distribution", name_en: "Retail" },
  "grande consommation": { id: "grande_consommation", name: "Grande consommation", name_en: "Consumer Goods" },
  banque: { id: "services_financiers", name: "Services financiers", name_en: "Financial Services" },
  "services financiers": { id: "services_financiers", name: "Services financiers", name_en: "Financial Services" },
  finance: { id: "services_financiers", name: "Services financiers", name_en: "Financial Services" },
  assurance: { id: "assurance", name: "Assurance", name_en: "Insurance" },
  santé: { id: "sante", name: "Santé", name_en: "Healthcare" },
  sante: { id: "sante", name: "Santé", name_en: "Healthcare" },
  "industrie pharmaceutique": { id: "pharma", name: "Industrie pharmaceutique", name_en: "Pharmaceuticals" },
  pharmacie: { id: "pharma", name: "Industrie pharmaceutique", name_en: "Pharmaceuticals" },
  médias: { id: "medias", name: "Médias", name_en: "Media" },
  medias: { id: "medias", name: "Médias", name_en: "Media" },
  audiovisuel: { id: "medias", name: "Médias", name_en: "Media" },
  transport: { id: "transport", name: "Transport", name_en: "Transport" },
  transports: { id: "transport", name: "Transport", name_en: "Transport" },
  télécommunications: { id: "telecoms", name: "Télécommunications", name_en: "Telecommunications" },
  telecoms: { id: "telecoms", name: "Télécommunications", name_en: "Telecommunications" },
  "bâtiment et travaux publics": { id: "btp", name: "Bâtiment et travaux publics", name_en: "Construction" },
  btp: { id: "btp", name: "Bâtiment et travaux publics", name_en: "Construction" },
  agriculture: { id: "agriculture", name: "Agriculture", name_en: "Agriculture" },
  agroalimentaire: { id: "agroalimentaire", name: "Agroalimentaire", name_en: "Food Industry" },
  immobilier: { id: "immobilier", name: "Immobilier", name_en: "Real Estate" },
  tourisme: { id: "tourisme", name: "Tourisme", name_en: "Tourism" },
  "professions réglementées": { id: "professions_reglementees", name: "Professions réglementées", name_en: "Regulated Professions" },
  "professions libérales": { id: "professions_liberales", name: "Professions libérales", name_en: "Liberal Professions" },
  industrie: { id: "industrie", name: "Industrie", name_en: "Industry" },
  chimie: { id: "chimie", name: "Chimie", name_en: "Chemicals" },
  automobile: { id: "automobile", name: "Automobile", name_en: "Automotive" },
  sport: { id: "sport", name: "Sport", name_en: "Sport" },
};

function normaliseSector(rawSector: string): { id: string; name: string; name_en: string } {
  const key = rawSector.trim().toLowerCase();
  const mapped = SECTOR_MAP[key];
  if (mapped) return mapped;
  // Generate a slug from the raw text
  const id = key
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return { id, name: rawSector.trim(), name_en: rawSector.trim() };
}

// ---------------------------------------------------------------------------
// Decision type detection
// ---------------------------------------------------------------------------

/**
 * Determine the decision type from the case number and page context.
 *
 * Patterns:
 *   NN-D-NN  → enforcement decision (cartel, abuse_of_dominance, etc.)
 *   NN-A-NN  → avis (opinion)
 *   NN-MC-NN → mesures conservatoires (interim measures)
 *   NN-DSA-NN → Digital Services Act decision
 *   NN-DMA-NN → Digital Markets Act decision
 */
function classifyCaseType(caseNumber: string): string {
  const upper = caseNumber.toUpperCase();
  if (/-MC-/.test(upper)) return "interim_measures";
  if (/-A-/.test(upper)) return "opinion";
  if (/-DSA-/.test(upper)) return "dsa_decision";
  if (/-DMA-/.test(upper)) return "dma_decision";
  if (/-D-/.test(upper)) return "decision";
  return "decision";
}

// ---------------------------------------------------------------------------
// Outcome normalisation
// ---------------------------------------------------------------------------

/** Normalise French disposition text into our outcome taxonomy. */
function normaliseOutcome(raw: string): string {
  const lower = raw.toLowerCase();
  if (/sanction pécuniaire|amende|sanction pecuniaire/.test(lower)) return "fine";
  if (/engagement/.test(lower)) return "commitments";
  if (/injonction/.test(lower)) return "injunction";
  if (/non-lieu|hors de cause|rejet|classement/.test(lower)) return "dismissed";
  if (/sursis/.test(lower)) return "interim_measures";
  if (/transaction/.test(lower)) return "settlement";
  if (/autorisation sous réserve|autorisation sous reserve|sous conditions/.test(lower))
    return "cleared_with_conditions";
  if (/autorisation/.test(lower)) return "cleared";
  if (/interdiction|interdit/.test(lower)) return "prohibited";
  if (/renvoi|phase\s*2|examen approfondi/.test(lower)) return "phase_2_referral";
  if (/pratique établie|pratique etablie/.test(lower)) return "infringement_found";
  if (/décision mixte|decision mixte/.test(lower)) return "mixed";
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Listing page parser: decisions & opinions
// ---------------------------------------------------------------------------

interface ListingItem {
  caseNumber: string;
  title: string;
  date: string | null;
  type: string; // "Décision" or "Avis"
  sectors: string[];
  detailPath: string;
}

/**
 * Parse one page of the decisions/opinions listing.
 *
 * The listing on autoritedelaconcurrence.fr renders items as a series of
 * blocks where each item has:
 *   - <h3><a href="/fr/decision/...">CASE_NUMBER titre...</a></h3>
 *     followed by type | date
 *     followed by Secteur(s) : linked sector names
 *
 * We walk the DOM looking for these <h3> + <a> patterns.
 */
function parseDecisionListing(html: string): ListingItem[] {
  const $ = cheerio.load(html);
  const items: ListingItem[] = [];

  // The site uses a Drupal view. Items are in .view-content, each result
  // typically wrapped in a .views-row or similar. We look for <h3> tags
  // containing links to /fr/decision/ or /fr/avis/.
  const links = $('a[href*="/fr/decision/"], a[href*="/fr/avis/"]');

  links.each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    // Skip links that are not listing items (e.g. sidebar related-decision links)
    const $parent = $a.closest("h3, h2, .views-field-title, .node__title");
    if ($parent.length === 0) {
      // Also accept direct links in list context — be permissive
      // but filter out footer/nav links
      if ($a.closest("nav, footer, .menu, .breadcrumb, .field--name-field-decision-associee").length > 0) {
        return;
      }
    }

    const rawText = $a.text().trim();
    if (!rawText) return;

    // Extract case number from the link text (e.g. "26-D-02 relative à ...")
    const caseMatch = rawText.match(/^(\d{2}-[A-Z]+-\d+)\b/);
    if (!caseMatch) return;
    const caseNumber = caseMatch[1]!;

    // Title is everything after the case number
    const title = rawText.replace(/^\d{2}-[A-Z]+-\d+\s*/, "").trim();

    // Determine type from the case number pattern
    const isAvis = href.includes("/fr/avis/");
    const type = isAvis ? "Avis" : "Décision";

    // Walk the surrounding context for date and sector info.
    // The site typically has the date near the link, in a text node or sibling.
    let dateStr: string | null = null;
    const sectors: string[] = [];

    // Look at the parent container for text containing a French date
    const $container =
      $parent.length > 0 ? $parent.parent() : $a.parent().parent();
    const containerText = $container.text();

    // Extract date from container text
    const dateMatch = containerText.match(
      /(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i,
    );
    if (dateMatch) {
      dateStr = parseFrenchDate(dateMatch[0]);
    }

    // Extract sectors from sibling links with field_sector parameter
    $container.find('a[href*="field_sector"]').each((_j, sectorEl) => {
      const sectorText = $(sectorEl).text().trim();
      if (sectorText) {
        sectors.push(sectorText);
      }
    });

    items.push({
      caseNumber,
      title: title || rawText,
      date: dateStr,
      type,
      sectors,
      detailPath: href,
    });
  });

  // Deduplicate by case number (same case may appear in related links)
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.caseNumber)) return false;
    seen.add(item.caseNumber);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Listing page parser: mergers
// ---------------------------------------------------------------------------

interface MergerListingItem {
  caseNumber: string;
  title: string;
  date: string | null;
  sectors: string[];
  detailPath: string;
}

function parseMergerListing(html: string): MergerListingItem[] {
  const $ = cheerio.load(html);
  const items: MergerListingItem[] = [];

  const links = $('a[href*="/fr/decision-de-controle-des-concentrations/"]');

  links.each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    if ($a.closest("nav, footer, .menu, .breadcrumb").length > 0) return;

    const rawText = $a.text().trim();
    if (!rawText) return;

    const caseMatch = rawText.match(/^(\d{2}-DCC-\d+)\b/);
    if (!caseMatch) return;
    const caseNumber = caseMatch[1]!;
    const title = rawText.replace(/^\d{2}-DCC-\d+\s*/, "").trim();

    let dateStr: string | null = null;
    const sectors: string[] = [];

    const $parent = $a.closest("h3, h2, .views-field-title, .node__title");
    const $container =
      $parent.length > 0 ? $parent.parent() : $a.parent().parent();
    const containerText = $container.text();

    const dateMatch = containerText.match(
      /(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i,
    );
    if (dateMatch) {
      dateStr = parseFrenchDate(dateMatch[0]);
    }

    $container.find('a[href*="field_sector"]').each((_j, sectorEl) => {
      const sectorText = $(sectorEl).text().trim();
      if (sectorText) sectors.push(sectorText);
    });

    items.push({
      caseNumber,
      title: title || rawText,
      date: dateStr,
      sectors,
      detailPath: href,
    });
  });

  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.caseNumber)) return false;
    seen.add(item.caseNumber);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Detail page parser: decisions
// ---------------------------------------------------------------------------

interface DecisionDetail {
  caseNumber: string;
  title: string;
  date: string | null;
  type: string;
  sector: string | null;
  parties: string | null; // JSON array
  summary: string | null;
  fullText: string;
  outcome: string | null;
  fineAmount: number | null;
  codeArticles: string | null; // JSON array
  status: string;
}

function parseDecisionDetail(html: string, fallback: ListingItem): DecisionDetail {
  const $ = cheerio.load(html);

  // --- Case number & date from <h1> ---
  const h1Text = $("h1").first().text().trim();
  let caseNumber = fallback.caseNumber;
  let date = fallback.date;

  // h1 pattern: "Décision 19-D-26 du 19 décembre 2019"
  const h1CaseMatch = h1Text.match(/(\d{2}-[A-Z]+-\d+)/);
  if (h1CaseMatch) caseNumber = h1CaseMatch[1]!;

  const h1DateMatch = h1Text.match(
    /(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i,
  );
  if (h1DateMatch) {
    date = parseFrenchDate(h1DateMatch[0]);
  }

  // --- Title ---
  // Use the <h1> text, cleaned up. Fall back to listing title.
  let title = h1Text || fallback.title;
  // Strip the "Décision NN-X-NN du DD month YYYY" prefix if present
  title = title
    .replace(/^(Décision|Avis|Decision)\s+\d{2}-[A-Z]+-\d+\s+du\s+\d{1,2}\s+\S+\s+\d{4}\s*/i, "")
    .trim();
  if (!title) title = fallback.title;

  // --- Metadata fields ---
  // The site renders metadata as definition-list-like structures or field divs.
  const pageText = $.text();

  // Parties / Entreprise(s) concernée(s)
  let parties: string[] = [];
  const companiesSection = extractFieldValue($, pageText, [
    "Entreprise(s) concernée(s)",
    "Entreprises concernées",
    "Entreprise concernée",
    "Parties",
  ]);
  if (companiesSection) {
    parties = companiesSection
      .split(/[,;]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  // Fine amount
  let fineAmount: number | null = null;
  const fineText = extractFieldValue($, pageText, [
    "Sanction(s)",
    "Sanctions",
    "Sanction pécuniaire",
    "Amende",
  ]);
  if (fineText) {
    const fineMatch = fineText.match(/([\d\s,.]+)\s*(millions?|milliards?)?/i);
    if (fineMatch) {
      let raw = fineMatch[1]!.replace(/\s/g, "").replace(",", ".");
      let amount = parseFloat(raw);
      if (!isNaN(amount)) {
        const unit = (fineMatch[2] || "").toLowerCase();
        if (unit.startsWith("million")) amount *= 1_000_000;
        if (unit.startsWith("milliard")) amount *= 1_000_000_000;
        fineAmount = amount;
      }
    }
    // Also try "NNN euros" pattern with large number
    if (fineAmount === null) {
      const euroMatch = fineText.match(/([\d\s.,]+)\s*euros?/i);
      if (euroMatch) {
        const cleaned = euroMatch[1]!.replace(/\s/g, "").replace(",", ".");
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed)) fineAmount = parsed;
      }
    }
  }

  // Legal basis / Code articles
  let codeArticles: string[] = [];
  const legalBasis = extractFieldValue($, pageText, [
    "Fondement juridique",
    "Fondement(s) juridique(s)",
    "Base juridique",
    "Articles",
  ]);
  if (legalBasis) {
    codeArticles = legalBasis
      .split(/[,;]/)
      .map((a) => a.trim())
      .filter(Boolean);
  }

  // Outcome / Dispositif
  let outcome: string | null = null;
  const dispositif = extractFieldValue($, pageText, [
    "Dispositif(s)",
    "Dispositif",
    "Décision",
  ]);
  if (dispositif) {
    outcome = normaliseOutcome(dispositif);
  }

  // Status — check for appeal mentions
  let status = "final";
  const recours = extractFieldValue($, pageText, [
    "Recours",
    "Appel",
    "Pourvoi",
  ]);
  if (recours && recours.trim().length > 5) {
    status = "appealed";
  }

  // Sector — from listing data or page metadata
  let sector: string | null = null;
  if (fallback.sectors.length > 0) {
    const norm = normaliseSector(fallback.sectors[0]!);
    sector = norm.id;
  } else {
    // Try to find sector on the detail page
    const sectorText = extractFieldValue($, pageText, [
      "Secteur(s) d'activité",
      "Secteur",
      "Secteur(s)",
    ]);
    if (sectorText) {
      const norm = normaliseSector(sectorText.split(",")[0]!.trim());
      sector = norm.id;
    }
  }

  // Summary — look for a "Résumé" section
  let summary: string | null = null;
  $("h2, h3").each((_i, heading) => {
    const headingText = $(heading).text().trim().toLowerCase();
    if (headingText.includes("résumé") || headingText.includes("resume")) {
      // Collect all following paragraphs until the next heading
      const parts: string[] = [];
      let $next = $(heading).next();
      while ($next.length > 0 && !$next.is("h1, h2, h3")) {
        const text = $next.text().trim();
        if (text) parts.push(text);
        $next = $next.next();
      }
      if (parts.length > 0) {
        summary = parts.join("\n\n");
      }
    }
  });

  // Full text — the main body content. Collect all substantive text from the
  // page body, excluding navigation, menus, footer.
  let fullText = "";
  if (summary) {
    fullText = summary;
  }

  // Also look for the main content area
  const contentSelectors = [
    ".node__content",
    ".field--name-body",
    "article .content",
    ".field--name-field-contenu",
    "#block-adlc-content",
    "main article",
    "main",
  ];

  for (const sel of contentSelectors) {
    const $content = $(sel);
    if ($content.length > 0) {
      // Remove navigation, menus, etc.
      $content.find("nav, .menu, .breadcrumb, script, style, .visually-hidden").remove();
      const bodyText = $content.text().trim();
      if (bodyText.length > fullText.length) {
        fullText = bodyText;
      }
      break;
    }
  }

  // If still empty, use page text minus boilerplate
  if (!fullText || fullText.length < 100) {
    $("nav, footer, header, script, style, .menu, .breadcrumb, .visually-hidden").remove();
    fullText = $("body").text().trim();
  }

  // Clean up whitespace
  fullText = fullText.replace(/\s{3,}/g, "\n\n").trim();

  // Determine type from case number
  const type = classifyCaseType(caseNumber);

  return {
    caseNumber,
    title,
    date,
    type,
    sector,
    parties: parties.length > 0 ? JSON.stringify(parties) : null,
    summary,
    fullText,
    outcome,
    fineAmount,
    codeArticles: codeArticles.length > 0 ? JSON.stringify(codeArticles) : null,
    status,
  };
}

// ---------------------------------------------------------------------------
// Detail page parser: mergers
// ---------------------------------------------------------------------------

interface MergerDetail {
  caseNumber: string;
  title: string;
  date: string | null;
  sector: string | null;
  acquiringParty: string | null;
  target: string | null;
  summary: string | null;
  fullText: string;
  outcome: string | null;
  turnover: number | null;
}

function parseMergerDetail(html: string, fallback: MergerListingItem): MergerDetail {
  const $ = cheerio.load(html);

  const h1Text = $("h1").first().text().trim();
  let caseNumber = fallback.caseNumber;
  let date = fallback.date;

  const h1CaseMatch = h1Text.match(/(\d{2}-DCC-\d+)/);
  if (h1CaseMatch) caseNumber = h1CaseMatch[1]!;

  const h1DateMatch = h1Text.match(
    /(\d{1,2})\s+(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+(\d{4})/i,
  );
  if (h1DateMatch) {
    date = parseFrenchDate(h1DateMatch[0]);
  }

  let title = h1Text || fallback.title;
  title = title
    .replace(
      /^(Décision\s+de\s+contrôle\s+des\s+concentrations\s+)?\d{2}-DCC-\d+\s+(du\s+\d{1,2}\s+\S+\s+\d{4}\s*)?/i,
      "",
    )
    .trim();
  if (!title) title = fallback.title;

  const pageText = $.text();

  // Acquiring party and target
  let acquiringParty: string | null = null;
  let target: string | null = null;

  // Try the "Parties notifiantes" or "Acquéreur" fields
  const notifiant = extractFieldValue($, pageText, [
    "Partie(s) notifiante(s)",
    "Parties notifiantes",
    "Partie notifiante",
    "Acquéreur",
    "Acquereur",
  ]);
  if (notifiant) acquiringParty = notifiant.trim();

  const cible = extractFieldValue($, pageText, [
    "Cible",
    "Société cible",
    "Entreprise cible",
    "Société(s) cible(s)",
  ]);
  if (cible) target = cible.trim();

  // If we could not find structured parties, try parsing from title
  if (!acquiringParty && !target) {
    // Titles often follow "relative à la prise de contrôle de X par Y"
    const partyMatch = title.match(
      /(?:prise\s+de\s+contrôle|acquisition|rachat)\s+(?:exclusif\s+)?(?:de\s+)?(?:la\s+société\s+)?(.+?)\s+par\s+(?:la\s+société\s+)?(.+?)(?:\.|$)/i,
    );
    if (partyMatch) {
      target = partyMatch[1]?.trim() ?? null;
      acquiringParty = partyMatch[2]?.trim() ?? null;
    }
  }

  // Outcome
  let outcome: string | null = null;
  const sens = extractFieldValue($, pageText, [
    "Sens de la décision",
    "Sens",
    "Décision",
    "Type de décision",
  ]);
  if (sens) {
    const lower = sens.toLowerCase();
    if (/interdiction|interdit|block/.test(lower)) outcome = "prohibited";
    else if (/sous réserve|sous reserve|engagements|conditions/.test(lower))
      outcome = "cleared_with_conditions";
    else if (/autorisation|autorisé|autorise|clearance/.test(lower))
      outcome = "cleared";
    else if (/renvoi|phase\s*2/.test(lower)) outcome = "phase_2_referral";
    else if (/dessaisissement/.test(lower)) outcome = "divestiture";
    else outcome = sens.trim();
  }

  // Sector
  let sector: string | null = null;
  if (fallback.sectors.length > 0) {
    sector = normaliseSector(fallback.sectors[0]!).id;
  } else {
    const sectorText = extractFieldValue($, pageText, [
      "Secteur(s) d'activité",
      "Secteur",
      "Secteur(s)",
    ]);
    if (sectorText) {
      sector = normaliseSector(sectorText.split(",")[0]!.trim()).id;
    }
  }

  // Summary
  let summary: string | null = null;
  $("h2, h3").each((_i, heading) => {
    const headingText = $(heading).text().trim().toLowerCase();
    if (headingText.includes("résumé") || headingText.includes("resume")) {
      const parts: string[] = [];
      let $next = $(heading).next();
      while ($next.length > 0 && !$next.is("h1, h2, h3")) {
        const text = $next.text().trim();
        if (text) parts.push(text);
        $next = $next.next();
      }
      if (parts.length > 0) summary = parts.join("\n\n");
    }
  });

  // Full text
  let fullText = "";
  if (summary) fullText = summary;

  const contentSelectors = [
    ".node__content",
    ".field--name-body",
    "article .content",
    ".field--name-field-contenu",
    "#block-adlc-content",
    "main article",
    "main",
  ];

  for (const sel of contentSelectors) {
    const $content = $(sel);
    if ($content.length > 0) {
      $content.find("nav, .menu, .breadcrumb, script, style, .visually-hidden").remove();
      const bodyText = $content.text().trim();
      if (bodyText.length > fullText.length) {
        fullText = bodyText;
      }
      break;
    }
  }

  if (!fullText || fullText.length < 100) {
    $("nav, footer, header, script, style, .menu, .breadcrumb, .visually-hidden").remove();
    fullText = $("body").text().trim();
  }

  fullText = fullText.replace(/\s{3,}/g, "\n\n").trim();

  // Turnover — rare on the page, but some merger decisions mention it
  let turnover: number | null = null;
  const caMatch = pageText.match(
    /chiffre\s+d['']affaires?\s*(?:mondial|total|cumulé|combine)?\s*(?:de\s+)?([\d\s,.]+)\s*(millions?|milliards?)?\s*d['']euros/i,
  );
  if (caMatch) {
    let raw = caMatch[1]!.replace(/\s/g, "").replace(",", ".");
    let amount = parseFloat(raw);
    if (!isNaN(amount)) {
      const unit = (caMatch[2] || "").toLowerCase();
      if (unit.startsWith("million")) amount *= 1_000_000;
      if (unit.startsWith("milliard")) amount *= 1_000_000_000;
      turnover = amount;
    }
  }

  return {
    caseNumber,
    title,
    date,
    sector,
    acquiringParty,
    target,
    summary,
    fullText,
    outcome,
    turnover,
  };
}

// ---------------------------------------------------------------------------
// Field extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract the value of a metadata field from the page.
 *
 * Looks for label text (e.g. "Entreprise(s) concernée(s)") in the DOM and
 * returns the adjacent content. Tries multiple strategies:
 *   1. Drupal field wrappers (.field--label + .field--item)
 *   2. Definition lists (dt + dd)
 *   3. Regex on raw page text
 */
function extractFieldValue(
  $: cheerio.CheerioAPI,
  pageText: string,
  labels: string[],
): string | null {
  for (const label of labels) {
    // Strategy 1: Drupal field labels — look for elements containing the label text
    const $labels = $("*").filter(function () {
      const t = $(this).text().trim();
      return (
        t === label ||
        t === label + " :" ||
        t.toLowerCase() === label.toLowerCase() ||
        t.toLowerCase() === label.toLowerCase() + " :"
      );
    });

    for (let i = 0; i < $labels.length; i++) {
      const $label = $labels.eq(i);
      // Check for a sibling or parent's sibling with the value
      const $next = $label.next();
      if ($next.length > 0) {
        const val = $next.text().trim();
        if (val && val.length < 2000) return val;
      }
      // Check parent for a .field--item sibling
      const $parentItems = $label.parent().find(".field--item, .field__item");
      if ($parentItems.length > 0) {
        const vals = $parentItems
          .map((_j, el) => $(el).text().trim())
          .get()
          .filter(Boolean);
        if (vals.length > 0) return vals.join(", ");
      }
    }

    // Strategy 2: Regex on raw text — "Label : value" or "Label\nvalue"
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped + "\\s*:?\\s*([^\\n]{3,200})", "i");
    const match = pageText.match(re);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pagination crawler
// ---------------------------------------------------------------------------

async function crawlListingPages(
  listPath: string,
  parser: (html: string) => Array<{ caseNumber: string; detailPath: string }>,
): Promise<Array<{ caseNumber: string; detailPath: string }>> {
  const allItems: Array<{ caseNumber: string; detailPath: string }> = [];
  let page = 0;

  while (page < MAX_PAGES) {
    const url = `${BASE_URL}${listPath}?page=${page}`;
    log(`Fetching listing page ${page}: ${url}`);

    let html: string;
    try {
      html = await fetchWithRetry(url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR fetching listing page ${page}: ${msg}`);
      stats.errors++;
      break;
    }

    const items = parser(html);
    if (items.length === 0) {
      log(`  No items found on page ${page} — reached end of listing`);
      break;
    }

    log(`  Found ${items.length} items on page ${page}`);
    allItems.push(...items);
    page++;
  }

  log(`Total items collected from listing: ${allItems.length}`);
  return allItems;
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

async function ingestDecisions(db: Database.Database): Promise<void> {
  log("=== Ingesting decisions and opinions ===");

  const existingCases = new Set<string>();
  if (FLAG_RESUME) {
    const rows = db
      .prepare("SELECT case_number FROM decisions")
      .all() as Array<{ case_number: string }>;
    for (const r of rows) existingCases.add(r.case_number);
    log(`Resume mode: ${existingCases.size} existing decisions in DB`);
  }

  const items = await crawlListingPages(DECISIONS_LIST_PATH, parseDecisionListing);

  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, code_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertSector = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (?, ?, ?, '', 1, 0)
    ON CONFLICT(id) DO UPDATE SET
      decision_count = decision_count + 1
  `);

  for (const item of items) {
    if (FLAG_RESUME && existingCases.has(item.caseNumber)) {
      stats.decisionsSkipped++;
      continue;
    }

    log(`  Scraping decision ${item.caseNumber}: ${item.detailPath}`);
    stats.decisionsScraped++;

    let detail: DecisionDetail;
    try {
      const detailUrl = item.detailPath.startsWith("http")
        ? item.detailPath
        : `${BASE_URL}${item.detailPath}`;
      const html = await fetchWithRetry(detailUrl);
      detail = parseDecisionDetail(html, item as ListingItem);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    ERROR scraping detail for ${item.caseNumber}: ${msg}`);
      stats.errors++;
      continue;
    }

    if (FLAG_DRY_RUN) {
      log(`    [DRY RUN] Would insert: ${detail.caseNumber} | ${detail.title.slice(0, 60)}... | outcome=${detail.outcome} | fine=${detail.fineAmount}`);
      continue;
    }

    try {
      insertDecision.run(
        detail.caseNumber,
        detail.title,
        detail.date,
        detail.type,
        detail.sector,
        detail.parties,
        detail.summary,
        detail.fullText,
        detail.outcome,
        detail.fineAmount,
        detail.codeArticles,
        detail.status,
      );
      stats.decisionsInserted++;

      // Upsert sector
      if (detail.sector) {
        const listing = item as ListingItem;
        const sectorName = listing.sectors[0] || detail.sector;
        const norm = normaliseSector(sectorName);
        upsertSector.run(norm.id, norm.name, norm.name_en);
        stats.sectorsUpserted++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    ERROR inserting ${detail.caseNumber}: ${msg}`);
      stats.errors++;
    }
  }
}

async function ingestMergers(db: Database.Database): Promise<void> {
  log("=== Ingesting merger control decisions ===");

  const existingCases = new Set<string>();
  if (FLAG_RESUME) {
    const rows = db
      .prepare("SELECT case_number FROM mergers")
      .all() as Array<{ case_number: string }>;
    for (const r of rows) existingCases.add(r.case_number);
    log(`Resume mode: ${existingCases.size} existing mergers in DB`);
  }

  const items = await crawlListingPages(MERGERS_LIST_PATH, parseMergerListing);

  const insertMerger = db.prepare(`
    INSERT OR IGNORE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertSector = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (?, ?, ?, '', 0, 1)
    ON CONFLICT(id) DO UPDATE SET
      merger_count = merger_count + 1
  `);

  for (const item of items) {
    if (FLAG_RESUME && existingCases.has(item.caseNumber)) {
      stats.mergersSkipped++;
      continue;
    }

    log(`  Scraping merger ${item.caseNumber}: ${item.detailPath}`);
    stats.mergersScraped++;

    let detail: MergerDetail;
    try {
      const detailUrl = item.detailPath.startsWith("http")
        ? item.detailPath
        : `${BASE_URL}${item.detailPath}`;
      const html = await fetchWithRetry(detailUrl);
      detail = parseMergerDetail(html, item as MergerListingItem);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    ERROR scraping detail for ${item.caseNumber}: ${msg}`);
      stats.errors++;
      continue;
    }

    if (FLAG_DRY_RUN) {
      log(`    [DRY RUN] Would insert: ${detail.caseNumber} | ${detail.title.slice(0, 60)}... | outcome=${detail.outcome} | acquirer=${detail.acquiringParty}`);
      continue;
    }

    try {
      insertMerger.run(
        detail.caseNumber,
        detail.title,
        detail.date,
        detail.sector,
        detail.acquiringParty,
        detail.target,
        detail.summary,
        detail.fullText,
        detail.outcome,
        detail.turnover,
      );
      stats.mergersInserted++;

      if (detail.sector) {
        const sectorName =
          (item as MergerListingItem).sectors[0] || detail.sector;
        const norm = normaliseSector(sectorName);
        upsertSector.run(norm.id, norm.name, norm.name_en);
        stats.sectorsUpserted++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    ERROR inserting ${detail.caseNumber}: ${msg}`);
      stats.errors++;
    }
  }
}

// ---------------------------------------------------------------------------
// Sector count refresh
// ---------------------------------------------------------------------------

function refreshSectorCounts(db: Database.Database): void {
  if (FLAG_DRY_RUN) return;

  log("Refreshing sector counts...");

  db.exec(`
    UPDATE sectors SET
      decision_count = COALESCE((
        SELECT COUNT(*) FROM decisions WHERE decisions.sector = sectors.id
      ), 0),
      merger_count = COALESCE((
        SELECT COUNT(*) FROM mergers WHERE mergers.sector = sectors.id
      ), 0)
  `);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("Autorité de la concurrence ingestion crawler");
  log(`  DB_PATH:    ${DB_PATH}`);
  log(`  --resume:   ${FLAG_RESUME}`);
  log(`  --dry-run:  ${FLAG_DRY_RUN}`);
  log(`  --force:    ${FLAG_FORCE}`);
  log(`  --max-pages: ${MAX_PAGES === Infinity ? "unlimited" : MAX_PAGES}`);
  log(`  --mergers-only: ${FLAG_MERGERS_ONLY}`);
  log(`  --decisions-only: ${FLAG_DECISIONS_ONLY}`);
  log("");

  const db = FLAG_DRY_RUN ? null! : initDb();

  try {
    if (!FLAG_MERGERS_ONLY) {
      await ingestDecisions(FLAG_DRY_RUN ? null! : db);
    }

    if (!FLAG_DECISIONS_ONLY) {
      await ingestMergers(FLAG_DRY_RUN ? null! : db);
    }

    if (!FLAG_DRY_RUN) {
      refreshSectorCounts(db);
    }
  } finally {
    if (db) db.close();
  }

  // Print summary
  log("");
  log("=== Ingestion complete ===");
  log(`  Decisions scraped:  ${stats.decisionsScraped}`);
  log(`  Decisions inserted: ${stats.decisionsInserted}`);
  log(`  Decisions skipped:  ${stats.decisionsSkipped}`);
  log(`  Mergers scraped:    ${stats.mergersScraped}`);
  log(`  Mergers inserted:   ${stats.mergersInserted}`);
  log(`  Mergers skipped:    ${stats.mergersSkipped}`);
  log(`  Sectors upserted:   ${stats.sectorsUpserted}`);
  log(`  Errors:             ${stats.errors}`);

  if (stats.errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 2;
});

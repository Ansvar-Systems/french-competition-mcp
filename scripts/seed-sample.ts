/**
 * Seed the AdlC database with sample decisions, mergers, and sectors for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["ADLC_DB_PATH"] ?? "data/adlc.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Sectors -----------------------------------------------------------------

interface SectorRow {
  id: string;
  name: string;
  name_en: string;
  description: string;
  decision_count: number;
  merger_count: number;
}

const sectors: SectorRow[] = [
  { id: "numerique", name: "Economie numerique", name_en: "Digital Economy", description: "Plateformes en ligne, reseaux sociaux, moteurs de recherche et places de marche numeriques.", decision_count: 2, merger_count: 1 },
  { id: "energie", name: "Energie", name_en: "Energy", description: "Fourniture d'electricite et de gaz, energies renouvelables et reseaux energetiques.", decision_count: 1, merger_count: 1 },
  { id: "grande_distribution", name: "Grande distribution", name_en: "Retail", description: "Grande distribution alimentaire, discounters et relations dans la chaine d'approvisionnement.", decision_count: 2, merger_count: 1 },
  { id: "services_financiers", name: "Services financiers", name_en: "Financial Services", description: "Banques, assurances, paiements et infrastructures des marches financiers.", decision_count: 0, merger_count: 0 },
  { id: "sante", name: "Sante", name_en: "Healthcare", description: "Hopitaux, industrie pharmaceutique, dispositifs medicaux et assurances maladie.", decision_count: 0, merger_count: 1 },
  { id: "medias", name: "Medias", name_en: "Media", description: "Presse ecrite, audiovisuel, streaming et agences de presse.", decision_count: 1, merger_count: 1 },
];

const insertSector = db.prepare(
  "INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)",
);

for (const s of sectors) {
  insertSector.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count);
}

console.log(`Inserted ${sectors.length} sectors`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  case_number: string;
  title: string;
  date: string;
  type: string;
  sector: string;
  parties: string;
  summary: string;
  full_text: string;
  outcome: string;
  fine_amount: number | null;
  code_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    case_number: "18-D-24",
    title: "Pratiques mises en oeuvre dans le secteur des produits d'entretien menager",
    date: "2018-12-19",
    type: "cartel",
    sector: "grande_distribution",
    parties: JSON.stringify(["Unilever France", "Procter and Gamble France", "Henkel France", "SC Johnson"]),
    summary: "L'Autorite de la concurrence a sanctionne plusieurs fabricants de produits d'entretien pour s'etre entendus sur les prix de leurs produits lors de negociations avec la grande distribution. Amendes totales de 126 millions d'euros.",
    full_text: "L'Autorite de la concurrence a sanctionne Unilever France, Procter and Gamble France, Henkel France et SC Johnson pour avoir mis en oeuvre une entente anticoncurrentielle dans le secteur des produits d'entretien menager. Les pratiques sanctionnees consistaient en des echanges d'informations sur les prix pratiques lors des negociations commerciales annuelles avec la grande distribution (Carrefour, Leclerc, Casino, etc.). Ces echanges permettaient aux parties de coordonner leurs positions et de limiter la concurrence par les prix. L'Autorite a caracterise une infraction a l'article L.420-1 du Code de commerce et a l'article 101 du TFUE. Les amendes imposees s'elevent au total a environ 126 millions d'euros, avec des reductions accordees au titre de la clemence pour les entreprises ayant collabore a l'enquete. L'affaire illustre les risques associes aux echanges d'informations lors des negociations commerciales collectives.",
    outcome: "fine",
    fine_amount: 126000000,
    code_articles: JSON.stringify(["L.420-1 Code de commerce", "Article 101 TFUE"]),
    status: "appealed",
  },
  {
    case_number: "21-D-11",
    title: "Pratiques d'Apple dans le secteur de la distribution de produits electroniques grand public",
    date: "2021-03-16",
    type: "abuse_of_dominance",
    sector: "numerique",
    parties: JSON.stringify(["Apple Inc.", "Apple Distribution International"]),
    summary: "L'Autorite a sanctionne Apple d'une amende de 1,1 milliard d'euros pour avoir mis en oeuvre des pratiques anticoncurrentielles dans la distribution de ses produits electroniques en France. Apple a notamment restreint les ventes actives de ses revendeurs agrees.",
    full_text: "L'Autorite de la concurrence a prononce une sanction de 1,1 milliard d'euros a l'encontre d'Apple pour des pratiques mises en oeuvre dans son reseau de distribution en France. L'instruction a identifie deux categories de pratiques: (1) Des restrictions de concurrence au sein du reseau de distribution agree d'Apple — Apple avait mis en place un systeme qui interdisait pratiquement a ses revendeurs agrees (grossistes et distributeurs agrees) de vendre activement les produits Apple aux revendeurs non agrees. Cette pratique limitait la concurrence intramarque et compartimentait les marches. (2) Des pratiques d'eviction vis-a-vis d'un grossiste — Apple avait applique a certains grossistes des conditions commerciales discriminatoires et avait restreint leur capacite a s'approvisionner, ce qui avait pour effet d'evincer ces grossistes du marche. Ces pratiques ont constitue des violations graves de l'article L.420-1 et de l'article L.420-2 du Code de commerce, ainsi que des articles 101 et 102 du TFUE. Apple a fait appel de la decision devant la cour d'appel de Paris.",
    outcome: "fine",
    fine_amount: 1100000000,
    code_articles: JSON.stringify(["L.420-1 Code de commerce", "L.420-2 Code de commerce", "Article 101 TFUE", "Article 102 TFUE"]),
    status: "appealed",
  },
  {
    case_number: "20-D-04",
    title: "Pratiques de la societe Google dans le secteur de la publicite en ligne",
    date: "2021-01-12",
    type: "abuse_of_dominance",
    sector: "numerique",
    parties: JSON.stringify(["Google LLC", "Alphabet Inc."]),
    summary: "L'Autorite a inflige a Google une amende de 220 millions d'euros pour avoir favorise ses propres services de publicite sur les applications mobiles et les sites Internet tiers, au detriment des solutions concurrentes.",
    full_text: "L'Autorite de la concurrence a sanctionne Google d'une amende de 220 millions d'euros pour avoir abuse de sa position dominante dans le secteur de la publicite en ligne. L'instruction a porte sur les ecosystemes de vente de publicite pour les applications mobiles (in-app advertising) et pour les sites Internet tiers (web advertising). L'Autorite a constate que Google avait favorise ses propres services de publicite en ligne — notamment DFP (DoubleClick for Publishers) et AdX (DoubleClick Ad Exchange) — par rapport aux solutions concurrentes. Ce favoritisme s'est manifeste notamment par des pratiques de couplage et d'interoperabilite selective qui avantageaient les produits Google. Ces pratiques constituaient un abus de position dominante au sens de l'article L.420-2 du Code de commerce et de l'article 102 du TFUE. Google a accepte de prendre des engagements pour corriger ces pratiques, ce qui a conduit l'Autorite a clore la procedure sur les engagements apres avoir impose la sanction pour les violations passees.",
    outcome: "fine",
    fine_amount: 220000000,
    code_articles: JSON.stringify(["L.420-2 Code de commerce", "Article 102 TFUE"]),
    status: "final",
  },
  {
    case_number: "22-MC-01",
    title: "Injonctions a l'encontre de Google concernant les droits voisins",
    date: "2022-07-12",
    type: "abuse_of_dominance",
    sector: "medias",
    parties: JSON.stringify(["Google LLC", "Alphabet Inc."]),
    summary: "L'Autorite a condamne Google a une amende de 500 millions d'euros pour ne pas avoir respecte ses injonctions relatives aux droits voisins des editeurs de presse, apres avoir refuse de negocier de bonne foi la remuneration due aux editeurs.",
    full_text: "En 2020, l'Autorite de la concurrence avait enjoint Google a negocier de bonne foi avec les editeurs de presse la remuneration due au titre des droits voisins crees par la loi de 2019 transposant la directive europeenne sur le droit d'auteur. En 2021, l'Autorite avait constate que Google ne respectait pas ces injonctions et avait prononce une amende de 500 millions d'euros. Google a finalement accepte de negocier un accord avec les editeurs de presse. Cette affaire est la premiere application en Europe des droits voisins des editeurs de presse, un nouveau droit de propriete intellectuelle qui oblige les agregateurs de contenu comme Google a remunerer les editeurs lorsqu'ils utilisent leurs contenus. L'affaire a eu une portee symbolique importante dans le contexte des negociations sur la remuneration des medias par les grandes plateformes numeriques.",
    outcome: "fine",
    fine_amount: 500000000,
    code_articles: JSON.stringify(["L.420-2 Code de commerce", "Article 102 TFUE", "L.218-1 CPI"]),
    status: "final",
  },
  {
    case_number: "23-DCC-190",
    title: "Prise de controle de Showroomprive.com par la Societe Generale de Courtage d'Assurances",
    date: "2023-09-18",
    type: "merger",
    sector: "numerique",
    parties: JSON.stringify(["Societe Generale de Courtage d'Assurances", "Showroomprive.com"]),
    summary: "L'Autorite a autorise, sous conditions, la prise de controle de la marketplace de mode Showroomprive.com. L'Autorite a identifie des risques de coordination entre les activites de commerce electronique et d'assurance du groupe.",
    full_text: "L'Autorite de la concurrence a examine l'acquisition du controle de Showroomprive.com. L'Autorite a identifie des chevauchements entre les activites de commerce electronique de Showroomprive et les activites d'assurance de la Societe Generale de Courtage. Apres examen, l'Autorite a autorise l'operation sous reserve d'engagements comportementaux pour eviter les risques de verrouillage du marche.",
    outcome: "cleared_with_conditions",
    fine_amount: null,
    code_articles: JSON.stringify(["L.430-1 Code de commerce", "L.430-2 Code de commerce"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, code_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.case_number, d.title, d.date, d.type, d.sector,
      d.parties, d.summary, d.full_text, d.outcome,
      d.fine_amount, d.code_articles, d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Mergers -----------------------------------------------------------------

interface MergerRow {
  case_number: string;
  title: string;
  date: string;
  sector: string;
  acquiring_party: string;
  target: string;
  summary: string;
  full_text: string;
  outcome: string;
  turnover: number | null;
}

const mergers: MergerRow[] = [
  {
    case_number: "21-DCC-192",
    title: "TF1 / M6 — Projet de fusion",
    date: "2022-09-14",
    sector: "medias",
    acquiring_party: "TF1 SA (Bouygues)",
    target: "M6 Metropole Television (RTL Group)",
    summary: "L'Autorite de la concurrence a bloque la fusion entre TF1 et M6, les deux principales chaines de television privees en France, estimant que les remedes proposes ne permettaient pas de remedier aux atteintes graves a la concurrence, notamment dans la publicite televisee et l'acquisition de droits audiovisuels.",
    full_text: "TF1 et M6 sont les deux plus importantes chaines de television commerciales en France, avec respectivement environ 32% et 28% de la publicite televisee. L'Autorite de la concurrence a conduit une enquete approfondie sur la fusion projetee. L'Autorite a identifie des atteintes graves a la concurrence dans plusieurs marches : (1) La publicite televisee — la fusion aurait cree un acteur dominant controlant pres de 80% des recettes publicitaires de la television commerciale en France, avec des risques de hausse des prix pour les annonceurs et de reduction de la diversite des offres ; (2) L'acquisition de droits audiovisuels et cinematographiques — la fusion aurait permis a la nouvelle entite d'exercer un pouvoir de negociation excessif vis-a-vis des producteurs independants et des ayants droit ; (3) La production audiovisuelle — les risques de discrimination vis-a-vis des producteurs independants non lies au groupe fusionne. Les parties ont propose des remedes, mais l'Autorite a conclu qu'ils etaient insuffisants pour remedier aux problemes de concurrence identifies. L'Autorite a donc bloque l'operation en septembre 2022. Les parties ont ensuite renonce au projet de fusion.",
    outcome: "prohibited",
    turnover: 3000000000,
  },
  {
    case_number: "19-DCC-215",
    title: "Fnac Darty / Nature and Decouvertes",
    date: "2019-11-07",
    sector: "grande_distribution",
    acquiring_party: "Fnac Darty SA",
    target: "Nature et Decouvertes SA",
    summary: "L'Autorite a autorise, sous conditions, l'acquisition de Nature et Decouvertes par Fnac Darty. L'Autorite a identifie des risques concurrentiels dans certaines zones geographiques ou les deux enseignes etaient en concurrence directe pour la vente de produits culturels et de loisirs.",
    full_text: "Fnac Darty a notifie l'acquisition de Nature et Decouvertes, chaine de distribution de produits nature, aventure et bien-etre, a l'Autorite de la concurrence. L'Autorite a examine l'operation en tenant compte de la complementarite partielle des gammes de produits. Dans les zones geographiques ou Fnac et Nature et Decouvertes etaient en concurrence directe pour certaines categories de produits (jeux educatifs, produits culturels), l'Autorite a identifie des risques de reduction de la concurrence. L'Autorite a autorise l'operation sous reserve de la cession de certains magasins dans les zones de chevauchement.",
    outcome: "cleared_with_conditions",
    turnover: 5000000000,
  },
  {
    case_number: "22-DCC-110",
    title: "Prise de controle de Suez par Veolia",
    date: "2022-02-14",
    sector: "energie",
    acquiring_party: "Veolia Environnement SA",
    target: "Suez SA",
    summary: "L'Autorite a autorise la prise de controle de Suez par Veolia, creant le leader mondial des services a l'environnement. L'autorisation a ete accordee sous reserve d'engagements significatifs, incluant la cession d'actifs dans l'eau et les dechets pour permettre a un Nouveau Suez de rester un concurrent viable.",
    full_text: "La fusion Veolia/Suez a cree le leader mondial des services a l'environnement. L'Autorite a conduit une instruction approfondie sur cette operation majeure. Les deux groupes etaient en concurrence dans plusieurs secteurs : la gestion de l'eau (distribution, traitement), la gestion des dechets (collecte, tri, valorisation) et les services aux collectivites. L'Autorite a identifie des risques de concurrence sur plusieurs marches locaux, notamment dans la gestion de l'eau potable et des eaux usees pour les collectivites locales, et dans la collecte et le traitement des dechets. Pour remedier a ces problemes, Veolia a pris des engagements significatifs, incluant la cession d'actifs eau et dechets permettant la constitution d'un Nouveau Suez viable et independant. L'Autorite a accepte ces engagements et autorise l'operation en fevrier 2022.",
    outcome: "cleared_with_conditions",
    turnover: 28000000000,
  },
];

const insertMerger = db.prepare(`
  INSERT OR IGNORE INTO mergers
    (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMergersAll = db.transaction(() => {
  for (const m of mergers) {
    insertMerger.run(
      m.case_number, m.title, m.date, m.sector,
      m.acquiring_party, m.target, m.summary, m.full_text,
      m.outcome, m.turnover,
    );
  }
});

insertMergersAll();
console.log(`Inserted ${mergers.length} mergers`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mergerCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sectorCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sectors:   ${sectorCount}`);
console.log(`  Decisions: ${decisionCount}`);
console.log(`  Mergers:   ${mergerCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();

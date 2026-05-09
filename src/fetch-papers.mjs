import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const HEADERS = { "User-Agent": "GHBAddictionResearchBot/1.0 (research aggregator)" };

const SEARCH_QUERIES = [
  {
    name: "GHB dependence & withdrawal",
    term:
      '(GHB[tiab] OR "gamma-hydroxybutyrate"[tiab] OR "gamma hydroxybutyrate"[tiab] OR GBL[tiab] OR "gamma-butyrolactone"[tiab] OR "1,4-butanediol"[tiab]) AND (dependence[tiab] OR addiction[tiab] OR "use disorder"[tiab] OR withdrawal[tiab] OR "withdrawal syndrome"[tiab] OR detoxification[tiab] OR delirium[tiab])',
  },
  {
    name: "GHB intoxication & emergency",
    term:
      '(GHB[tiab] OR "gamma-hydroxybutyrate"[tiab] OR GBL[tiab] OR "1,4-butanediol"[tiab]) AND (intoxication[tiab] OR overdose[tiab] OR toxicity[tiab] OR coma[tiab] OR "respiratory depression"[tiab] OR "emergency department"[tiab] OR poisoning[tiab])',
  },
  {
    name: "GHB chemsex & sexual health",
    term:
      '(GHB[tiab] OR "gamma-hydroxybutyrate"[tiab] OR GBL[tiab] OR "gamma-butyrolactone"[tiab]) AND (chemsex[tiab] OR "sexualized drug use"[tiab] OR "sexualised drug use"[tiab] OR MSM[tiab] OR "men who have sex with men"[tiab] OR HIV[tiab])',
  },
  {
    name: "GHB neurobiology & pharmacology",
    term:
      '(GHB[tiab] OR "gamma-hydroxybutyrate"[tiab] OR "gamma-hydroxybutyric acid"[tiab]) AND (GABA[tiab] OR "GABA-B"[tiab] OR "GHB receptor"[tiab] OR dopamine[tiab] OR glutamate[tiab] OR neuroadaptation[tiab] OR pharmacokinetic*[tiab])',
  },
  {
    name: "GHB treatment & harm reduction",
    term:
      '(GHB[tiab] OR "gamma-hydroxybutyrate"[tiab] OR GBL[tiab] OR oxybate[tiab] OR "sodium oxybate"[tiab]) AND (treatment[tiab] OR management[tiab] OR benzodiazepine*[tiab] OR baclofen[tiab] OR "harm reduction"[tiab] OR taper*[tiab] OR "relapse prevention"[tiab])',
  },
  {
    name: "GHB forensic & DFSA",
    term:
      '(GHB[tiab] OR "gamma-hydroxybutyrate"[tiab] OR GBL[tiab] OR "gamma-butyrolactone"[tiab]) AND ("drug-facilitated sexual assault"[tiab] OR DFSA[tiab] OR "date rape"[tiab] OR forensic[tiab] OR "sexual assault"[tiab])',
  },
  {
    name: "GHB polysubstance & club drug",
    term:
      '(GHB[tiab] OR "gamma-hydroxybutyrate"[tiab] OR GBL[tiab]) AND (polysubstance[tiab] OR "co-use"[tiab] OR methamphetamine[tiab] OR MDMA[tiab] OR ketamine[tiab] OR nightlife[tiab] OR "club drug"[tiab] OR rave[tiab])',
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 50, output: "papers.json" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") opts.days = parseInt(args[++i], 10);
    else if (args[i] === "--max-papers") opts.maxPapers = parseInt(args[++i], 10);
    else if (args[i] === "--output") opts.output = args[++i];
  }
  return opts;
}

function getDateStr() {
  const env = process.env.TARGET_DATE;
  if (env) return env;
  const d = new Date();
  d.setHours(d.getHours() + 8);
  return d.toISOString().slice(0, 10);
}

function getAlreadySummarizedPmids() {
  const docsDir = resolve("docs");
  if (!existsSync(docsDir)) return new Set();
  const pmids = new Set();
  const files = readdirSync(docsDir).filter((f) => f.startsWith("ghb-") && f.endsWith(".html"));
  for (const f of files.slice(0, 7)) {
    try {
      const html = readFileSync(join(docsDir, f), "utf-8");
      const matches = html.matchAll(/data-pmid="(\d+)"/g);
      for (const m of matches) pmids.add(m[1]);
    } catch {}
  }
  return pmids;
}

function buildDateFilter(days) {
  const d = new Date();
  d.setHours(d.getHours() + 8);
  d.setDate(d.getDate() - days);
  const from = d.toISOString().slice(0, 10).replace(/-/g, "/");
  return `"${from}"[Date - Publication] : "3000"[Date - Publication]`;
}

async function searchPapers(term, dateFilter, retmax) {
  const query = `(${term}) AND ${dateFilter}`;
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(",")}&retmode=xml`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    const xml = await resp.text();
    return parseXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function extractText(el, tag) {
  const m = el.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "s"));
  return m ? m[1].trim() : "";
}

function parseXml(xml) {
  const papers = [];
  const articles = xml.split(/<PubmedArticle>/).slice(1);
  for (const art of articles) {
    const titleM = art.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/);
    let title = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : "";
    if (!title) continue;

    const abstractParts = [];
    const absRe = /<AbstractText[^>]*Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let m;
    while ((m = absRe.exec(art)) !== null) {
      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (text) abstractParts.push(`${m[1]}: ${text}`);
    }
    if (!abstractParts.length) {
      const absRe2 = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
      while ((m = absRe2.exec(art)) !== null) {
        const text = m[1].replace(/<[^>]+>/g, "").trim();
        if (text) abstractParts.push(text);
      }
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);

    const journalM = art.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalM ? journalM[1].trim() : "";

    let dateStr = "";
    const yearM = art.match(/<PubDate[^>]*>[\s\S]*?<Year>(\d+)<\/Year>/);
    const monthM = art.match(/<PubDate[^>]*>[\s\S]*?<Month>([^<]+)<\/Month>/);
    const dayM = art.match(/<PubDate[^>]*>[\s\S]*?<Day>(\d+)<\/Day>/);
    if (yearM) dateStr = yearM[1];
    if (monthM) dateStr += ` ${monthM[1]}`;
    if (dayM) dateStr += ` ${dayM[1]}`;

    const pmidM = art.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidM ? pmidM[1] : "";
    const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";

    const keywords = [];
    const kwRe = /<Keyword>([^<]+)<\/Keyword>/g;
    while ((m = kwRe.exec(art)) !== null) keywords.push(m[1].trim());

    papers.push({ pmid, title, journal, date: dateStr, abstract, url: link, keywords });
  }
  return papers;
}

async function main() {
  const opts = parseArgs();
  const dateStr = getDateStr();
  const dateFilter = buildDateFilter(opts.days);
  const skipPmids = getAlreadySummarizedPmids();

  console.error(`[INFO] Searching PubMed for GHB papers from last ${opts.days} days...`);
  console.error(`[INFO] Skipping ${skipPmids.size} already-summarized PMIDs`);

  const allPmids = new Set();
  for (const sq of SEARCH_QUERIES) {
    const ids = await searchPapers(sq.term, dateFilter, Math.ceil(opts.maxPapers / SEARCH_QUERIES.length));
    for (const id of ids) allPmids.add(id);
    console.error(`[INFO] ${sq.name}: ${ids.length} results`);
  }

  const filtered = [...allPmids].filter((id) => !skipPmids.has(id));
  const pmids = filtered.slice(0, opts.maxPapers);
  console.error(`[INFO] Total unique PMIDs: ${allPmids.size}, after filtering: ${pmids.length}`);

  let papers = [];
  if (pmids.length) {
    papers = await fetchDetails(pmids);
  }
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const output = { date: dateStr, count: papers.length, papers };
  writeFileSync(opts.output, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});

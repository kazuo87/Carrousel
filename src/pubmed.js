/**
 * Client NCBI E-utilities (PubMed) : esearch (identifiants) + efetch (XML détaillé).
 * Respecte l'étiquette NCBI : paramètres tool/email, clé API optionnelle,
 * ≤ 3 requêtes/s sans clé (≤ 10/s avec), nouvelles tentatives sur 429/5xx.
 * Documentation : https://www.ncbi.nlm.nih.gov/books/NBK25499/
 */
import { XMLParser } from "fast-xml-parser";
import { createLogger } from "./logger.js";

const log = createLogger("pubmed");

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PubMedClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl
   * @param {string} [options.apiKey]
   * @param {string} [options.email]
   * @param {string} [options.tool]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ baseUrl, apiKey = "", email = "", tool = "carrousel-sci-bot", timeoutMs = 20000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.email = email;
    this.tool = tool;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    // Limitation de débit : 3 req/s sans clé API, 10 req/s avec.
    this.minGapMs = apiKey ? 110 : 350;
    this.lastRequestAt = 0;
  }

  buildUrl(endpoint, params) {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    url.searchParams.set("db", "pubmed");
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    if (this.tool) url.searchParams.set("tool", this.tool);
    if (this.email) url.searchParams.set("email", this.email);
    if (this.apiKey) url.searchParams.set("api_key", this.apiKey);
    return url;
  }

  async request(endpoint, params, { attempts = 3 } = {}) {
    const url = this.buildUrl(endpoint, params);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const wait = this.lastRequestAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        const res = await this.fetchImpl(url, {
          headers: { "User-Agent": `${this.tool}/1.0 (+https://github.com/kazuo87/Carrousel)` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`NCBI ${endpoint} a répondu ${res.status}`);
          const retryAfter = Number(res.headers.get("retry-after")) || 0;
          await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** (attempt - 1)));
          continue;
        }
        if (!res.ok) throw new Error(`NCBI ${endpoint} a répondu ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return await res.text();
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          lastError = new Error(`NCBI ${endpoint} : délai dépassé (${this.timeoutMs} ms)`);
        } else if (err instanceof TypeError) {
          // Erreur réseau (DNS, connexion refusée, proxy…)
          lastError = new Error(`NCBI ${endpoint} : erreur réseau (${err.message})`);
        } else {
          throw err;
        }
        if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new Error(`NCBI ${endpoint} : échec`);
  }

  /**
   * Recherche des PMID. `reldate` limite aux N derniers jours (date d'entrée dans PubMed),
   * ce qui favorise les articles réellement nouveaux. Tri par défaut PubMed = plus récents.
   */
  async search(term, { retmax = 40, reldate = 14, datetype = "edat", sort } = {}) {
    const text = await this.request("esearch.fcgi", {
      term,
      retmax,
      retmode: "json",
      datetype,
      reldate,
      sort,
    });
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("esearch : réponse JSON invalide");
    }
    const result = json.esearchresult;
    if (!result) throw new Error(`esearch : réponse inattendue ${text.slice(0, 200)}`);
    if (result.ERROR) throw new Error(`esearch : ${result.ERROR}`);
    const ids = Array.isArray(result.idlist) ? result.idlist.map(String) : [];
    log.debug(`esearch "${term.slice(0, 60)}…" (reldate=${reldate}) → ${ids.length} id(s) sur ${result.count}`);
    return { ids, count: Number(result.count) || 0, queryTranslation: result.querytranslation };
  }

  /** Récupère les notices complètes (XML) et les convertit en objets simples. */
  async fetchArticles(ids) {
    if (!ids.length) return [];
    const xml = await this.request("efetch.fcgi", {
      id: ids.join(","),
      retmode: "xml",
      rettype: "abstract",
    });
    return parsePubmedXml(xml);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Analyse du XML PubMed                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Les titres et résumés peuvent contenir du balisage (<i>, <sup>…) : on garde le XML brut
  // de ces nœuds puis on retire les balises nous-mêmes.
  stopNodes: ["*.ArticleTitle", "*.AbstractText", "*.CopyrightInformation"],
  isArray: (name) =>
    ["PubmedArticle", "AbstractText", "Author", "ArticleId", "PublicationType", "MeshHeading", "Keyword", "KeywordList", "PubMedPubDate", "ELocationID"].includes(name),
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Retire le balisage XML/HTML et décode les entités courantes. */
export function stripTags(input) {
  if (input === undefined || input === null) return "";
  const text = typeof input === "object" ? String(input["#text"] ?? "") : String(input);
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(node) {
  if (node === undefined || node === null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "").trim();
  return String(node).trim();
}

function attrOf(node, name) {
  return node && typeof node === "object" ? node[`@_${name}`] : undefined;
}

/** Convertit un nœud PubDate / ArticleDate / PubMedPubDate en ISO (AAAA-MM-JJ, mois/jour facultatifs). */
export function parseDate(node) {
  if (!node) return "";
  const year = textOf(node.Year);
  if (!year) {
    const medline = textOf(node.MedlineDate);
    const m = medline.match(/(\d{4})/);
    return m ? m[1] : "";
  }
  let month = textOf(node.Month);
  if (month && !/^\d+$/.test(month)) month = MONTHS[month.slice(0, 3).toLowerCase()] ?? "";
  if (month) month = month.padStart(2, "0");
  const day = textOf(node.Day).padStart(2, "0");
  if (month && day !== "00" && textOf(node.Day)) return `${year}-${month}-${day}`;
  if (month) return `${year}-${month}`;
  return year;
}

function parseAbstract(abstractNode) {
  const parts = asArray(abstractNode?.AbstractText);
  const sections = parts
    .map((p) => ({ label: attrOf(p, "Label") ?? attrOf(p, "NlmCategory") ?? "", text: stripTags(p) }))
    .filter((s) => s.text);
  const text = sections.map((s) => (s.label ? `${s.label}: ${s.text}` : s.text)).join("\n");
  return { text, sections };
}

function parseAuthors(authorList) {
  return asArray(authorList?.Author)
    .map((a) => {
      const collective = textOf(a.CollectiveName);
      if (collective) return collective;
      const last = textOf(a.LastName);
      const fore = textOf(a.ForeName) || textOf(a.Initials);
      return [fore, last].filter(Boolean).join(" ");
    })
    .filter(Boolean);
}

/** Transforme un nœud <PubmedArticle> en objet « record ». */
export function recordFromNode(node) {
  const citation = node.MedlineCitation ?? {};
  const article = citation.Article ?? {};
  const journal = article.Journal ?? {};
  const pmid = textOf(citation.PMID);
  if (!pmid) return null;

  const ids = {};
  for (const idNode of asArray(node.PubmedData?.ArticleIdList?.ArticleId)) {
    const type = attrOf(idNode, "IdType");
    if (type) ids[type] = textOf(idNode);
  }
  if (!ids.doi) {
    const eloc = asArray(article.ELocationID).find((e) => attrOf(e, "EIdType") === "doi");
    if (eloc) ids.doi = textOf(eloc);
  }

  const history = {};
  for (const d of asArray(node.PubmedData?.History?.PubMedPubDate)) {
    const status = attrOf(d, "PubStatus");
    if (status) history[status] = parseDate(d);
  }

  const { text: abstract, sections: abstractSections } = parseAbstract(article.Abstract);
  const meshTerms = asArray(citation.MeshHeadingList?.MeshHeading)
    .map((m) => textOf(m.DescriptorName))
    .filter(Boolean);
  const keywords = asArray(citation.KeywordList)
    .flatMap((kl) => asArray(kl.Keyword))
    .map((k) => stripTags(k))
    .filter(Boolean);
  const publicationTypes = asArray(article.PublicationTypeList?.PublicationType).map(textOf).filter(Boolean);
  const pubDate = parseDate(article.ArticleDate) || parseDate(journal.JournalIssue?.PubDate);

  return {
    pmid,
    doi: ids.doi ?? "",
    pmcid: ids.pmc ?? "",
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    title: stripTags(article.ArticleTitle).replace(/\.$/, ""),
    abstract,
    abstractSections,
    journal: textOf(journal.Title),
    journalAbbrev: textOf(journal.ISOAbbreviation),
    pubDate,
    entrezDate: history.entrez ?? history.pubmed ?? "",
    authors: parseAuthors(article.AuthorList),
    language: asArray(article.Language).map(textOf)[0] ?? "",
    publicationTypes,
    meshTerms,
    keywords,
  };
}

/** Analyse une réponse efetch (PubmedArticleSet) et renvoie la liste des notices. */
export function parsePubmedXml(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`efetch : XML invalide (${err.message})`);
  }
  const set = doc.PubmedArticleSet;
  if (!set) {
    if (doc.eFetchResult?.ERROR) throw new Error(`efetch : ${doc.eFetchResult.ERROR}`);
    return [];
  }
  return asArray(set.PubmedArticle).map(recordFromNode).filter(Boolean);
}

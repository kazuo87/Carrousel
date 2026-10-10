/**
 * Faux serveur E-utilities pour les tests et les démonstrations hors ligne.
 * Sert esearch.fcgi (JSON) et efetch.fcgi (XML) à partir de test/fixtures/efetch-sample.xml.
 *
 *   node test/mock-eutils-server.js        → écoute sur le port 8765 (ou MOCK_PORT)
 *   PUBMED_BASE_URL=http://localhost:8765 npm start
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(here, "fixtures", "efetch-sample.xml"), "utf8");

/** Découpe la fixture en blocs <PubmedArticle> indexés par PMID. */
function splitArticles(xml) {
  const map = new Map();
  const re = /<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g;
  for (const block of xml.match(re) ?? []) {
    const pmid = block.match(/<PMID Version="1">(\d+)<\/PMID>/)?.[1];
    if (pmid) map.set(pmid, block);
  }
  return map;
}

export const ARTICLES = splitArticles(FIXTURE);

/** Associe une requête PubMed à une liste de PMID (simulation grossière de la recherche). */
export function idsForTerm(term) {
  const t = term.toLowerCase();
  if (t.includes("biosimilar")) return ["40000001", "40000003"];
  if (t.includes("peptide")) return ["40000002", "40000099"]; // 40000099 : identifiant sans notice PubmedArticle
  if (t.includes("first-in-class") || t.includes("new drug")) return ["40000004"];
  if (t.includes("randomized controlled trial")) return ["40000004", "40000001"];
  return [];
}

export function startMockEutils({ port = 0, onRequest, failures = {} } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    calls.push(url);
    onRequest?.(url);
    if (failures.status && (failures.remaining ?? 0) > 0) {
      failures.remaining -= 1;
      res.writeHead(failures.status, { "Content-Type": "text/plain", "Retry-After": "0" });
      return res.end("simulated failure");
    }
    if (url.pathname.endsWith("/esearch.fcgi")) {
      const ids = idsForTerm(url.searchParams.get("term") ?? "");
      const retmax = Number(url.searchParams.get("retmax")) || 20;
      const body = { header: { type: "esearch", version: "0.3" }, esearchresult: { count: String(ids.length), retmax: String(retmax), retstart: "0", idlist: ids.slice(0, retmax), translationset: [], querytranslation: url.searchParams.get("term") } };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    if (url.pathname.endsWith("/efetch.fcgi")) {
      const ids = (url.searchParams.get("id") ?? "").split(",").filter(Boolean);
      const blocks = ids.map((id) => ARTICLES.get(id)).filter(Boolean);
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(`<?xml version="1.0" ?>\n<PubmedArticleSet>\n${blocks.join("\n")}\n</PubmedArticleSet>`);
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      resolve({ url: `http://127.0.0.1:${p}`, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT) || 8765;
  startMockEutils({ port }).then(({ url }) => console.log(`Mock E-utilities : ${url} (PUBMED_BASE_URL=${url})`));
}

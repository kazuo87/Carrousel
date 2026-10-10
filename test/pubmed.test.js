import { test } from "node:test";
import assert from "node:assert/strict";
import { PubMedClient, parsePubmedXml, parseDate, stripTags } from "../src/pubmed.js";
import { FIXTURE_XML, records, recordByPmid } from "./helpers.js";

test("parsePubmedXml : notices complètes, livres ignorés", () => {
  const recs = records();
  assert.equal(recs.length, 4);
  assert.deepEqual(recs.map((r) => r.pmid), ["40000001", "40000002", "40000003", "40000004"]);
});

test("parsePubmedXml : champs de la notice structurée", () => {
  const r = recordByPmid("40000001");
  assert.equal(r.title, "Switching from reference adalimumab to biosimilar ABP 501 in patients with rheumatoid arthritis: a randomized, double-blind equivalence trial");
  assert.equal(r.doi, "10.1000/jcpt.2026.0001");
  assert.equal(r.pmcid, "PMC9900001");
  assert.equal(r.url, "https://pubmed.ncbi.nlm.nih.gov/40000001/");
  assert.equal(r.journal, "Journal of Clinical Pharmacology and Therapeutics");
  assert.equal(r.journalAbbrev, "J Clin Pharmacol Ther");
  assert.equal(r.pubDate, "2026-09-28"); // ArticleDate prioritaire sur PubDate (2026-10)
  assert.equal(r.entrezDate, "2026-10-02");
  assert.deepEqual(r.authors, ["Claire Martin", "Daniel Okafor", "Hiroshi Yamada"]);
  assert.equal(r.language, "eng");
  assert.deepEqual(r.publicationTypes, ["Journal Article", "Randomized Controlled Trial", "Multicenter Study"]);
  assert.deepEqual(r.meshTerms, ["Biosimilar Pharmaceuticals", "Adalimumab", "Arthritis, Rheumatoid", "Drug Substitution"]);
  assert.deepEqual(r.keywords, ["biosimilar", "adalimumab", "interchangeability"]);
  assert.deepEqual(r.abstractSections.map((s) => s.label), ["BACKGROUND", "METHODS", "RESULTS", "CONCLUSIONS"]);
  assert.match(r.abstract, /^BACKGROUND: Biosimilars of adalimumab/);
  assert.match(r.abstract, /equivalence margin of ±0\.6/);
  assert.ok(!r.abstract.includes("CopyrightInformation"));
});

test("parsePubmedXml : balisage, entités, auteur collectif, MedlineDate", () => {
  const peptide = recordByPmid("40000002");
  assert.match(peptide.abstract, /\(Kd = 2\.1 nM\)/);
  assert.equal(peptide.abstractSections.length, 1);
  assert.equal(peptide.abstractSections[0].label, "");
  assert.equal(peptide.meshTerms.length, 0);
  assert.equal(peptide.pubDate, "2026-09-30");

  const erratum = recordByPmid("40000003");
  assert.equal(erratum.pubDate, "2026");
  assert.equal(erratum.doi, "");
  assert.deepEqual(erratum.authors, []);

  const trial = recordByPmid("40000004");
  assert.match(trial.abstract, /P<0\.001/);
  assert.deepEqual(trial.authors, ["Lucía Fernández", "KRASCEND-3 Investigators"]);
  assert.equal(trial.pubDate, "2026-09-25");
  assert.deepEqual(trial.abstractSections.map((s) => s.label), ["Background", "Methods", "Results", "Conclusions"]);
});

test("parsePubmedXml : XML vide ou invalide", () => {
  assert.deepEqual(parsePubmedXml('<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>'), []);
  assert.throws(() => parsePubmedXml("<<not xml"), /XML invalide/);
  assert.throws(() => parsePubmedXml("<eFetchResult><ERROR>Empty id list</ERROR></eFetchResult>"), /Empty id list/);
});

test("parseDate / stripTags", () => {
  assert.equal(parseDate({ Year: "2026", Month: "Jan", Day: "5" }), "2026-01-05");
  assert.equal(parseDate({ Year: "2026", Month: "11" }), "2026-11");
  assert.equal(parseDate({ Year: "2026" }), "2026");
  assert.equal(parseDate({ MedlineDate: "2025 Dec-2026 Jan" }), "2025");
  assert.equal(parseDate(undefined), "");
  assert.equal(stripTags("<i>Hello</i> &amp; <sup>2</sup>  world"), "Hello & 2 world");
  assert.equal(stripTags("P&lt;0.05 &#169; &#x41;"), "P<0.05 © A");
  assert.equal(stripTags({ "#text": "<b>x</b>" }), "x");
  assert.equal(stripTags(null), "");
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return handler(new URL(url), calls.length);
  };
  return { impl, calls };
}

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("PubMedClient.search : paramètres E-utilities et identification", async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ esearchresult: { count: "2", idlist: ["1", "2"], querytranslation: "q" } }));
  const client = new PubMedClient({ baseUrl: "https://example.test/eutils/", apiKey: "KEY", email: "me@example.org", tool: "mytool", fetchImpl: impl });
  const result = await client.search("biosimilar[tiab]", { retmax: 5, reldate: 7 });
  assert.deepEqual(result.ids, ["1", "2"]);
  assert.equal(result.count, 2);
  const url = calls[0].url;
  assert.equal(url.origin + url.pathname, "https://example.test/eutils/esearch.fcgi");
  assert.equal(url.searchParams.get("db"), "pubmed");
  assert.equal(url.searchParams.get("term"), "biosimilar[tiab]");
  assert.equal(url.searchParams.get("retmax"), "5");
  assert.equal(url.searchParams.get("reldate"), "7");
  assert.equal(url.searchParams.get("datetype"), "edat");
  assert.equal(url.searchParams.get("retmode"), "json");
  assert.equal(url.searchParams.get("api_key"), "KEY");
  assert.equal(url.searchParams.get("email"), "me@example.org");
  assert.equal(url.searchParams.get("tool"), "mytool");
  assert.equal(url.searchParams.has("sort"), false);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("PubMedClient.search : erreur renvoyée par NCBI", async () => {
  const { impl } = fakeFetch(() => jsonResponse({ esearchresult: { ERROR: "Invalid query" } }));
  const client = new PubMedClient({ baseUrl: "https://example.test", fetchImpl: impl });
  await assert.rejects(client.search("x"), /Invalid query/);
});

test("PubMedClient : nouvelle tentative après 429 puis succès", async () => {
  const { impl, calls } = fakeFetch((url, n) =>
    n === 1 ? jsonResponse("busy", 429, { "retry-after": "0" }) : new Response(FIXTURE_XML, { status: 200 }),
  );
  const client = new PubMedClient({ baseUrl: "https://example.test", fetchImpl: impl });
  const recs = await client.fetchArticles(["40000001", "40000002"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get("id"), "40000001,40000002");
  assert.equal(calls[1].url.searchParams.get("retmode"), "xml");
  assert.equal(recs.length, 4);
});

test("PubMedClient : échec définitif après 3 erreurs serveur", async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse("down", 503, { "retry-after": "0" }));
  const client = new PubMedClient({ baseUrl: "https://example.test", fetchImpl: impl });
  await assert.rejects(client.search("x"), /503/);
  assert.equal(calls.length, 3);
});

test("PubMedClient : erreur réseau convertie en message lisible", async () => {
  const impl = async () => { throw new TypeError("fetch failed"); };
  const client = new PubMedClient({ baseUrl: "https://example.test", fetchImpl: impl });
  client.minGapMs = 0;
  await assert.rejects(client.search("x"), /erreur réseau/);
});

test("PubMedClient.fetchArticles : liste vide → aucune requête", async () => {
  const { impl, calls } = fakeFetch(() => { throw new Error("ne doit pas être appelé"); });
  const client = new PubMedClient({ baseUrl: "https://example.test", fetchImpl: impl });
  assert.deepEqual(await client.fetchArticles([]), []);
  assert.equal(calls.length, 0);
});

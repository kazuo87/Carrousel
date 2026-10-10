import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Pipeline } from "../src/pipeline.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";
import { PubMedClient } from "../src/pubmed.js";
import { SvgImageProvider } from "../src/generate/image.js";
import { generateExtractiveArticle } from "../src/generate/extractive.js";
import { getTopics } from "../src/topics.js";
import { buildConfig } from "../src/config.js";
import { startMockEutils } from "./mock-eutils-server.js";
import { tmpDir } from "./helpers.js";

const extractiveGenerator = { usesClaude: false, generate: async (r, t) => generateExtractiveArticle(r, t, { language: "fr" }) };

async function setup({ topics = ["biosimilaires", "peptides", "nouveaux-medicaments"], failures, generator = extractiveGenerator } = {}) {
  const { dir, images, cleanup } = await tmpDir();
  const mock = await startMockEutils({ failures });
  const config = buildConfig({ DATA_DIR: dir, PUBMED_BASE_URL: mock.url, TOPICS: topics.join(","), PUBMED_WINDOWS_DAYS: "14,60" });
  const store = await new Store({ dataDir: config.dataDir, imagesDir: config.imagesDir, maxArticles: 10 }).init();
  const pubmed = new PubMedClient({ ...config.pubmed });
  pubmed.minGapMs = 0;
  const pipeline = new Pipeline({ config, store, pubmed, articleGenerator: generator, imageProvider: new SvgImageProvider({ imagesDir: config.imagesDir, language: "fr" }), topics: getTopics(config.topics) });
  return { config, store, pipeline, mock, cleanup: async () => { await mock.close(); await cleanup(); } };
}

test("Pipeline.runOnce : crée un article nouveau et pertinent, puis tourne sur les sujets", async () => {
  const ctx = await setup();
  try {
    const first = await ctx.pipeline.runOnce();
    assert.equal(first.status, "created");
    const a = first.article;
    assert.equal(a.topic.id, "biosimilaires");
    assert.equal(a.source.pmid, "40000001", "l'erratum 40000003 est écarté");
    assert.equal(a.id, "pmid-40000001");
    assert.ok(fs.existsSync(path.join(ctx.config.imagesDir, "pmid-40000001.svg")));
    assert.equal(a.image.url, "/images/pmid-40000001.svg");
    assert.equal(a.image.provider, "svg");
    assert.equal(a.language, "fr");
    assert.ok(a.relevance.score > 4);
    assert.ok(a.sections.length >= 3 && a.keyPoints.length >= 2);
    assert.equal(ctx.store.state.topicCursor, 1);
    assert.equal(ctx.store.state.lastResult.status, "created");
    assert.ok(ctx.store.seen.pmids.has("40000003"), "notice rejetée mémorisée pour ne plus la re-télécharger");

    const second = await ctx.pipeline.runOnce();
    assert.equal(second.status, "created");
    assert.equal(second.article.topic.id, "peptides");
    assert.equal(second.article.source.pmid, "40000002");

    const third = await ctx.pipeline.runOnce();
    assert.equal(third.status, "created");
    assert.equal(third.article.topic.id, "nouveaux-medicaments");
    assert.equal(third.article.source.pmid, "40000004");

    const fourth = await ctx.pipeline.runOnce();
    assert.equal(fourth.status, "skipped", "plus rien de nouveau : aucun doublon généré");
    assert.equal(ctx.store.articles.length, 3);
    assert.equal(ctx.store.state.lastResult.status, "skipped");

    // Les fenêtres disjointes ([J-14, J] puis [J-60, J-14]) sont tentées pour chaque sujet quand rien n'est nouveau.
    const esearchCalls = ctx.mock.calls.filter((u) => u.pathname.endsWith("esearch.fcgi"));
    const windows = new Set(esearchCalls.map((u) => `${u.searchParams.get("mindate")}→${u.searchParams.get("maxdate")}`));
    assert.equal(windows.size, 2, [...windows].join(" | "));
    const [w1, w2] = [...windows];
    assert.equal(w1.split("→")[1], w2.split("→")[0] === w1.split("→")[0] ? w1.split("→")[1] : w1.split("→")[1]);
    assert.ok(esearchCalls.every((u) => u.searchParams.get("datetype") === "edat" && !u.searchParams.has("reldate")));
    assert.ok(esearchCalls.every((u) => u.searchParams.get("tool") === "carrousel-sci-bot"));
    assert.ok(ctx.store.seen.pmids.has("40000099"), "identifiant demandé mais absent de la réponse efetch mémorisé");

    const persisted = JSON.parse(fs.readFileSync(path.join(ctx.config.dataDir, "articles.json"), "utf8"));
    assert.equal(persisted.length, 3);
    assert.equal(persisted[0].id, "pmid-40000004");
  } finally {
    await ctx.cleanup();
  }
});

test("Pipeline.dateWindows : fenêtres disjointes de plus en plus anciennes", async () => {
  const ctx = await setup({ topics: ["peptides"] });
  try {
    ctx.pipeline.config.pubmed.windowsDays = [14, 60, 365, 30];
    ctx.pipeline.now = () => Date.parse("2026-10-10T12:00:00Z");
    assert.deepEqual(ctx.pipeline.dateWindows(), [
      { label: "14 derniers jours", mindate: "2026/09/26", maxdate: "2026/10/10" },
      { label: "J-60 à J-14", mindate: "2026/08/11", maxdate: "2026/09/26" },
      { label: "J-365 à J-60", mindate: "2025/10/10", maxdate: "2026/08/11" },
    ]);
  } finally {
    await ctx.cleanup();
  }
});

test("Pipeline.runOnce : une notice hors sujet pour un thème reste candidate pour un autre", async () => {
  const ctx = await setup({ topics: ["peptides", "biosimilaires"] });
  try {
    // Toute recherche renvoie la notice biosimilaire : sans mot-clé « peptide », elle est rejetée
    // pour ce sujet seulement, puis publiée sous « biosimilaires » dans le même tour.
    ctx.pipeline.pubmed.search = async () => ({ ids: ["40000001"], count: 1 });
    const result = await ctx.pipeline.runOnce();
    assert.equal(result.status, "created");
    assert.equal(result.article.topic.id, "biosimilaires");
    assert.equal(ctx.store.isRejected("peptides", "40000001"), true);
    assert.equal(ctx.store.state.topicCursor, 0, "le curseur avance après le sujet utilisé");
    const seen = JSON.parse(fs.readFileSync(path.join(ctx.config.dataDir, "seen.json"), "utf8"));
    assert.deepEqual(seen.rejected, { peptides: ["40000001"] });
  } finally {
    await ctx.cleanup();
  }
});

test("Pipeline.runOnce : la pagination parcourt une fenêtre avant de l'élargir", async () => {
  const ctx = await setup({ topics: ["peptides"] });
  try {
    const calls = [];
    ctx.pipeline.config.pubmed.retmax = 2;
    ctx.pipeline.pubmed.search = async (term, opts) => {
      calls.push(opts);
      // Fenêtre 1 : 5 identifiants connus sur 3 pages, puis la notice peptide en page 3.
      if (calls.length <= 2) return { ids: ["1", "2"].map((x) => `${x}${calls.length}`), count: 5 };
      if (calls.length === 3) return { ids: ["40000002"], count: 5 };
      return { ids: [], count: 0 };
    };
    for (const id of ["11", "21", "12", "22"]) ctx.store.seen.pmids.add(id);
    const result = await ctx.pipeline.runOnce();
    assert.equal(result.status, "created");
    assert.deepEqual(calls.map((c) => c.retstart), [0, 2, 4]);
    assert.ok(calls.every((c) => c.mindate === calls[0].mindate), "même fenêtre pour les trois pages");
  } finally {
    await ctx.cleanup();
  }
});

test("Pipeline.runOnce : un sujet en erreur n'affame pas les autres", async () => {
  const ctx = await setup({ topics: ["peptides", "biosimilaires"] });
  try {
    const original = ctx.pipeline.pubmed.search.bind(ctx.pipeline.pubmed);
    ctx.pipeline.pubmed.search = async (term, opts) => {
      if (term.includes("peptide")) throw new Error("esearch : requête refusée");
      return original(term, opts);
    };
    const first = await ctx.pipeline.runOnce();
    assert.equal(first.status, "error");
    assert.equal(ctx.store.state.lastError.topic, "peptides");
    assert.equal(ctx.store.state.topicCursor, 1, "le curseur dépasse le sujet en échec");
    const second = await ctx.pipeline.runOnce();
    assert.equal(second.status, "created");
    assert.equal(second.article.topic.id, "biosimilaires");
  } finally {
    await ctx.cleanup();
  }
});

test("Pipeline.runOnce : la nouveauté survit à un redémarrage", async () => {
  const ctx = await setup({ topics: ["peptides"] });
  try {
    assert.equal((await ctx.pipeline.runOnce()).status, "created");
    const store2 = await new Store({ dataDir: ctx.config.dataDir, imagesDir: ctx.config.imagesDir }).init();
    const pipeline2 = new Pipeline({ ...ctx.pipeline, store: store2 });
    assert.equal((await pipeline2.runOnce()).status, "skipped");
  } finally {
    await ctx.cleanup();
  }
});

test("Pipeline.runOnce : erreur NCBI → statut error, état enregistré, pas d'article", async () => {
  const ctx = await setup({ topics: ["peptides"], failures: { status: 500, remaining: 10 } });
  try {
    const result = await ctx.pipeline.runOnce();
    assert.equal(result.status, "error");
    assert.match(result.error.message, /500/);
    assert.equal(ctx.store.articles.length, 0);
    assert.match(ctx.store.state.lastError.message, /500/);
    assert.equal(ctx.store.state.lastResult.status, "error");
  } finally {
    await ctx.cleanup();
  }
});

test("Pipeline.runOnce : le générateur d'article peut échouer sans corrompre l'état", async () => {
  const ctx = await setup({ topics: ["peptides"], generator: { usesClaude: false, generate: async () => { throw new Error("boom"); } } });
  try {
    const result = await ctx.pipeline.runOnce();
    assert.equal(result.status, "error");
    assert.equal(ctx.store.articles.length, 0);
    assert.equal(ctx.store.seen.pmids.has("40000002"), false, "la notice reste disponible pour un prochain essai");
  } finally {
    await ctx.cleanup();
  }
});

test("Scheduler : grille fixe, créneaux manqués sautés, stop/start sans double chaîne", async () => {
  const runs = [];
  let duration = 10;
  const scheduler = new Scheduler({ intervalMs: 50, task: async () => { runs.push(Date.now()); await new Promise((r) => setTimeout(r, duration)); return { status: "skipped" }; }, runOnStart: false });
  const t0 = Date.now();
  scheduler.start();
  assert.ok(Math.abs(scheduler.nextRunAt - (t0 + 50)) <= 5, "premier créneau = démarrage + intervalle");
  await new Promise((r) => setTimeout(r, 130));
  // Les créneaux sont à +50, +100 (indépendants de la durée des tours).
  assert.ok(runs.length >= 2, `runs=${runs.length}`);
  for (const [i, at] of runs.entries()) {
    const expected = t0 + 50 * (i + 1);
    assert.ok(at - expected >= -5 && at - expected < 40, `tour ${i + 1} à +${at - t0} ms, attendu +${expected - t0}`);
  }
  duration = 120; // un tour plus long que l'intervalle : le créneau suivant est sauté, pas rattrapé
  await new Promise((r) => setTimeout(r, 200));
  await scheduler.stop();
  assert.ok(scheduler.status().skippedSlots >= 1, "créneau sauté comptabilisé");
  const countAfterStop = runs.length;
  duration = 5;
  scheduler.start();
  await new Promise((r) => setTimeout(r, 130));
  await scheduler.stop();
  const newRuns = runs.length - countAfterStop;
  assert.ok(newRuns >= 1 && newRuns <= 3, `une seule chaîne de minuterie après stop/start (${newRuns} tours en 130 ms)`);
});

test("Scheduler : exécution immédiate, cadence, pas de chevauchement", async () => {
  let running = 0;
  let maxConcurrent = 0;
  let count = 0;
  const task = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    count += 1;
    await new Promise((r) => setTimeout(r, 60));
    running -= 1;
    return { status: "created", article: { id: `a${count}`, title: "t", topic: { id: "x" } } };
  };
  const scheduler = new Scheduler({ intervalMs: 40, task, runOnStart: true });
  scheduler.start();
  const busy = await scheduler.tick(); // appelé pendant l'exécution initiale → ignoré
  await new Promise((r) => setTimeout(r, 30));
  const busy2 = await scheduler.tick();
  await new Promise((r) => setTimeout(r, 250));
  await scheduler.stop();
  const status = scheduler.status();
  assert.equal(maxConcurrent, 1);
  assert.ok(count >= 2 && count <= 7, `count=${count}`);
  assert.ok(busy.status === "busy" || busy2.status === "busy");
  assert.ok(status.skippedOverlaps >= 1);
  assert.equal(status.lastResult.status, "created");
  assert.equal(status.nextRunAt, null);
  assert.equal(status.running, false);
  assert.throws(() => new Scheduler({ intervalMs: 0, task }), /intervalMs/);
});

test("Scheduler : une tâche qui lève ne tue pas le planificateur", async () => {
  const scheduler = new Scheduler({ intervalMs: 1000, task: async () => { throw new Error("kaboom"); }, runOnStart: false });
  const result = await scheduler.tick();
  assert.equal(result.status, "error");
  assert.equal(scheduler.status().lastResult.message, "kaboom");
  assert.equal(scheduler.running, false);
});

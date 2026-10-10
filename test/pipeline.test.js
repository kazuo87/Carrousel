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

    // Les deux fenêtres (14 puis 60 jours) sont tentées pour chaque sujet quand rien n'est nouveau.
    const esearchCalls = ctx.mock.calls.filter((u) => u.pathname.endsWith("esearch.fcgi"));
    assert.ok(esearchCalls.some((u) => u.searchParams.get("reldate") === "60"));
    assert.ok(esearchCalls.every((u) => u.searchParams.get("tool") === "carrousel-sci-bot"));

    const persisted = JSON.parse(fs.readFileSync(path.join(ctx.config.dataDir, "articles.json"), "utf8"));
    assert.equal(persisted.length, 3);
    assert.equal(persisted[0].id, "pmid-40000004");
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
  assert.ok(count >= 2 && count <= 4, `count=${count}`);
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

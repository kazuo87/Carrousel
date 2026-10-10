import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.js";
import { tmpDir } from "./helpers.js";

const article = (n) => ({
  id: `pmid-${n}`,
  title: `Titre ${n}`,
  image: { file: `pmid-${n}.svg`, url: `/images/pmid-${n}.svg` },
  topic: { id: n % 2 ? "peptides" : "biosimilaires" },
  source: { pmid: String(n), doi: `10.1/${n}`, title: `Titre source ${n}` },
});

test("Store : persistance, nouveauté et rechargement", async () => {
  const { dir, images, cleanup } = await tmpDir();
  try {
    const store = await new Store({ dataDir: dir, imagesDir: images, maxArticles: 3 }).init();
    assert.ok(fs.existsSync(images));
    assert.deepEqual(store.articles, []);
    const events = [];
    store.onArticle((a) => events.push(a.id));

    for (let n = 1; n <= 4; n++) {
      fs.writeFileSync(path.join(images, `pmid-${n}.svg`), "<svg/>");
      await store.addArticle(article(n));
    }
    assert.deepEqual(store.articles.map((a) => a.id), ["pmid-4", "pmid-3", "pmid-2"], "le plus ancien est évincé");
    assert.equal(fs.existsSync(path.join(images, "pmid-1.svg")), false, "image de l'article évincé supprimée");
    assert.ok(store.seen.pmids.has("1"), "le PMID évincé reste connu");
    assert.ok(store.seen.dois.has("10.1/1"));
    assert.deepEqual(events, ["pmid-1", "pmid-2", "pmid-3", "pmid-4"]);

    await store.saveState({ topicCursor: 2, runs: 7 });
    const reloaded = await new Store({ dataDir: dir, imagesDir: images, maxArticles: 3 }).init();
    assert.deepEqual(reloaded.articles.map((a) => a.id), ["pmid-4", "pmid-3", "pmid-2"]);
    assert.ok(reloaded.seen.pmids.has("1") && reloaded.seen.pmids.has("4"));
    assert.equal(reloaded.state.topicCursor, 2);
    assert.equal(reloaded.state.runs, 7);
    assert.deepEqual(reloaded.listArticles({ limit: 1 }).map((a) => a.id), ["pmid-4"]);
    assert.deepEqual(reloaded.listArticles({ topic: "peptides" }).map((a) => a.id), ["pmid-3"]);
    assert.equal(reloaded.getArticle("pmid-2").title, "Titre 2");
    assert.equal(reloaded.getArticle("nope"), null);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "pas de fichier temporaire résiduel");
  } finally {
    await cleanup();
  }
});

test("Store : fichier corrompu → erreur explicite", async () => {
  const { dir, images, cleanup } = await tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "articles.json"), "{not json");
    await assert.rejects(new Store({ dataDir: dir, imagesDir: images }).init(), /articles\.json illisible/);
  } finally {
    await cleanup();
  }
});

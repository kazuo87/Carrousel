import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store, migrateArticle } from "../src/store.js";
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

    store.markRejected("peptides", "77");
    await store.saveSeen();
    await store.saveState({ topicCursor: 2, runs: 7 });
    fs.writeFileSync(path.join(images, "orphan.svg"), "<svg/>");
    fs.writeFileSync(path.join(dir, "articles.json.123.456.tmp"), "{");
    const reloaded = await new Store({ dataDir: dir, imagesDir: images, maxArticles: 3 }).init();
    assert.equal(reloaded.isRejected("peptides", "77"), true);
    assert.equal(reloaded.isRejected("biosimilaires", "77"), false);
    assert.equal(fs.existsSync(path.join(images, "orphan.svg")), false, "illustration orpheline supprimée");
    assert.equal(fs.existsSync(path.join(images, "pmid-4.svg")), true, "illustration référencée conservée");
    assert.equal(fs.existsSync(path.join(dir, "articles.json.123.456.tmp")), false, "fichier temporaire nettoyé");
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

test("Store : fichier corrompu → mis de côté, reprise avec les valeurs par défaut", async () => {
  const { dir, images, cleanup } = await tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "articles.json"), "{not json");
    fs.writeFileSync(path.join(dir, "seen.json"), "");
    const store = await new Store({ dataDir: dir, imagesDir: images }).init();
    assert.deepEqual(store.articles, []);
    assert.equal(store.seen.pmids.size, 0);
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith("articles.json.corrompu-")), files.join());
    assert.ok(files.some((f) => f.startsWith("seen.json.corrompu-")), files.join());
  } finally {
    await cleanup();
  }
});

test("Store : l'index de nouveauté est borné aux PMID les plus récents", async () => {
  const { dir, images, cleanup } = await tmpDir();
  try {
    const { MAX_SEEN_PMIDS } = await import("../src/store.js");
    const store = await new Store({ dataDir: dir, imagesDir: images }).init();
    for (let i = 1; i <= MAX_SEEN_PMIDS + 10; i++) store.seen.pmids.add(String(i));
    store.markRejected("peptides", "3");
    store.pruneSeen();
    assert.equal(store.seen.pmids.size, MAX_SEEN_PMIDS);
    assert.equal(store.seen.pmids.has("1"), false);
    assert.equal(store.seen.pmids.has(String(MAX_SEEN_PMIDS + 10)), true);
    assert.equal(store.isRejected("peptides", "3"), false, "rejet oublié avec le PMID");
  } finally {
    await cleanup();
  }
});

test("migrateArticle : articles d'une version précédente", () => {
  const legacy = migrateArticle({ id: "pmid-1", language: "fr", generator: "extractive", title: "T", topic: { id: "peptides", label: "Peptides thérapeutiques" } });
  assert.deepEqual(legacy.languages, ["fr"]);
  assert.equal(legacy.bodyLanguage, "en");
  assert.deepEqual(legacy.topic.labels, { fr: "Peptides thérapeutiques", en: "Therapeutic peptides", ar: "الببتيدات العلاجية" });
  assert.equal(legacy.topic.label, "Peptides thérapeutiques");
  assert.equal(migrateArticle({ id: "x", topic: { id: "inconnu", label: "?" } }).topic.labels, undefined);
  const claude = migrateArticle({ id: "pmid-2", language: "fr", generator: "claude:claude-opus-5-5" });
  assert.equal(claude.bodyLanguage, null);
  const current = migrateArticle({ id: "pmid-3", language: "fr", languages: ["fr", "en", "ar"], generator: "extractive", bodyLanguage: "en" });
  assert.deepEqual(current.languages, ["fr", "en", "ar"]);
});

test("Store.init : les articles anciens sont complétés au chargement", async () => {
  const { dir, images, cleanup } = await tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "articles.json"), JSON.stringify([{ id: "pmid-9", language: "fr", generator: "extractive", title: "Ancien", source: { pmid: "9", title: "Ancien" } }]));
    const store = await new Store({ dataDir: dir, imagesDir: images }).init();
    assert.equal(store.articles[0].bodyLanguage, "en");
    assert.deepEqual(store.articles[0].languages, ["fr"]);
  } finally {
    await cleanup();
  }
});

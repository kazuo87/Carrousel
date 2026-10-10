import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.js";
import { getTopics, buildQuery, TOPICS } from "../src/topics.js";

test("buildConfig : valeurs par défaut", () => {
  const cfg = buildConfig({});
  assert.equal(cfg.intervalMinutes, 6);
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.articleLanguage, "fr");
  assert.equal(cfg.claude.model, "claude-opus-5-5");
  assert.equal(cfg.claude.effort, "medium");
  assert.equal(cfg.image.provider, "svg");
  assert.deepEqual(cfg.pubmed.windowsDays, [14, 60, 365]);
  assert.ok(cfg.pubmed.baseUrl.startsWith("https://eutils.ncbi.nlm.nih.gov"));
  assert.ok(cfg.imagesDir.endsWith("/data/images"));
});

test("buildConfig : surcharge et validation", () => {
  const cfg = buildConfig({ INTERVAL_MINUTES: "3", TOPICS: "peptides, biosimilaires", PUBMED_WINDOWS_DAYS: "7,30", ARTICLE_LANGUAGE: "en", DATA_DIR: "/tmp/x" });
  assert.equal(cfg.intervalMinutes, 3);
  assert.deepEqual(cfg.topics, ["peptides", "biosimilaires"]);
  assert.deepEqual(cfg.pubmed.windowsDays, [7, 30]);
  assert.equal(cfg.articleLanguage, "en");
  assert.equal(cfg.dataDir, "/tmp/x");
  assert.throws(() => buildConfig({ INTERVAL_MINUTES: "0" }), /INTERVAL_MINUTES/);
  assert.throws(() => buildConfig({ INTERVAL_MINUTES: "abc" }), /INTERVAL_MINUTES/);
  assert.throws(() => buildConfig({ ARTICLE_LANGUAGE: "de" }), /ARTICLE_LANGUAGE/);
  assert.throws(() => buildConfig({ IMAGE_PROVIDER: "dalle" }), /IMAGE_PROVIDER/);
  assert.throws(() => buildConfig({ CLAUDE_EFFORT: "ultra" }), /CLAUDE_EFFORT/);
});

test("topics : sélection et requêtes", () => {
  assert.equal(getTopics([]).length, TOPICS.length);
  assert.deepEqual(getTopics(["biosimilaires"]).map((t) => t.id), ["biosimilaires"]);
  assert.throws(() => getTopics(["inconnu"]), /Sujets inconnus/);
  const q = buildQuery(getTopics(["biosimilaires"])[0]);
  assert.match(q, /biosimilar/);
  assert.match(q, /hasabstract\[text\]/);
  assert.match(q, /NOT \(comment\[pt\]/);
  for (const t of TOPICS) {
    assert.ok(t.id && t.label.fr && t.label.en && t.query && t.keywords.length && t.theme && typeof t.hue === "number");
  }
});

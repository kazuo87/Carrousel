import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig, loadDotEnv } from "../src/config.js";
import { getTopics, buildQuery, TOPICS } from "../src/topics.js";

test("buildConfig : valeurs par défaut", () => {
  const cfg = buildConfig({});
  assert.equal(cfg.intervalMinutes, 6);
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.articleLanguage, "fr");
  assert.deepEqual(cfg.languages, ["fr", "en", "ar"]);
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
  assert.throws(() => buildConfig({ LANGUAGES: "fr,de" }), /LANGUAGES/);
  assert.throws(() => buildConfig({ LANGUAGES: "fr", ARTICLE_LANGUAGE: "en" }), /ARTICLE_LANGUAGE/);
  assert.equal(buildConfig({ LANGUAGES: "ar,en" }).articleLanguage, "ar", "langue principale = première de la liste");
  assert.deepEqual(buildConfig({ LANGUAGES: " en , fr " }).languages, ["en", "fr"]);
  assert.deepEqual(buildConfig({ LANGUAGES: "fr,fr,en" }).languages, ["fr", "en"], "doublons ignorés");
  assert.equal(buildConfig({ LANGUAGES: "en,ar", ARTICLE_LANGUAGE: "" }).articleLanguage, "en");
  assert.equal(buildConfig({}).claude.hardTimeoutMs, 300000);
  assert.equal(buildConfig({ CLAUDE_HARD_TIMEOUT_MS: "360000" }).claude.hardTimeoutMs, 324000, "borné à 90 % de l'intervalle");
  assert.equal(buildConfig({ INTERVAL_MINUTES: "0.1" }).claude.hardTimeoutMs, 5400);
  assert.throws(() => buildConfig({ IMAGE_PROVIDER: "dalle" }), /IMAGE_PROVIDER/);
  assert.throws(() => buildConfig({ CLAUDE_EFFORT: "ultra" }), /CLAUDE_EFFORT/);
  assert.throws(() => buildConfig({ CLAUDE_FALLBACKS: "maybe" }), /CLAUDE_FALLBACKS/);
  assert.throws(() => buildConfig({ PUBMED_WINDOWS_DAYS: "14,-1" }), /PUBMED_WINDOWS_DAYS/);
  assert.equal(buildConfig({}).claude.maxTokens, 16000);
  assert.equal(buildConfig({}).claude.maxRetries, 1);
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
    assert.ok(!t.keywords.includes("mic"), "« mic » est un préfixe de mice/microbiome : trop ambigu");
  }
  assert.match(getTopics(["essais-cliniques"])[0].query, /"randomized"\[tiab\]/);
});

test("loadDotEnv : valeurs vides ignorées, ligne ajoutée en fin de fichier prise en compte, environnement non écrasé", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-")), ".env");
  fs.writeFileSync(file, ['# commentaire', 'TEST_DOTENV_KEY=', 'TEST_DOTENV_QUOTED="avec espaces"', 'TEST_DOTENV_EXISTING=fichier', 'TEST_DOTENV_KEY=valeur-finale', ''].join("\n"));
  process.env.TEST_DOTENV_EXISTING = "environnement";
  delete process.env.TEST_DOTENV_KEY;
  delete process.env.TEST_DOTENV_QUOTED;
  try {
    loadDotEnv(file);
    assert.equal(process.env.TEST_DOTENV_KEY, "valeur-finale");
    assert.equal(process.env.TEST_DOTENV_QUOTED, "avec espaces");
    assert.equal(process.env.TEST_DOTENV_EXISTING, "environnement");
    loadDotEnv(path.join(path.dirname(file), "absent.env")); // fichier absent : silencieux
  } finally {
    delete process.env.TEST_DOTENV_KEY;
    delete process.env.TEST_DOTENV_QUOTED;
    delete process.env.TEST_DOTENV_EXISTING;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

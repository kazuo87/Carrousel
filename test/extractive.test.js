import { test } from "node:test";
import assert from "node:assert/strict";
import { generateExtractiveArticle, splitSentences } from "../src/generate/extractive.js";
import { TOPICS } from "../src/topics.js";
import { recordByPmid } from "./helpers.js";

const topic = (id) => TOPICS.find((t) => t.id === id);

test("splitSentences : découpe raisonnable", () => {
  const s = splitSentences("First sentence here. Second one, e.g. with abbreviation. Third (parenthesis) ends! Fourth?");
  assert.deepEqual(s, ["First sentence here.", "Second one, e.g. with abbreviation.", "Third (parenthesis) ends!"].concat([]));
});

test("generateExtractiveArticle : résumé structuré → sections nommées (fr)", () => {
  const a = generateExtractiveArticle(recordByPmid("40000001"), topic("biosimilaires"), { language: "fr" });
  assert.equal(a.generator, "extractive");
  assert.match(a.title, /adalimumab/);
  assert.deepEqual(a.sections.map((s) => s.heading), ["Contexte", "Méthodes", "Résultats", "Conclusions", "Source"]);
  assert.ok(a.keyPoints.length >= 2 && a.keyPoints.length <= 4);
  assert.ok(a.keyPoints.some((k) => /%/.test(k)), "les points clés privilégient les chiffres");
  assert.ok(a.summary.length > 50 && a.summary.length <= 400);
  assert.ok(a.tags.includes("biosimilar"));
  assert.match(a.dek, /Journal of Clinical Pharmacology and Therapeutics \(2026\)/);
  assert.match(a.imagePrompt, /biosimilars/i);
});

test("generateExtractiveArticle : résumé non structuré → découpage en tiers (en)", () => {
  const a = generateExtractiveArticle(recordByPmid("40000002"), topic("peptides"), { language: "en" });
  assert.deepEqual(a.sections.map((s) => s.heading), ["Background", "What the study shows", "Conclusions", "Source"]);
  assert.ok(a.sections.every((s) => s.content.length > 20));
  assert.ok(a.tags.includes("GLP-1"));
  assert.match(a.sections.at(-1).content, /not medical advice/);
});

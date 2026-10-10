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

test("generateExtractiveArticle : résumé structuré → sections nommées dans chaque langue", () => {
  const a = generateExtractiveArticle(recordByPmid("40000001"), topic("biosimilaires"), { languages: ["fr", "en", "ar"] });
  assert.equal(a.generator, "extractive");
  assert.equal(a.bodyLanguage, "en", "le corps du texte reste celui du résumé, en anglais");
  assert.deepEqual(Object.keys(a.content), ["fr", "en", "ar"]);
  const fr = a.content.fr;
  assert.match(fr.title, /adalimumab/);
  assert.deepEqual(fr.sections.map((s) => s.heading), ["Contexte", "Méthodes", "Résultats", "Conclusions", "Source"]);
  assert.deepEqual(a.content.en.sections.map((s) => s.heading), ["Background", "Methods", "Results", "Conclusions", "Source"]);
  assert.deepEqual(a.content.ar.sections.map((s) => s.heading), ["السياق", "المنهجية", "النتائج", "الخلاصة", "المصدر"]);
  assert.equal(a.content.ar.sections[0].content, fr.sections[0].content, "même corps de texte");
  assert.ok(fr.keyPoints.length >= 2 && fr.keyPoints.length <= 4);
  assert.ok(fr.keyPoints.some((k) => /%/.test(k)), "les points clés privilégient les chiffres");
  assert.ok(fr.summary.length > 50 && fr.summary.length <= 400);
  assert.ok(fr.tags.includes("biosimilar"));
  assert.match(fr.dek, /Journal of Clinical Pharmacology and Therapeutics \(2026\)/);
  assert.match(a.content.ar.dek, /^دراسة منشورة في/);
  assert.match(a.imagePrompt, /biosimilars/i);
  assert.match(a.content.ar.imageAlt, /^رسم توضيحي — الأدوية الحيوية المماثلة/);
});

test("generateExtractiveArticle : résumé non structuré → découpage en tiers (en)", () => {
  const a = generateExtractiveArticle(recordByPmid("40000002"), topic("peptides"), { languages: ["en"] }).content.en;
  assert.deepEqual(a.sections.map((s) => s.heading), ["Background", "What the study shows", "Conclusions", "Source"]);
  assert.ok(a.sections.every((s) => s.content.length > 20));
  assert.ok(a.tags.includes("GLP-1"));
  assert.match(a.sections.at(-1).content, /not medical advice/);
});

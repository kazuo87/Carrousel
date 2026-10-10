import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRecord, isNovel, rankCandidates, titleFingerprint } from "../src/relevance.js";
import { TOPICS } from "../src/topics.js";
import { records, recordByPmid, emptySeen, NOW } from "./helpers.js";

const topic = (id) => TOPICS.find((t) => t.id === id);

test("scoreRecord : notice biosimilaire très pertinente pour le sujet biosimilaires", () => {
  const { score, reasons } = scoreRecord(recordByPmid("40000001"), topic("biosimilaires"), { now: NOW });
  assert.ok(score >= 15, `score ${score}`);
  assert.ok(reasons.some((r) => r.includes("titre")));
  assert.ok(reasons.some((r) => r.includes("MeSH")));
  assert.ok(reasons.some((r) => r.includes("Randomized Controlled Trial")));
  assert.ok(reasons.some((r) => r.includes("3 jours")));
});

test("scoreRecord : erratum et résumé trop court exclus", () => {
  assert.equal(scoreRecord(recordByPmid("40000003"), topic("biosimilaires"), { now: NOW }).score, -100);
  const short = { ...recordByPmid("40000001"), abstract: "trop court", abstractSections: [] };
  assert.equal(scoreRecord(short, topic("biosimilaires"), { now: NOW }).score, -100);
});

test("scoreRecord : la pertinence dépend du sujet", () => {
  const peptide = recordByPmid("40000002");
  const forPeptides = scoreRecord(peptide, topic("peptides"), { now: NOW }).score;
  const forBiosimilars = scoreRecord(peptide, topic("biosimilaires"), { now: NOW }).score;
  assert.ok(forPeptides > forBiosimilars + 5, `${forPeptides} vs ${forBiosimilars}`);
});

test("scoreRecord : pénalité pour une langue autre que l'anglais", () => {
  const r = recordByPmid("40000001");
  const eng = scoreRecord(r, topic("biosimilaires"), { now: NOW }).score;
  const fre = scoreRecord({ ...r, language: "fre" }, topic("biosimilaires"), { now: NOW }).score;
  assert.equal(eng - fre, 3);
});

test("titleFingerprint : insensible à la casse, aux accents et à la ponctuation", () => {
  assert.equal(titleFingerprint("Étude: Résultats!"), titleFingerprint("etude resultats"));
  assert.notEqual(titleFingerprint("a"), titleFingerprint("b"));
});

test("isNovel : PMID, DOI ou titre déjà vus", () => {
  const r = recordByPmid("40000001");
  assert.equal(isNovel(r, emptySeen()), true);
  assert.equal(isNovel(r, { ...emptySeen(), pmids: new Set(["40000001"]) }), false);
  assert.equal(isNovel(r, { ...emptySeen(), dois: new Set(["10.1000/JCPT.2026.0001".toLowerCase()]) }), false);
  assert.equal(isNovel(r, { ...emptySeen(), titles: new Set([titleFingerprint(r.title)]) }), false);
});

test("rankCandidates : tri décroissant, filtre nouveauté et score minimal", () => {
  const seen = { ...emptySeen(), pmids: new Set(["40000002"]) };
  const ranked = rankCandidates(records(), topic("nouveaux-medicaments"), seen, { minScore: 4, now: NOW });
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].record.pmid, "40000004");
  assert.ok(!ranked.some((r) => r.record.pmid === "40000002"), "déjà vu exclu");
  assert.ok(!ranked.some((r) => r.record.pmid === "40000003"), "erratum exclu");
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  assert.equal(rankCandidates(records(), topic("nouveaux-medicaments"), emptySeen(), { minScore: 1000, now: NOW }).length, 0);
});

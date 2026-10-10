import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRecord, isNovel, rankCandidates, titleFingerprint, HARD_REJECT, SOFT_REJECT } from "../src/relevance.js";
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

test("scoreRecord : erratum et résumé trop court exclus définitivement", () => {
  assert.equal(scoreRecord(recordByPmid("40000003"), topic("biosimilaires"), { now: NOW }).score, HARD_REJECT);
  const short = { ...recordByPmid("40000001"), abstract: "trop court", abstractSections: [] };
  assert.equal(scoreRecord(short, topic("biosimilaires"), { now: NOW }).score, HARD_REJECT);
});

test("scoreRecord : sans aucun mot-clé du sujet, la fraîcheur et le type ne suffisent pas", () => {
  // La notice biosimilaire (essai randomisé, très récente) n'a aucun rapport avec les peptides.
  const { score, reasons } = scoreRecord(recordByPmid("40000001"), topic("peptides"), { now: NOW });
  assert.equal(score, SOFT_REJECT);
  assert.match(reasons[0], /aucun mot-clé/);
  assert.ok(SOFT_REJECT > HARD_REJECT, "rejet pour ce sujet seulement, pas exclusion définitive");
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

test("rankCandidates : tri décroissant, filtre nouveauté, score minimal, rejets explicites", () => {
  const seen = { ...emptySeen(), pmids: new Set(["40000002"]) };
  const { accepted, rejected } = rankCandidates(records(), topic("nouveaux-medicaments"), seen, { minScore: 4, now: NOW });
  assert.ok(accepted.length >= 1);
  assert.equal(accepted[0].record.pmid, "40000004");
  assert.ok(!accepted.some((r) => r.record.pmid === "40000002"), "déjà vu exclu");
  assert.ok(!rejected.some((r) => r.record.pmid === "40000002"), "déjà vu ni accepté ni rejeté");
  const erratum = rejected.find((r) => r.record.pmid === "40000003");
  assert.equal(erratum.score, HARD_REJECT);
  for (let i = 1; i < accepted.length; i++) assert.ok(accepted[i - 1].score >= accepted[i].score);
  const strict = rankCandidates(records(), topic("nouveaux-medicaments"), emptySeen(), { minScore: 1000, now: NOW });
  assert.equal(strict.accepted.length, 0);
  assert.equal(strict.rejected.length, 4);
});

/**
 * Pertinence et nouveauté des notices PubMed.
 *  - score de pertinence : mots-clés du sujet (titre, résumé, MeSH, mots-clés auteurs),
 *    type de publication, longueur du résumé, fraîcheur ;
 *  - nouveauté : PMID / DOI / titre normalisé jamais traités.
 */
import { createHash } from "node:crypto";

/** Score des notices exclues définitivement (erratum, pas de résumé…) : jamais reprises, quel que soit le sujet. */
export const HARD_REJECT = -100;
/** Score des notices sans rapport avec le sujet courant : elles restent candidates pour les autres sujets. */
export const SOFT_REJECT = -50;

const EXCLUDED_TITLE = /\b(erratum|corrigendum|retraction|retracted|correction to|comment on|author(?:'s)? reply|reply to|withdrawn)\b/i;

const PUBTYPE_BONUS = [
  [/randomized controlled trial/i, 3],
  [/clinical trial, phase (ii|iii|iv)/i, 3],
  [/clinical trial/i, 2],
  [/meta-analysis/i, 2],
  [/systematic review/i, 2],
  [/multicenter study/i, 1],
  [/review/i, 1],
];

const PUBTYPE_MALUS = [
  [/case reports?/i, -2],
  [/comment|editorial|letter|news|published erratum|retraction/i, -10],
];

/** Titre normalisé (minuscule, sans ponctuation ni espaces multiples) → empreinte SHA-1 courte. */
export function titleFingerprint(title) {
  const normalized = String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function countMatches(haystack, keyword) {
  if (!haystack) return 0;
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}`, "g");
  return (haystack.match(re) ?? []).length;
}

function daysSince(isoDate, now) {
  if (!isoDate) return null;
  const parsed = Date.parse(isoDate.length === 4 ? `${isoDate}-01-01` : isoDate.length === 7 ? `${isoDate}-01` : isoDate);
  if (Number.isNaN(parsed)) return null;
  return (now - parsed) / 86_400_000;
}

/**
 * Calcule un score de pertinence pour une notice vis-à-vis d'un sujet.
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreRecord(record, topic, { now = Date.now() } = {}) {
  const reasons = [];
  let score = 0;

  if (!record.abstract || record.abstract.length < 400) {
    return { score: HARD_REJECT, reasons: ["résumé absent ou trop court"] };
  }
  if (EXCLUDED_TITLE.test(record.title)) {
    return { score: HARD_REJECT, reasons: ["erratum / commentaire / rétractation"] };
  }
  if (record.language && record.language !== "eng") {
    score -= 3;
    reasons.push(`langue ${record.language}`);
  }

  const title = record.title.toLowerCase();
  const abstract = record.abstract.toLowerCase();
  const mesh = record.meshTerms.join(" | ").toLowerCase();
  const kw = record.keywords.join(" | ").toLowerCase();

  let titleHits = 0;
  let abstractHits = 0;
  let meshHits = 0;
  let kwHits = 0;
  for (const keyword of topic.keywords) {
    titleHits += Math.min(countMatches(title, keyword), 2);
    abstractHits += Math.min(countMatches(abstract, keyword), 4);
    meshHits += Math.min(countMatches(mesh, keyword), 2);
    kwHits += Math.min(countMatches(kw, keyword), 2);
  }
  if (titleHits + abstractHits + meshHits + kwHits === 0) {
    // Aucun signal thématique : la fraîcheur ou le type de publication ne doivent pas suffire.
    return { score: SOFT_REJECT, reasons: ["aucun mot-clé du sujet dans le titre, le résumé, les MeSH ou les mots-clés"] };
  }
  if (titleHits) { score += titleHits * 3; reasons.push(`${titleHits} mot(s)-clé(s) dans le titre`); }
  if (abstractHits) { score += Math.min(abstractHits, 10) * 0.5; reasons.push(`${abstractHits} occurrence(s) dans le résumé`); }
  if (meshHits) { score += meshHits * 2; reasons.push(`${meshHits} terme(s) MeSH`); }
  if (kwHits) { score += kwHits * 1.5; reasons.push(`${kwHits} mot(s)-clé(s) auteur`); }

  for (const type of record.publicationTypes) {
    for (const [re, bonus] of PUBTYPE_BONUS) {
      if (re.test(type)) { score += bonus; reasons.push(`type « ${type} »`); break; }
    }
    for (const [re, malus] of PUBTYPE_MALUS) {
      if (re.test(type)) { score += malus; reasons.push(`type pénalisé « ${type} »`); break; }
    }
  }

  if (record.abstract.length >= 1200) { score += 1; reasons.push("résumé détaillé"); }
  if (record.abstractSections.length >= 3) { score += 1; reasons.push("résumé structuré"); }

  const age = daysSince(record.entrezDate || record.pubDate, now);
  if (age !== null) {
    if (age <= 3) { score += 3; reasons.push("ajouté il y a moins de 3 jours"); }
    else if (age <= 14) { score += 2; reasons.push("ajouté il y a moins de 2 semaines"); }
    else if (age <= 60) { score += 1; reasons.push("ajouté il y a moins de 2 mois"); }
  }

  return { score: Math.round(score * 10) / 10, reasons };
}

/** Vérifie qu'une notice n'a pas déjà été traitée (PMID, DOI ou titre identique). */
export function isNovel(record, seen) {
  if (seen.pmids.has(record.pmid)) return false;
  if (record.doi && seen.dois.has(record.doi.toLowerCase())) return false;
  if (seen.titles.has(titleFingerprint(record.title))) return false;
  return true;
}

/**
 * Classe les candidats d'un sujet par pertinence décroissante.
 * @returns {{accepted: Array<{record, score, reasons}>, rejected: Array<{record, score, reasons}>}}
 *   `accepted` : nouveaux et au-dessus du score minimal, triés ; `rejected` : lus mais écartés
 *   (score ≤ HARD_REJECT = exclusion définitive, sinon rejet pour ce sujet seulement).
 */
export function rankCandidates(records, topic, seen, { minScore = 4, now = Date.now() } = {}) {
  const accepted = [];
  const rejected = [];
  for (const record of records) {
    if (!isNovel(record, seen)) continue;
    const { score, reasons } = scoreRecord(record, topic, { now });
    if (score < minScore) rejected.push({ record, score, reasons });
    else accepted.push({ record, score, reasons });
  }
  accepted.sort((a, b) => b.score - a.score || (b.record.entrezDate || "").localeCompare(a.record.entrezDate || ""));
  return { accepted, rejected };
}

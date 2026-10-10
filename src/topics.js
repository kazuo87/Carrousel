/**
 * Sujets couverts par le bot. Chaque sujet définit :
 *  - une requête PubMed (syntaxe E-utilities / PubMed),
 *  - des mots-clés pour le score de pertinence,
 *  - un thème visuel pour l'illustration générée.
 */
export const TOPICS = [
  {
    id: "pharmaceutique",
    label: { fr: "Pharmaceutique", en: "Pharmaceutical science", ar: "العلوم الصيدلانية" },
    query:
      '("pharmacokinetics"[tiab] OR "pharmacodynamics"[tiab] OR "drug delivery"[tiab] OR "drug formulation"[tiab] OR "nanoparticle"[tiab] OR "bioavailability"[tiab] OR "Pharmaceutical Preparations"[MeSH] OR "Drug Delivery Systems"[MeSH])',
    keywords: [
      "pharmacokinetic", "pharmacodynamic", "formulation", "drug delivery", "bioavailability",
      "nanoparticle", "excipient", "dissolution", "pharmaceutical", "dosage", "half-life", "clearance",
    ],
    theme: "capsule",
    hue: 200,
  },
  {
    id: "peptides",
    label: { fr: "Peptides thérapeutiques", en: "Therapeutic peptides", ar: "الببتيدات العلاجية" },
    query:
      '("peptide"[tiab] OR "peptides"[tiab] OR "cyclic peptide"[tiab] OR "GLP-1"[tiab] OR "semaglutide"[tiab] OR "tirzepatide"[tiab] OR "peptide therapeutics"[tiab] OR "Peptides"[MeSH])',
    keywords: [
      "peptide", "glp-1", "semaglutide", "tirzepatide", "cyclic", "amino acid", "agonist",
      "receptor", "incretin", "stapled", "macrocycle", "oligopeptide",
    ],
    theme: "peptide",
    hue: 160,
  },
  {
    id: "nouveaux-medicaments",
    label: { fr: "Nouveaux médicaments", en: "New drugs", ar: "الأدوية الجديدة" },
    query:
      '("new drug"[tiab] OR "novel drug"[tiab] OR "first-in-class"[tiab] OR "drug approval"[tiab] OR "FDA approval"[tiab] OR "EMA approval"[tiab] OR "drug candidate"[tiab] OR "phase 3"[tiab] OR "phase III"[tiab] OR "Drug Approval"[MeSH])',
    keywords: [
      "approval", "first-in-class", "novel", "phase 3", "phase iii", "phase 2", "efficacy", "safety",
      "candidate", "fda", "ema", "trial", "randomized", "placebo", "new drug",
    ],
    theme: "molecule",
    hue: 265,
  },
  {
    id: "biosimilaires",
    label: { fr: "Biosimilaires", en: "Biosimilars", ar: "الأدوية الحيوية المماثلة" },
    query: '("biosimilar"[tiab] OR "biosimilars"[tiab] OR "Biosimilar Pharmaceuticals"[MeSH])',
    keywords: [
      "biosimilar", "interchangeab", "reference product", "originator", "switching", "immunogenicity",
      "equivalence", "adalimumab", "infliximab", "trastuzumab", "rituximab", "bevacizumab", "insulin",
    ],
    theme: "antibody",
    hue: 20,
  },
  {
    id: "biologiques",
    label: { fr: "Biologiques & anticorps", en: "Biologics & antibodies", ar: "الأدوية البيولوجية والأجسام المضادة" },
    query:
      '("monoclonal antibody"[tiab] OR "monoclonal antibodies"[tiab] OR "antibody-drug conjugate"[tiab] OR "bispecific"[tiab] OR "Antibodies, Monoclonal"[MeSH] OR "Immunoconjugates"[MeSH])',
    keywords: [
      "antibody", "monoclonal", "bispecific", "conjugate", "adc", "biologic", "fc", "epitope",
      "checkpoint", "pd-1", "her2", "cd20", "immunotherapy",
    ],
    theme: "antibody",
    hue: 330,
  },
  {
    id: "essais-cliniques",
    label: { fr: "Essais cliniques", en: "Clinical trials", ar: "التجارب السريرية" },
    // Les champs [pt]/[sh]/[MeSH] sont attribués par la NLM après indexation : une branche texte
    // permet de repérer les essais fraîchement entrés dans PubMed.
    query:
      '((("randomized controlled trial"[pt] OR "clinical trial, phase ii"[pt] OR "clinical trial, phase iii"[pt]) AND ("drug therapy"[sh] OR "pharmacology"[sh] OR "Drug Therapy"[MeSH])) OR ("randomized"[tiab] AND ("placebo"[tiab] OR "double-blind"[tiab]) AND ("phase 2"[tiab] OR "phase 3"[tiab] OR "phase II"[tiab] OR "phase III"[tiab])))',
    keywords: [
      "randomized", "placebo", "double-blind", "endpoint", "hazard ratio", "efficacy", "adverse",
      "phase", "trial", "participants", "patients", "treatment",
    ],
    theme: "trial",
    hue: 45,
  },
  {
    id: "therapie-genique-arn",
    label: { fr: "Thérapie génique & ARN", en: "Gene & RNA therapeutics", ar: "العلاج الجيني وعلاجات الحمض النووي الريبي" },
    query:
      '("gene therapy"[tiab] OR "mRNA vaccine"[tiab] OR "siRNA"[tiab] OR "antisense oligonucleotide"[tiab] OR "CRISPR"[tiab] OR "AAV"[tiab] OR "Genetic Therapy"[MeSH] OR "Oligonucleotides, Antisense"[MeSH])',
    keywords: [
      "gene therapy", "mrna", "sirna", "antisense", "oligonucleotide", "crispr", "aav", "vector",
      "lipid nanoparticle", "editing", "transgene", "rna",
    ],
    theme: "helix",
    hue: 120,
  },
  {
    id: "antimicrobiens",
    label: { fr: "Anti-infectieux & résistances", en: "Antimicrobials & resistance", ar: "مضادات العدوى والمقاومة الميكروبية" },
    query:
      '("new antibiotic"[tiab] OR "novel antibiotic"[tiab] OR "antimicrobial resistance"[tiab] OR "antifungal"[tiab] OR "antiviral"[tiab] OR "Anti-Bacterial Agents"[MeSH] OR "Drug Resistance, Microbial"[MeSH])',
    keywords: [
      "antibiotic", "antimicrobial", "resistance", "antifungal", "antiviral", "inhibitory concentration", "pathogen",
      "bacteria", "gram-negative", "carbapenem", "infection", "susceptibility",
    ],
    theme: "cells",
    hue: 5,
  },
];

/** Filtres communs : résumé disponible, anglais, pas d'erratum / commentaire / lettre. */
export const COMMON_FILTER =
  'hasabstract[text] AND english[lang] NOT (comment[pt] OR editorial[pt] OR letter[pt] OR news[pt] OR "published erratum"[pt] OR "retraction of publication"[pt] OR "retracted publication"[pt])';

export function getTopics(ids = []) {
  if (!ids || ids.length === 0) return TOPICS;
  const unknown = ids.filter((id) => !TOPICS.some((t) => t.id === id));
  if (unknown.length) throw new Error(`Sujets inconnus dans TOPICS: ${unknown.join(", ")}`);
  return ids.map((id) => TOPICS.find((t) => t.id === id));
}

export function buildQuery(topic) {
  return `(${topic.query}) AND ${COMMON_FILTER}`;
}

/**
 * Générateur « extractif » : construit un article lisible uniquement à partir des métadonnées
 * et du résumé PubMed, sans modèle de langage. Utilisé comme solution de repli lorsque Claude
 * n'est pas configuré ou indisponible. Le corps du texte reste en anglais (langue du résumé) ;
 * seuls les intitulés et mentions sont traduits dans chaque langue demandée.
 */

export const LABELS = {
  fr: {
    context: "Contexte",
    methods: "Méthodes",
    results: "Résultats",
    conclusions: "Conclusions",
    findings: "Ce que montre l'étude",
    keyPoints: "Points clés",
    source: "Source",
    readMore: "Résumé original (anglais) publié dans",
    dekPrefix: "Étude publiée dans",
    disclaimer: "Article généré automatiquement à partir du résumé PubMed ; il ne constitue pas un avis médical.",
    imageAlt: "Illustration",
  },
  en: {
    context: "Background",
    methods: "Methods",
    results: "Results",
    conclusions: "Conclusions",
    findings: "What the study shows",
    keyPoints: "Key points",
    source: "Source",
    readMore: "Original abstract published in",
    dekPrefix: "Study published in",
    disclaimer: "Automatically generated from the PubMed abstract; this is not medical advice.",
    imageAlt: "Illustration",
  },
  ar: {
    context: "السياق",
    methods: "المنهجية",
    results: "النتائج",
    conclusions: "الخلاصة",
    findings: "ما تُظهره الدراسة",
    keyPoints: "النقاط الرئيسية",
    source: "المصدر",
    readMore: "الملخص الأصلي (بالإنجليزية) منشور في",
    dekPrefix: "دراسة منشورة في",
    disclaimer: "مقال مُولَّد آليًا من ملخص PubMed؛ لا يُعدّ نصيحة طبية.",
    imageAlt: "رسم توضيحي",
  },
};

const LABEL_MAP = [
  [/background|introduction|context|objective|aim|purpose|rationale/i, "context"],
  [/method|design|setting|participants|intervention|material/i, "methods"],
  [/result|finding|outcome|measurement/i, "results"],
  [/conclusion|interpretation|discussion|significance|implication/i, "conclusions"],
];

/** Découpe un texte en phrases (approximation robuste aux abréviations courantes). */
export function splitSentences(text) {
  return String(text ?? "")
    .replace(/\b(e\.g|i\.e|vs|et al|Fig|approx|ca|cf|Dr|Prof|No|St)\.\s/gi, (m) => m.replace(". ", "<dot> "))
    .split(/(?<=[.!?])\s+(?=[A-Z0-9("'])/)
    .map((s) => s.replace(/<dot>/g, ".").trim())
    .filter((s) => s.length >= 12);
}

function pickKeyPoints(sentences, max = 4) {
  const scored = sentences.map((s, i) => {
    let score = 0;
    if (/\d/.test(s)) score += 2;
    if (/%|\bp\s*[<=>]|\bCI\b|hazard ratio|odds ratio|\bvs\.?\b|significant/i.test(s)) score += 2;
    if (/conclu|suggest|demonstrat|show|indicat|support/i.test(s)) score += 1;
    if (s.length > 260) score -= 1;
    return { s, i, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map(({ s }) => s);
}

/** Version d'un article (titre, chapô, sections, points clés…) dans une langue donnée. */
function buildContent(record, topic, language) {
  const L = LABELS[language] ?? LABELS.fr;
  const sections = [];
  const structured = record.abstractSections.filter((s) => s.label);

  if (structured.length >= 2) {
    const grouped = new Map();
    for (const { label, text } of structured) {
      const key = LABEL_MAP.find(([re]) => re.test(label))?.[1] ?? "findings";
      grouped.set(key, [...(grouped.get(key) ?? []), text]);
    }
    for (const key of ["context", "methods", "results", "conclusions", "findings"]) {
      if (grouped.has(key)) sections.push({ heading: L[key], content: grouped.get(key).join(" ") });
    }
  } else {
    const sentences = splitSentences(record.abstract);
    const third = Math.max(1, Math.ceil(sentences.length / 3));
    const chunks = [sentences.slice(0, third), sentences.slice(third, 2 * third), sentences.slice(2 * third)];
    const headings = [L.context, L.findings, L.conclusions];
    chunks.forEach((chunk, i) => {
      if (chunk.length) sections.push({ heading: headings[i], content: chunk.join(" ") });
    });
  }

  const allSentences = splitSentences(record.abstractSections.map((s) => s.text).join(" ") || record.abstract);
  const keyPoints = pickKeyPoints(allSentences);
  const summary = allSentences.slice(0, 2).join(" ").slice(0, 400);
  const journal = record.journal || record.journalAbbrev || "PubMed";
  const year = (record.pubDate || "").slice(0, 4);
  const dek = `${L.dekPrefix} ${journal}${year ? ` (${year})` : ""}.`;

  const tags = [...new Set([...record.keywords, ...record.meshTerms.slice(0, 4)])]
    .map((t) => t.replace(/\s*\(.*?\)\s*/g, "").trim())
    .filter((t) => t && t.length <= 40)
    .slice(0, 6);

  sections.push({ heading: L.source, content: `${L.readMore} ${journal}. ${L.disclaimer}` });

  return {
    title: record.title,
    dek,
    summary,
    sections,
    keyPoints,
    tags: tags.length ? tags : [topic.label[language] ?? topic.id],
    imageAlt: `${L.imageAlt} — ${topic.label[language] ?? topic.id}`,
  };
}

/**
 * @param {object} record  Notice PubMed (voir pubmed.js)
 * @param {object} topic   Sujet (voir topics.js)
 * @param {{languages?: string[]}} options  Langues à produire (fr, en, ar)
 * @returns {{content: Record<string, object>, imagePrompt: string, generator: string, bodyLanguage: string}}
 */
export function generateExtractiveArticle(record, topic, { languages = ["fr"] } = {}) {
  const content = Object.fromEntries(languages.map((lang) => [lang, buildContent(record, topic, lang)]));
  return {
    content,
    imagePrompt: `Scientific illustration about ${topic.label.en.toLowerCase()}: ${record.title}`,
    generator: "extractive",
    // Le corps du texte est celui du résumé PubMed, en anglais.
    bodyLanguage: "en",
  };
}

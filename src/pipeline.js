/**
 * Un « tick » du bot : choisir un sujet, chercher des notices récentes sur PubMed, ne garder que
 * les nouvelles et pertinentes, rédiger l'article, générer l'illustration, enregistrer.
 */
import { buildQuery } from "./topics.js";
import { rankCandidates } from "./relevance.js";
import { createLogger } from "./logger.js";

const log = createLogger("pipeline");
const MAX_FETCH = 25;

export class Pipeline {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {import("./store.js").Store} deps.store
   * @param {import("./pubmed.js").PubMedClient} deps.pubmed
   * @param {{generate(record, topic): Promise<object>, usesClaude: boolean}} deps.articleGenerator
   * @param {{generate(ctx): Promise<object>}} deps.imageProvider
   * @param {object[]} deps.topics
   */
  constructor({ config, store, pubmed, articleGenerator, imageProvider, topics }) {
    this.config = config;
    this.store = store;
    this.pubmed = pubmed;
    this.articleGenerator = articleGenerator;
    this.imageProvider = imageProvider;
    this.topics = topics;
  }

  /** Ordre de parcours des sujets : rotation à partir du curseur persistant. */
  topicOrder() {
    const n = this.topics.length;
    const start = ((this.store.state.topicCursor ?? 0) % n + n) % n;
    return Array.from({ length: n }, (_, i) => this.topics[(start + i) % n]);
  }

  /** Cherche le meilleur candidat nouveau et pertinent pour un sujet (fenêtres de dates croissantes). */
  async findCandidate(topic) {
    const term = buildQuery(topic);
    const { retmax, windowsDays, minRelevance } = this.config.pubmed;
    for (const reldate of windowsDays) {
      const { ids, count } = await this.pubmed.search(term, { retmax, reldate });
      const fresh = ids.filter((id) => !this.store.seen.pmids.has(id));
      log.info(`[${topic.id}] ${reldate} j : ${ids.length} id(s) renvoyé(s) sur ${count}, ${fresh.length} jamais traité(s)`);
      if (!fresh.length) continue;
      const records = await this.pubmed.fetchArticles(fresh.slice(0, MAX_FETCH));
      const ranked = rankCandidates(records, topic, this.store.seen, { minScore: minRelevance });
      // Les notices lues mais rejetées sont mémorisées pour ne pas les re-télécharger.
      for (const record of records) {
        if (!ranked.some((r) => r.record.pmid === record.pmid)) this.store.seen.pmids.add(record.pmid);
      }
      if (ranked.length) {
        const best = ranked[0];
        log.info(`[${topic.id}] candidat PMID ${best.record.pmid} (score ${best.score}) : ${best.record.title.slice(0, 90)}`);
        return best;
      }
      log.info(`[${topic.id}] aucun candidat au-dessus du score minimal (${minRelevance}) dans cette fenêtre`);
    }
    return null;
  }

  async runOnce() {
    const startedAt = new Date().toISOString();
    const order = this.topicOrder();
    try {
      for (let i = 0; i < order.length; i++) {
        const topic = order[i];
        const candidate = await this.findCandidate(topic);
        if (!candidate) continue;
        const article = await this.createArticle(candidate, topic);
        const usedIndex = this.topics.indexOf(topic);
        await this.store.saveState({
          topicCursor: (usedIndex + 1) % this.topics.length,
          runs: (this.store.state.runs ?? 0) + 1,
          lastRunAt: startedAt,
          lastSuccessAt: new Date().toISOString(),
          lastError: null,
          lastResult: { status: "created", articleId: article.id, topic: topic.id, pmid: article.source.pmid },
        });
        await this.store.saveSeen();
        return { status: "created", article };
      }
      await this.store.saveSeen();
      await this.store.saveState({
        topicCursor: ((this.store.state.topicCursor ?? 0) + 1) % this.topics.length,
        runs: (this.store.state.runs ?? 0) + 1,
        lastRunAt: startedAt,
        lastError: null,
        lastResult: { status: "skipped", reason: "aucune notice nouvelle et pertinente" },
      });
      log.warn("Aucune notice nouvelle et pertinente trouvée pour ce tour");
      return { status: "skipped", reason: "aucune notice nouvelle et pertinente" };
    } catch (err) {
      log.error(`Échec du tour : ${err.message}`);
      await this.store.saveState({
        runs: (this.store.state.runs ?? 0) + 1,
        lastRunAt: startedAt,
        lastError: { at: new Date().toISOString(), message: err.message },
        lastResult: { status: "error", message: err.message },
      }).catch(() => {});
      return { status: "error", error: err };
    }
  }

  async createArticle({ record, score, reasons }, topic) {
    const id = `pmid-${record.pmid}`;
    const language = this.config.articleLanguage;
    const generated = await this.articleGenerator.generate(record, topic);
    const image = await this.imageProvider.generate({ id, record, topic, article: generated });
    const article = {
      id,
      createdAt: new Date().toISOString(),
      language,
      topic: { id: topic.id, label: topic.label[language] ?? topic.id, theme: topic.theme, hue: topic.hue },
      title: generated.title,
      dek: generated.dek,
      summary: generated.summary,
      sections: generated.sections,
      keyPoints: generated.keyPoints,
      tags: generated.tags,
      image,
      generator: generated.generator,
      relevance: { score, reasons },
      source: {
        pmid: record.pmid,
        doi: record.doi,
        pmcid: record.pmcid,
        url: record.url,
        doiUrl: record.doi ? `https://doi.org/${record.doi}` : "",
        title: record.title,
        journal: record.journal,
        journalAbbrev: record.journalAbbrev,
        pubDate: record.pubDate,
        entrezDate: record.entrezDate,
        authors: record.authors,
        publicationTypes: record.publicationTypes,
        meshTerms: record.meshTerms,
        keywords: record.keywords,
      },
    };
    await this.store.addArticle(article);
    log.info(`Article ${id} publié (${generated.generator}, image ${image.provider}) : ${article.title}`);
    return article;
  }
}

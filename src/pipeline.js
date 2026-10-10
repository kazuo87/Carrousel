/**
 * Un « tick » du bot : choisir un sujet, chercher des notices récentes sur PubMed, ne garder que
 * les nouvelles et pertinentes, rédiger l'article, générer l'illustration, enregistrer.
 */
import { buildQuery } from "./topics.js";
import { rankCandidates, HARD_REJECT } from "./relevance.js";
import { eutilsDate } from "./pubmed.js";
import { createLogger } from "./logger.js";

const log = createLogger("pipeline");
const MAX_FETCH = 25;

/** Clé de journée (AAAA-MM-JJ) d'un instant dans un fuseau horaire donné. */
export function dayKeyFor(timestamp, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}
/** Pages esearch parcourues au maximum par fenêtre de dates (retmax identifiants par page). */
const MAX_PAGES = 5;
const DAY_MS = 86_400_000;

export class Pipeline {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {import("./store.js").Store} deps.store
   * @param {import("./pubmed.js").PubMedClient} deps.pubmed
   * @param {{generate(record, topic): Promise<object>, usesClaude: boolean}} deps.articleGenerator
   * @param {{generate(ctx): Promise<object>}} deps.imageProvider
   * @param {object[]} deps.topics
   * @param {() => number} [deps.now]
   */
  constructor({ config, store, pubmed, articleGenerator, imageProvider, topics, now = Date.now }) {
    this.config = config;
    this.store = store;
    this.pubmed = pubmed;
    this.articleGenerator = articleGenerator;
    this.imageProvider = imageProvider;
    this.topics = topics;
    this.now = now;
  }

  /** Nombre d'articles déjà publiés aujourd'hui pour un sujet (journée du fuseau configuré). */
  countToday(topicId, today = dayKeyFor(this.now(), this.config.timeZone)) {
    const tz = this.config.timeZone;
    return this.store.articles.filter((a) => a.topic?.id === topicId && dayKeyFor(Date.parse(a.createdAt), tz) === today).length;
  }

  /** État du quota journalier (exposé par /api/status). */
  quota() {
    const perTopicPerDay = this.config.maxPerTopicPerDay;
    const today = dayKeyFor(this.now(), this.config.timeZone);
    const counts = Object.fromEntries(this.topics.map((t) => [t.id, this.countToday(t.id, today)]));
    const remainingToday = perTopicPerDay > 0
      ? Object.values(counts).reduce((sum, n) => sum + Math.max(0, perTopicPerDay - n), 0)
      : null;
    return { perTopicPerDay, timeZone: this.config.timeZone, date: today, counts, remainingToday };
  }

  /** Ordre de parcours des sujets : rotation à partir du curseur persistant. */
  topicOrder() {
    const n = this.topics.length;
    const start = ((this.store.state.topicCursor ?? 0) % n + n) % n;
    return Array.from({ length: n }, (_, i) => this.topics[(start + i) % n]);
  }

  /**
   * Fenêtres de dates disjointes et de plus en plus anciennes, construites à partir de
   * PUBMED_WINDOWS_DAYS (ex. 14,60,365 → [J-14, J], [J-60, J-14], [J-365, J-60]).
   */
  dateWindows() {
    const today = this.now();
    const windows = [];
    let newest = 0;
    for (const days of this.config.pubmed.windowsDays) {
      if (!(days > newest)) continue;
      windows.push({
        label: newest === 0 ? `${days} derniers jours` : `J-${days} à J-${newest}`,
        mindate: eutilsDate(new Date(today - days * DAY_MS)),
        maxdate: eutilsDate(new Date(today - newest * DAY_MS)),
      });
      newest = days;
    }
    return windows;
  }

  /** Cherche le meilleur candidat nouveau et pertinent pour un sujet. */
  async findCandidate(topic) {
    const term = buildQuery(topic);
    const { retmax, minRelevance } = this.config.pubmed;
    const isKnown = (id) => this.store.seen.pmids.has(id) || this.store.isRejected(topic.id, id);

    for (const window of this.dateWindows()) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const retstart = page * retmax;
        const { ids, count } = await this.pubmed.search(term, { retmax, retstart, mindate: window.mindate, maxdate: window.maxdate });
        const fresh = ids.filter((id) => !isKnown(id));
        log.info(`[${topic.id}] ${window.label}, page ${page + 1} : ${ids.length} id(s) sur ${count}, ${fresh.length} jamais traité(s)`);
        if (fresh.length) {
          const requested = fresh.slice(0, MAX_FETCH);
          const records = await this.pubmed.fetchArticles(requested);
          const { accepted, rejected } = rankCandidates(records, topic, this.store.seen, { minScore: minRelevance, now: this.now() });
          // Mémorise ce qui a été lu et écarté pour ne pas le re-télécharger : exclusion définitive
          // (erratum, résumé absent, identifiant sans notice) ou rejet pour ce sujet seulement.
          const returned = new Set(records.map((r) => r.pmid));
          for (const id of requested) if (!returned.has(id)) this.store.seen.pmids.add(id);
          for (const { record, score } of rejected) {
            if (score <= HARD_REJECT) this.store.seen.pmids.add(record.pmid);
            else this.store.markRejected(topic.id, record.pmid);
          }
          if (accepted.length) {
            const best = accepted[0];
            log.info(`[${topic.id}] candidat PMID ${best.record.pmid} (score ${best.score}) : ${best.record.title.slice(0, 90)}`);
            return best;
          }
          log.info(`[${topic.id}] ${records.length} notice(s) lue(s), aucune au-dessus du score minimal (${minRelevance})`);
        }
        if (ids.length < retmax || retstart + retmax >= count) break; // fenêtre épuisée
      }
    }
    return null;
  }

  async runOnce() {
    const startedAt = new Date(this.now()).toISOString();
    const order = this.topicOrder();
    const cap = this.config.maxPerTopicPerDay;
    let capped = 0;
    let topic = null;
    try {
      for (let i = 0; i < order.length; i++) {
        topic = order[i];
        if (cap > 0 && this.countToday(topic.id) >= cap) {
          capped += 1;
          continue; // quota du jour atteint pour ce sujet : aucune requête NCBI
        }
        const candidate = await this.findCandidate(topic);
        if (!candidate) continue;
        const article = await this.createArticle(candidate, topic);
        await this.store.saveSeen();
        await this.store.saveState({
          topicCursor: this.cursorAfter(topic),
          runs: (this.store.state.runs ?? 0) + 1,
          lastRunAt: startedAt,
          lastSuccessAt: new Date(this.now()).toISOString(),
          lastError: null,
          lastResult: { status: "created", articleId: article.id, topic: topic.id, pmid: article.source.pmid },
        });
        return { status: "created", article };
      }
      const reason = capped === order.length
        ? `quota journalier atteint (${cap} article(s) par sujet)`
        : "aucune notice nouvelle et pertinente";
      await this.store.saveSeen();
      await this.store.saveState({
        topicCursor: this.cursorAfter(order[0]),
        runs: (this.store.state.runs ?? 0) + 1,
        lastRunAt: startedAt,
        lastError: null,
        lastResult: { status: "skipped", reason },
      });
      if (capped === order.length) log.info(`Tour sans génération : ${reason}`);
      else log.warn(`Aucune notice nouvelle et pertinente trouvée pour ce tour${capped ? ` (${capped} sujet(s) au quota)` : ""}`);
      return { status: "skipped", reason };
    } catch (err) {
      log.error(`Échec du tour${topic ? ` (sujet ${topic.id})` : ""} : ${err.message}`);
      await this.store.saveSeen().catch(() => {});
      // Le curseur avance au-delà du sujet en échec pour qu'un sujet défaillant n'affame pas les autres.
      await this.store.saveState({
        topicCursor: topic ? this.cursorAfter(topic) : this.store.state.topicCursor,
        runs: (this.store.state.runs ?? 0) + 1,
        lastRunAt: startedAt,
        lastError: { at: new Date(this.now()).toISOString(), topic: topic?.id ?? null, message: err.message },
        lastResult: { status: "error", message: err.message },
      }).catch(() => {});
      return { status: "error", error: err };
    }
  }

  cursorAfter(topic) {
    return (this.topics.indexOf(topic) + 1) % this.topics.length;
  }

  async createArticle({ record, score, reasons }, topic) {
    const id = `pmid-${record.pmid}`;
    const { articleLanguage: primary, languages } = this.config;
    const generated = await this.articleGenerator.generate(record, topic);
    const main = generated.content[primary] ?? generated.content[Object.keys(generated.content)[0]];
    const image = await this.imageProvider.generate({
      id,
      record,
      topic,
      article: { imagePrompt: generated.imagePrompt, imageAlt: main.imageAlt },
    });
    const content = Object.fromEntries(
      Object.entries(generated.content).map(([lang, c]) => {
        const { imageAlt, ...rest } = c;
        return [lang, rest];
      }),
    );
    const alts = Object.fromEntries(Object.entries(generated.content).map(([lang, c]) => [lang, c.imageAlt]));
    const { imageAlt: _mainAlt, ...mainFields } = main;
    const article = {
      id,
      createdAt: new Date(this.now()).toISOString(),
      language: primary,
      languages: Object.keys(content),
      // Langue du corps du texte quand elle diffère des versions (générateur extractif : anglais).
      bodyLanguage: generated.bodyLanguage ?? null,
      topic: { id: topic.id, label: topic.label[primary] ?? topic.id, labels: topic.label, theme: topic.theme, hue: topic.hue },
      // Champs de premier niveau = version dans la langue principale (compatibilité).
      ...mainFields,
      content,
      image: { ...image, alts },
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

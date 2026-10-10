/**
 * Persistance JSON sur disque (articles, identifiants déjà traités, état du planificateur).
 * Les écritures sont atomiques (fichier temporaire puis renommage). Un fichier illisible (écriture
 * interrompue, disque plein) est mis de côté et le bot repart de l'état par défaut plutôt que de
 * refuser de démarrer.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { titleFingerprint } from "./relevance.js";
import { createLogger } from "./logger.js";

const log = createLogger("store");

/** Nombre maximal de PMID conservés dans l'index de nouveauté (les plus anciens sont oubliés). */
export const MAX_SEEN_PMIDS = 200_000;

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`Fichier ${file} illisible : ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const backup = `${file}.corrompu-${Date.now()}`;
    fs.renameSync(file, backup);
    log.error(`Fichier ${path.basename(file)} corrompu (${err.message}) : mis de côté dans ${path.basename(backup)}, reprise avec les valeurs par défaut`);
    return fallback;
  }
}

/** Complète les articles enregistrés par une version précédente (avant les versions par langue). */
export function migrateArticle(article) {
  if (!article || typeof article !== "object") return article;
  const migrated = { ...article };
  if (!Array.isArray(migrated.languages)) migrated.languages = migrated.language ? [migrated.language] : [];
  // Le générateur extractif a toujours produit un corps de texte en anglais (celui du résumé PubMed).
  if (migrated.bodyLanguage === undefined) migrated.bodyLanguage = migrated.generator === "extractive" ? "en" : null;
  return migrated;
}

export class Store {
  constructor({ dataDir, imagesDir, maxArticles = 500 }) {
    this.dataDir = dataDir;
    this.imagesDir = imagesDir ?? path.join(dataDir, "images");
    this.maxArticles = maxArticles;
    this.files = {
      articles: path.join(dataDir, "articles.json"),
      seen: path.join(dataDir, "seen.json"),
      state: path.join(dataDir, "state.json"),
    };
    this.listeners = new Set();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.imagesDir, { recursive: true });
    await this.cleanTempFiles();
    const articles = readJson(this.files.articles, []);
    this.articles = (Array.isArray(articles) ? articles : []).map(migrateArticle);
    const seenRaw = readJson(this.files.seen, {});
    this.seen = {
      pmids: new Set((seenRaw.pmids ?? []).map(String)),
      dois: new Set((seenRaw.dois ?? []).map((d) => String(d).toLowerCase())),
      titles: new Set(seenRaw.titles ?? []),
      // Rejets propres à un sujet : la notice reste candidate pour les autres sujets.
      rejected: new Map(Object.entries(seenRaw.rejected ?? {}).map(([topic, ids]) => [topic, new Set(ids.map(String))])),
    };
    // Les articles existants comptent toujours comme déjà vus.
    for (const a of this.articles) this.markSeen(a.source ?? a);
    this.pruneSeen();
    const state = readJson(this.files.state, {});
    this.state = { topicCursor: 0, runs: 0, lastRunAt: null, lastSuccessAt: null, lastError: null, lastResult: null, ...state };
    await this.removeOrphanImages();
    return this;
  }

  /** Supprime les fichiers temporaires laissés par une écriture interrompue. */
  async cleanTempFiles() {
    let entries = [];
    try { entries = await fsp.readdir(this.dataDir); } catch { return; }
    for (const name of entries) {
      if (name.endsWith(".tmp")) await fsp.unlink(path.join(this.dataDir, name)).catch(() => {});
    }
  }

  /** Supprime les illustrations qui ne correspondent plus à aucun article. */
  async removeOrphanImages() {
    const referenced = new Set(this.articles.map((a) => a.image?.file).filter(Boolean));
    let entries = [];
    try { entries = await fsp.readdir(this.imagesDir); } catch { return; }
    let removed = 0;
    for (const name of entries) {
      if (name.startsWith(".") || referenced.has(name)) continue;
      await fsp.unlink(path.join(this.imagesDir, name)).catch(() => {});
      removed += 1;
    }
    if (removed) log.info(`${removed} illustration(s) orpheline(s) supprimée(s)`);
  }

  markSeen(record) {
    if (record.pmid) this.seen.pmids.add(String(record.pmid));
    if (record.doi) this.seen.dois.add(String(record.doi).toLowerCase());
    if (record.title) this.seen.titles.add(titleFingerprint(record.title));
  }

  markRejected(topicId, pmid) {
    let set = this.seen.rejected.get(topicId);
    if (!set) {
      set = new Set();
      this.seen.rejected.set(topicId, set);
    }
    set.add(String(pmid));
  }

  isRejected(topicId, pmid) {
    return this.seen.rejected.get(topicId)?.has(String(pmid)) ?? false;
  }

  /** Borne l'index de nouveauté : les PMID les plus petits (les plus anciens) sont oubliés. */
  pruneSeen() {
    if (this.seen.pmids.size <= MAX_SEEN_PMIDS) return;
    const sorted = [...this.seen.pmids].sort((a, b) => Number(a) - Number(b));
    const drop = new Set(sorted.slice(0, sorted.length - MAX_SEEN_PMIDS));
    for (const id of drop) this.seen.pmids.delete(id);
    for (const set of this.seen.rejected.values()) for (const id of set) if (drop.has(id)) set.delete(id);
    log.info(`Index de nouveauté réduit à ${MAX_SEEN_PMIDS} PMID`);
  }

  /** Sérialise les écritures pour éviter les conflits entre ticks. */
  enqueue(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async saveSeen() {
    this.pruneSeen();
    return this.enqueue(() =>
      writeJsonAtomic(this.files.seen, {
        pmids: [...this.seen.pmids],
        dois: [...this.seen.dois],
        titles: [...this.seen.titles],
        rejected: Object.fromEntries([...this.seen.rejected].map(([topic, ids]) => [topic, [...ids]])),
      }),
    );
  }

  async saveState(patch = {}) {
    Object.assign(this.state, patch);
    return this.enqueue(() => writeJsonAtomic(this.files.state, this.state));
  }

  /**
   * Ajoute un article en tête et le persiste. L'index de nouveauté n'est mis à jour qu'en mémoire :
   * le pipeline l'enregistre une fois par tour (au redémarrage, les articles présents sont de toute
   * façon re-marqués comme vus).
   */
  async addArticle(article) {
    this.articles.unshift(article);
    const removed = this.articles.splice(this.maxArticles);
    this.markSeen(article.source);
    await this.enqueue(() => writeJsonAtomic(this.files.articles, this.articles));
    for (const old of removed) await this.removeImage(old);
    for (const listener of this.listeners) {
      try { listener(article); } catch { /* un écouteur défaillant ne doit pas bloquer */ }
    }
    return article;
  }

  async removeImage(article) {
    const file = article?.image?.file;
    if (!file) return;
    try { await fsp.unlink(path.join(this.imagesDir, file)); } catch { /* déjà supprimée */ }
  }

  listArticles({ limit = 50, offset = 0, topic } = {}) {
    let list = this.articles;
    if (topic) list = list.filter((a) => a.topic?.id === topic);
    return list.slice(offset, offset + limit);
  }

  getArticle(id) {
    return this.articles.find((a) => a.id === id) ?? null;
  }

  onArticle(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

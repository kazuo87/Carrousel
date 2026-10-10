/**
 * Persistance JSON sur disque (articles, identifiants déjà traités, état du planificateur).
 * Les écritures sont atomiques (fichier temporaire puis renommage).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { titleFingerprint } from "./relevance.js";

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`Fichier ${file} illisible : ${err.message}`);
  }
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
    this.articles = readJson(this.files.articles, []);
    const seenRaw = readJson(this.files.seen, { pmids: [], dois: [], titles: [] });
    this.seen = {
      pmids: new Set(seenRaw.pmids ?? []),
      dois: new Set((seenRaw.dois ?? []).map((d) => d.toLowerCase())),
      titles: new Set(seenRaw.titles ?? []),
    };
    // Les articles existants comptent toujours comme déjà vus.
    for (const a of this.articles) this.markSeen(a.source ?? a);
    this.state = readJson(this.files.state, { topicCursor: 0, runs: 0, lastRunAt: null, lastSuccessAt: null, lastError: null });
    return this;
  }

  markSeen(record) {
    if (record.pmid) this.seen.pmids.add(String(record.pmid));
    if (record.doi) this.seen.dois.add(String(record.doi).toLowerCase());
    if (record.title) this.seen.titles.add(titleFingerprint(record.title));
  }

  /** Sérialise les écritures pour éviter les conflits entre ticks. */
  enqueue(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async saveSeen() {
    return this.enqueue(() =>
      writeJsonAtomic(this.files.seen, {
        pmids: [...this.seen.pmids],
        dois: [...this.seen.dois],
        titles: [...this.seen.titles],
      }),
    );
  }

  async saveState(patch = {}) {
    Object.assign(this.state, patch);
    return this.enqueue(() => writeJsonAtomic(this.files.state, this.state));
  }

  async addArticle(article) {
    this.articles.unshift(article);
    const removed = this.articles.splice(this.maxArticles);
    this.markSeen(article.source);
    await this.enqueue(() => writeJsonAtomic(this.files.articles, this.articles));
    await this.saveSeen();
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

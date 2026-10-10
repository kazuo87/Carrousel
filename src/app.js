/** Assemblage des composants (injection des dépendances) à partir de la configuration. */
import { buildConfig, loadDotEnv } from "./config.js";
import { setLogLevel, createLogger } from "./logger.js";
import { getTopics } from "./topics.js";
import { PubMedClient } from "./pubmed.js";
import { Store } from "./store.js";
import { ArticleGenerator } from "./generate/article.js";
import { createImageProvider } from "./generate/image.js";
import { Pipeline } from "./pipeline.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";

const log = createLogger("app");

export async function createApp({ withScheduler = true } = {}) {
  loadDotEnv();
  const config = buildConfig();
  setLogLevel(config.logLevel);
  const topics = getTopics(config.topics);
  const store = await new Store({ dataDir: config.dataDir, imagesDir: config.imagesDir, maxArticles: config.maxArticles }).init();
  const pubmed = new PubMedClient({ ...config.pubmed });
  const articleGenerator = new ArticleGenerator({ claude: config.claude, language: config.articleLanguage });
  const imageProvider = createImageProvider(config, { language: config.articleLanguage });
  const pipeline = new Pipeline({ config, store, pubmed, articleGenerator, imageProvider, topics });
  const scheduler = withScheduler
    ? new Scheduler({ intervalMs: config.intervalMinutes * 60_000, task: () => pipeline.runOnce(), runOnStart: config.runOnStart })
    : null;
  const meta = {
    article: articleGenerator.usesClaude ? `claude:${config.claude.model}` : `extractive (${articleGenerator.disabledReason})`,
    image: config.image.provider === "openai" ? `openai:${config.image.openaiModel}` : "svg",
    pubmed: config.pubmed.baseUrl,
    topics: topics.map((t) => t.id),
  };
  const server = createServer({
    config,
    store,
    scheduler,
    runNow: () => (scheduler ? scheduler.tick() : pipeline.runOnce()),
    topics,
    meta,
  });
  log.info(`Générateur d'articles : ${meta.article} · images : ${meta.image} · sujets : ${meta.topics.join(", ")}`);
  if (!config.pubmed.email) log.warn("NCBI_EMAIL non défini : recommandé par NCBI pour identifier l'outil");
  return { config, topics, store, pubmed, articleGenerator, imageProvider, pipeline, scheduler, server, meta };
}

export function listen(app) {
  const { server, config } = app;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      log.info(`Carrousel disponible sur http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}/`);
      resolve(server);
    });
  });
}

export function installShutdown(app) {
  let closing = false;
  const close = (signal) => {
    if (closing) return;
    closing = true;
    log.info(`Signal ${signal} reçu : arrêt en cours`);
    const pending = app.scheduler ? app.scheduler.stop() : Promise.resolve();
    app.server.close();
    pending.then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGTERM", () => close("SIGTERM"));
}

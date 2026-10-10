/**
 * Configuration centralisée, lue depuis les variables d'environnement.
 * Un fichier .env (optionnel) est chargé au démarrage s'il existe.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");

/** Charge un fichier .env minimaliste (KEY=value, # commentaires) sans écraser l'environnement existant. */
export function loadDotEnv(file = path.join(ROOT_DIR, ".env")) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Une valeur vide (ligne « CLE= » de .env.example) ne définit rien : une ligne ajoutée plus bas,
    // par exemple avec `echo "CLE=valeur" >> .env`, prend alors effet.
    if (value === "") continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Variable ${name} invalide: "${raw}" n'est pas un nombre`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function list(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Construit l'objet de configuration (appelé une fois au démarrage, ou dans les tests). */
export function buildConfig(env = process.env) {
  const saved = process.env;
  process.env = env;
  try {
    const dataDir = path.resolve(ROOT_DIR, str("DATA_DIR", "data"));
    const cfg = {
      // Planification
      intervalMinutes: num("INTERVAL_MINUTES", 6),
      runOnStart: bool("RUN_ON_START", true),

      // Serveur HTTP
      port: num("PORT", 3000),
      host: str("HOST", "0.0.0.0"),
      adminToken: str("ADMIN_TOKEN", ""),

      // Contenu
      articleLanguage: str("ARTICLE_LANGUAGE", "fr"),
      topics: list("TOPICS", []), // vide = tous les sujets
      maxArticles: num("MAX_ARTICLES", 500),
      dataDir,
      imagesDir: path.join(dataDir, "images"),

      // PubMed / NCBI E-utilities
      pubmed: {
        baseUrl: str("PUBMED_BASE_URL", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"),
        apiKey: str("NCBI_API_KEY", ""),
        email: str("NCBI_EMAIL", ""),
        tool: str("NCBI_TOOL", "carrousel-sci-bot"),
        retmax: num("PUBMED_RETMAX", 40),
        // Fenêtres de recherche successives (jours) : on élargit si rien de nouveau.
        windowsDays: list("PUBMED_WINDOWS_DAYS", ["14", "60", "365"]).map(Number),
        timeoutMs: num("PUBMED_TIMEOUT_MS", 20000),
        minRelevance: num("MIN_RELEVANCE", 4),
      },

      // Génération d'article (Claude)
      claude: {
        enabled: bool("CLAUDE_ENABLED", true),
        model: str("CLAUDE_MODEL", "claude-opus-5-5"),
        effort: str("CLAUDE_EFFORT", "medium"),
        // Le raisonnement adaptatif consomme aussi des jetons de sortie : laisser de la marge.
        maxTokens: num("CLAUDE_MAX_TOKENS", 16000),
        fallbacks: str("CLAUDE_FALLBACKS", "default"), // "default" | "off"
        // délai × (tentatives + 1) doit rester inférieur à l'intervalle de génération.
        timeoutMs: num("CLAUDE_TIMEOUT_MS", 120000),
        maxRetries: num("CLAUDE_MAX_RETRIES", 1),
      },

      // Génération d'image
      image: {
        provider: str("IMAGE_PROVIDER", "svg"), // "svg" | "openai"
        openaiApiKey: str("OPENAI_API_KEY", ""),
        openaiModel: str("OPENAI_IMAGE_MODEL", "gpt-image-1"),
        openaiSize: str("OPENAI_IMAGE_SIZE", "1536x1024"),
        openaiBaseUrl: str("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        timeoutMs: num("IMAGE_TIMEOUT_MS", 120000),
      },

      logLevel: str("LOG_LEVEL", "info"),
    };
    if (cfg.intervalMinutes <= 0) throw new Error("INTERVAL_MINUTES doit être > 0");
    if (!["fr", "en"].includes(cfg.articleLanguage)) throw new Error("ARTICLE_LANGUAGE doit valoir fr ou en");
    if (!["svg", "openai"].includes(cfg.image.provider)) throw new Error("IMAGE_PROVIDER doit valoir svg ou openai");
    if (!["low", "medium", "high", "xhigh", "max"].includes(cfg.claude.effort)) {
      throw new Error("CLAUDE_EFFORT doit valoir low, medium, high, xhigh ou max");
    }
    if (!["default", "off"].includes(cfg.claude.fallbacks)) throw new Error("CLAUDE_FALLBACKS doit valoir default ou off");
    if (cfg.pubmed.windowsDays.some((d) => !(d > 0))) throw new Error("PUBMED_WINDOWS_DAYS doit contenir des nombres de jours positifs");
    return cfg;
  } finally {
    process.env = saved;
  }
}

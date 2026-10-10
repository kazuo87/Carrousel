/**
 * Génération de l'article avec Claude (SDK Anthropic, sortie structurée JSON validée par Zod),
 * dans toutes les langues demandées (français, anglais, arabe) en un seul appel pour que les
 * versions soient fidèles entre elles. En cas d'absence d'identifiants, d'erreur d'authentification,
 * de refus ou d'erreur réseau, on bascule sur le générateur extractif pour que le carrousel continue
 * de se remplir.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { createLogger } from "../logger.js";
import { generateExtractiveArticle } from "./extractive.js";

const log = createLogger("article");

const LANGUAGE_NAMES = {
  fr: "French (fr)",
  en: "English (en)",
  ar: "Modern Standard Arabic (ar)",
};

/** Contenu d'un article dans une langue. */
export const ContentSchema = z.object({
  title: z.string().min(10).max(180).describe("Journalistic headline, catchy but faithful to the study"),
  dek: z.string().min(20).max(280).describe("One-sentence subheading stating what is at stake"),
  summary: z.string().min(80).max(800).describe("Lead paragraph: 2 to 3 sentences with the essentials"),
  sections: z
    .array(
      z.object({
        heading: z.string().min(3).max(100),
        content: z.string().min(80).max(2400),
      }),
    )
    .min(3)
    .max(6)
    .describe("Body of the article: context, what was done, results, why it matters, limitations…"),
  keyPoints: z.array(z.string().min(10).max(240)).min(3).max(6).describe("Factual key points, one sentence each"),
  tags: z.array(z.string().min(2).max(40)).min(2).max(8),
  imageAlt: z.string().min(10).max(220).describe("Alternative text of the illustration, in this language"),
});

/** Schéma complet : une version par langue + prompt d'illustration commun (en anglais). */
export function buildArticleSchema(languages) {
  return z.object({
    content: z.object(Object.fromEntries(languages.map((lang) => [lang, ContentSchema]))),
    imagePrompt: z
      .string()
      .min(20)
      .max(600)
      .describe("English prompt for an abstract or schematic scientific illustration (no text, no identifiable person)"),
  });
}

/** Alias conservé pour les tests et les intégrations : schéma à trois langues. */
export const ArticleSchema = buildArticleSchema(["fr", "en", "ar"]);

export function buildSystemPrompt(languages) {
  const names = languages.map((l) => LANGUAGE_NAMES[l] ?? l).join(", ");
  return `You are a science journalist specialising in pharmacy, pharmacology and biotechnology, writing for healthcare professionals, researchers and students.

From the PubMed record provided (title, abstract, metadata), write a high-level explanatory article of about 400 to 650 words, and deliver it in each of the following languages: ${names}. Every language version must convey exactly the same facts, figures and caveats; write each version natively (no word-for-word translation artefacts).

Strict rules:
- Stay faithful to the abstract: never invent numbers, data, conclusions or authors. If information is missing, say so or leave it out.
- Explain the context (why this study), what was done, what was found, why it matters for practice or research, and the limitations (sample size, preclinical study, abstract only, etc.).
- Clearly distinguish preclinical (in vitro, animal) from clinical (human) results.
- Use international non-proprietary drug names. In the Arabic version, keep drug names, gene names and acronyms in Latin script, and write in Modern Standard Arabic.
- Precise, clear tone, no sensationalism and no individual medical advice.
- Key points are facts taken from the abstract, one sentence each.
- Section headings are written in the language of the version they belong to.
- The imagePrompt field is a single English prompt for an abstract or schematic scientific illustration related to the topic (molecule, peptide, antibody, cells, laboratory…), with no text in the image and no identifiable person.
- imageAlt is written in the language of its version.`;
}

function formatRecord(record, topic, languages) {
  const lines = [
    `Carousel topic: ${languages.map((l) => `${l}: ${topic.label[l] ?? topic.id}`).join(" | ")} (${topic.id})`,
    `PMID: ${record.pmid}`,
    record.doi ? `DOI: ${record.doi}` : null,
    `Title: ${record.title}`,
    `Journal: ${record.journal}${record.journalAbbrev ? ` (${record.journalAbbrev})` : ""}`,
    `Publication date: ${record.pubDate || "unknown"}`,
    `Authors: ${record.authors.slice(0, 8).join(", ")}${record.authors.length > 8 ? " et al." : ""}`,
    `Publication types: ${record.publicationTypes.join("; ") || "not specified"}`,
    record.meshTerms.length ? `MeSH terms: ${record.meshTerms.join("; ")}` : null,
    record.keywords.length ? `Keywords: ${record.keywords.join("; ")}` : null,
    "",
    "Abstract:",
    record.abstract,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/**
 * Normalise les erreurs du SDK en catégories exploitables.
 * @returns {"auth"|"ratelimit"|"api"|"network"|"unknown"}
 */
export function classifyError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "auth";
  if (err instanceof Anthropic.RateLimitError) return "ratelimit";
  if (err instanceof Anthropic.APIConnectionError) return "network";
  if (err instanceof Anthropic.APIError) return "api";
  // Le SDK signale l'absence d'identifiants (clé, jeton, profil `ant auth login`, fédération…)
  // par une erreur simple avant toute requête réseau.
  if (err instanceof Error && !(err instanceof Anthropic.APIError) && /authentication method|apiKey|authToken/i.test(err.message)) return "auth";
  return "unknown";
}

export class ArticleGenerator {
  /**
   * @param {object} options
   * @param {object} options.claude  Config Claude (voir config.js)
   * @param {string[]} [options.languages]  Langues à produire (fr, en, ar)
   * @param {Anthropic} [options.client]  Client injectable (tests)
   */
  constructor({ claude, languages = ["fr"], client } = {}) {
    this.config = { ...claude };
    this.languages = languages;
    this.schema = buildArticleSchema(languages);
    this.systemPrompt = buildSystemPrompt(languages);
    this.disabledReason = null;
    if (!claude?.enabled) {
      this.disabledReason = "CLAUDE_ENABLED=false";
      log.warn(`Claude désactivé (${this.disabledReason})`);
      this.client = null;
    } else {
      // Les identifiants (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, profil `ant auth login`,
      // fédération d'identité) sont résolus par le SDK à la première requête.
      this.client = client ?? new Anthropic({ timeout: claude.timeoutMs, maxRetries: claude.maxRetries ?? 1 });
      if (!client && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        log.info("ANTHROPIC_API_KEY absente : le SDK cherchera un profil ou une fédération d'identité ; sinon, génération extractive");
      }
    }
  }

  get usesClaude() {
    return Boolean(this.client);
  }

  async generate(record, topic) {
    if (!this.client) return generateExtractiveArticle(record, topic, { languages: this.languages });
    try {
      return await this.generateWithClaude(record, topic);
    } catch (err) {
      const kind = classifyError(err);
      if (kind === "auth") {
        this.disabledReason = /authentication method/i.test(err.message)
          ? "identifiants Anthropic absents (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ou profil `ant auth login`)"
          : `identifiants Anthropic refusés (${err.message.split("\n")[0].slice(0, 120)})`;
        this.client = null;
        log.error(`Claude désactivé pour la suite du processus : ${this.disabledReason} → génération extractive`);
      } else {
        log.warn(`Claude indisponible (${kind}) : ${err.message} → génération extractive`);
      }
      return generateExtractiveArticle(record, topic, { languages: this.languages });
    }
  }

  async generateWithClaude(record, topic) {
    const { model, effort, maxTokens, fallbacks } = this.config;
    const params = {
      model,
      max_tokens: maxTokens,
      // Pas de cache_control : le prompt système (~400 jetons) est en dessous du préfixe minimal
      // mis en cache et la cadence de 6 minutes dépasse la durée de vie par défaut du cache.
      system: this.systemPrompt,
      messages: [{ role: "user", content: formatRecord(record, topic, this.languages) }],
      output_config: { effort, format: zodOutputFormat(this.schema) },
    };
    // Repli serveur sur refus de politique : la requête est rejouée sur le modèle recommandé par Anthropic.
    if (fallbacks === "default") {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }

    let response;
    try {
      response = await this.client.beta.messages.create(params);
    } catch (err) {
      // Si la bêta de repli n'est pas acceptée (proxy, plateforme tierce…), on retente sans elle
      // une seule fois, puis on s'en souvient pour ne pas payer deux requêtes à chaque tour.
      if (params.fallbacks && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message)) {
        log.warn(`Repli serveur refusé (${err.message.slice(0, 160)}) : nouvelle tentative sans fallbacks, désactivé pour la suite`);
        delete params.betas;
        delete params.fallbacks;
        this.config.fallbacks = "off";
        response = await this.client.beta.messages.create(params);
      } else {
        throw err;
      }
    }

    if (response.stop_reason === "refusal") {
      const detail = response.stop_details?.explanation ?? response.stop_details?.category ?? "";
      throw new Error(`refus du modèle ${detail ? `(${detail})` : ""}`.trim());
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`réponse tronquée (max_tokens=${maxTokens})`);
    }
    // Un bloc « fallback » peut précéder le texte lorsque la requête a été rejouée sur un autre modèle.
    const fallbackBlock = response.content.find((block) => block.type === "fallback");
    if (fallbackBlock) log.warn(`Requête rejouée par le serveur : ${fallbackBlock.from?.model} → ${fallbackBlock.to?.model}`);
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("réponse JSON invalide");
    }
    const validated = this.schema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`réponse hors schéma : ${validated.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    }
    const usage = response.usage ?? {};
    log.info(
      `Article rédigé en ${this.languages.join("/")} par ${response.model ?? model} (entrée ${usage.input_tokens ?? "?"} / sortie ${usage.output_tokens ?? "?"} jetons)`,
    );
    return { ...validated.data, generator: `claude:${response.model ?? model}`, bodyLanguage: null };
  }
}

/**
 * Génération de l'article avec Claude (SDK Anthropic, sortie structurée JSON validée par Zod).
 * En cas d'absence de clé, d'erreur d'authentification, de refus ou d'erreur réseau, on bascule
 * sur le générateur extractif pour que le carrousel continue de se remplir.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { createLogger } from "../logger.js";
import { generateExtractiveArticle } from "./extractive.js";

const log = createLogger("article");

export const ArticleSchema = z.object({
  title: z.string().min(10).max(160).describe("Titre journalistique, accrocheur mais fidèle à l'étude"),
  dek: z.string().min(20).max(260).describe("Sous-titre d'une phrase qui précise l'enjeu"),
  summary: z.string().min(80).max(700).describe("Chapô : 2 à 3 phrases résumant l'essentiel"),
  sections: z
    .array(
      z.object({
        heading: z.string().min(3).max(90),
        content: z.string().min(80).max(2200),
      }),
    )
    .min(3)
    .max(6)
    .describe("Corps de l'article : contexte, résultats, portée, limites…"),
  keyPoints: z.array(z.string().min(10).max(220)).min(3).max(6).describe("Points clés factuels"),
  tags: z.array(z.string().min(2).max(40)).min(2).max(8),
  imagePrompt: z
    .string()
    .min(20)
    .max(600)
    .describe("Prompt en anglais pour une illustration scientifique (pas de texte, pas de personne identifiable)"),
  imageAlt: z.string().min(10).max(200).describe("Texte alternatif de l'illustration"),
});

const SYSTEM_PROMPTS = {
  fr: `Tu es journaliste scientifique spécialisé en pharmacie, pharmacologie et biotechnologies, écrivant pour un public de professionnels de santé, de chercheurs et d'étudiants francophones.

À partir de la notice PubMed fournie (titre, résumé, métadonnées), rédige un article de vulgarisation de haut niveau en français (environ 400 à 650 mots au total).

Règles impératives :
- Reste strictement fidèle au résumé : n'invente aucun chiffre, aucune donnée, aucune conclusion, aucun auteur. Si une information manque, dis-le ou n'en parle pas.
- Explique le contexte (pourquoi cette étude), ce qui a été fait, ce qui a été trouvé, pourquoi c'est important pour la pratique ou la recherche, et les limites (taille d'échantillon, étude préclinique, résumé seul, etc.).
- Distingue clairement résultats précliniques (in vitro, animal) et résultats cliniques (humains).
- Utilise les dénominations communes internationales des médicaments.
- Ton précis, clair, sans sensationnalisme ni conseil médical individuel.
- Les points clés sont des faits issus du résumé, chacun en une phrase.
- Le champ imagePrompt est un prompt en anglais pour générer une illustration scientifique abstraite ou schématique liée au sujet (molécule, peptide, anticorps, cellules, laboratoire…), sans texte dans l'image et sans personne identifiable.
- Le champ imageAlt est en français.`,
  en: `You are a science journalist specialising in pharmacy, pharmacology and biotechnology, writing for healthcare professionals, researchers and students.

From the PubMed record provided (title, abstract, metadata), write a high-level explanatory article in English (about 400 to 650 words in total).

Strict rules:
- Stay faithful to the abstract: never invent numbers, data, conclusions or authors. If information is missing, say so or leave it out.
- Explain the context (why this study), what was done, what was found, why it matters for practice or research, and the limitations (sample size, preclinical study, abstract only, etc.).
- Clearly distinguish preclinical (in vitro, animal) from clinical (human) results.
- Use international non-proprietary drug names.
- Precise, clear tone, no sensationalism and no individual medical advice.
- Key points are facts taken from the abstract, one sentence each.
- The imagePrompt field is an English prompt for an abstract or schematic scientific illustration related to the topic (molecule, peptide, antibody, cells, laboratory…), with no text in the image and no identifiable person.`,
};

function formatRecord(record, topic, language) {
  const lines = [
    `Sujet du carrousel / carousel topic: ${topic.label[language] ?? topic.id} (${topic.id})`,
    `PMID: ${record.pmid}`,
    record.doi ? `DOI: ${record.doi}` : null,
    `Titre / Title: ${record.title}`,
    `Revue / Journal: ${record.journal}${record.journalAbbrev ? ` (${record.journalAbbrev})` : ""}`,
    `Date de publication: ${record.pubDate || "inconnue"}`,
    `Auteurs: ${record.authors.slice(0, 8).join(", ")}${record.authors.length > 8 ? " et al." : ""}`,
    `Types de publication: ${record.publicationTypes.join("; ") || "non précisé"}`,
    record.meshTerms.length ? `Termes MeSH: ${record.meshTerms.join("; ")}` : null,
    record.keywords.length ? `Mots-clés: ${record.keywords.join("; ")}` : null,
    "",
    "Résumé / Abstract:",
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
   * @param {"fr"|"en"} options.language
   * @param {Anthropic} [options.client]  Client injectable (tests)
   */
  constructor({ claude, language = "fr", client } = {}) {
    this.config = { ...claude };
    this.language = language;
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
    if (!this.client) return generateExtractiveArticle(record, topic, { language: this.language });
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
      return generateExtractiveArticle(record, topic, { language: this.language });
    }
  }

  async generateWithClaude(record, topic) {
    const { model, effort, maxTokens, fallbacks } = this.config;
    const params = {
      model,
      max_tokens: maxTokens,
      // Pas de cache_control : le prompt système (~350 jetons) est en dessous du préfixe minimal
      // mis en cache et la cadence de 6 minutes dépasse la durée de vie par défaut du cache.
      system: SYSTEM_PROMPTS[this.language] ?? SYSTEM_PROMPTS.fr,
      messages: [{ role: "user", content: formatRecord(record, topic, this.language) }],
      output_config: { effort, format: zodOutputFormat(ArticleSchema) },
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
    const validated = ArticleSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`réponse hors schéma : ${validated.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    }
    const usage = response.usage ?? {};
    log.info(
      `Article rédigé par ${response.model ?? model} (entrée ${usage.input_tokens ?? "?"} / cache ${usage.cache_read_input_tokens ?? 0} / sortie ${usage.output_tokens ?? "?"} jetons)`,
    );
    return { ...validated.data, generator: `claude:${response.model ?? model}` };
  }
}

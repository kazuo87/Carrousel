import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { ArticleGenerator, ArticleSchema, classifyError } from "../src/generate/article.js";
import { TOPICS } from "../src/topics.js";
import { recordByPmid } from "./helpers.js";

const topic = TOPICS.find((t) => t.id === "biosimilaires");
const claude = { enabled: true, model: "claude-opus-5-5", effort: "medium", maxTokens: 8000, fallbacks: "default", timeoutMs: 1000 };

const validArticle = {
  title: "Un biosimilaire d'adalimumab confirme son équivalence après switch",
  dek: "Un essai randomisé de 52 semaines ne montre aucune perte d'efficacité ni signal de sécurité.",
  summary: "Chez 526 patients atteints de polyarthrite rhumatoïde, passer du produit de référence au biosimilaire ABP 501 a maintenu la réponse clinique. L'immunogénicité et la tolérance étaient comparables sur un an.",
  sections: [
    { heading: "Contexte", content: "Les biosimilaires d'adalimumab promettent des économies importantes, mais les conséquences cliniques d'un changement restaient mal documentées dans certaines populations." },
    { heading: "Résultats", content: "La variation du DAS28-CRP à 26 semaines était de -0,04 contre -0,02, dans la marge d'équivalence. La réponse ACR20 à 52 semaines était maintenue chez 84,1 % et 83,6 % des patients." },
    { heading: "Limites", content: "Il s'agit d'un seul changement, dans une population stable ; les résultats ne préjugent pas de changements multiples et reposent sur le résumé de l'étude uniquement." },
  ],
  keyPoints: ["526 adultes randomisés 1:1 pendant 52 semaines.", "Différence de DAS28-CRP de -0,02 (IC 90 % -0,15 à 0,11).", "Anticorps anti-médicament : 7,9 % contre 8,3 %."],
  tags: ["biosimilaire", "adalimumab", "polyarthrite rhumatoïde"],
  imagePrompt: "Schematic illustration of two identical monoclonal antibodies side by side, soft blue laboratory background, no text",
  imageAlt: "Deux anticorps monoclonaux identiques côte à côte",
};

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return responder(params, calls.length);
        },
      },
    },
  };
}

const textResponse = (obj, extra = {}) => ({
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(obj) }],
  usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 0 },
  ...extra,
});

test("ArticleSchema accepte un article complet", () => {
  assert.equal(ArticleSchema.safeParse(validArticle).success, true);
  assert.equal(ArticleSchema.safeParse({ ...validArticle, sections: [] }).success, false);
});

test("ArticleGenerator : sans identifiants → extractif", async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const gen = new ArticleGenerator({ claude, language: "fr" });
    assert.equal(gen.usesClaude, false);
    const a = await gen.generate(recordByPmid("40000001"), topic);
    assert.equal(a.generator, "extractive");
  } finally {
    if (saved.key) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
});

test("ArticleGenerator : requête structurée, cache et repli serveur", async () => {
  const client = fakeClient(() => textResponse(validArticle, { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } }));
  const gen = new ArticleGenerator({ claude, language: "fr", client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "claude:claude-opus-5-5");
  assert.equal(a.title, validArticle.title);
  const params = client.calls[0];
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.max_tokens, 8000);
  assert.equal(params.output_config.effort, "medium");
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.output_config.format.schema.required.includes("imagePrompt"), true);
  assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
  assert.match(params.system[0].text, /journaliste scientifique/);
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.fallbacks, "default");
  assert.equal(params.thinking, undefined, "pas de paramètre thinking explicite");
  assert.match(params.messages[0].content, /PMID: 40000001/);
  assert.match(params.messages[0].content, /BACKGROUND: Biosimilars of adalimumab/);
});

test("ArticleGenerator : CLAUDE_FALLBACKS=off → pas de bêta", async () => {
  const client = fakeClient(() => textResponse(validArticle));
  const gen = new ArticleGenerator({ claude: { ...claude, fallbacks: "off" }, language: "en", client });
  await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(client.calls[0].betas, undefined);
  assert.equal(client.calls[0].fallbacks, undefined);
  assert.match(client.calls[0].system[0].text, /science journalist/);
});

test("ArticleGenerator : bêta refusée (400) → nouvelle tentative sans fallbacks", async () => {
  const client = fakeClient((params, n) => {
    if (n === 1) throw new Anthropic.BadRequestError(400, { error: { message: "unknown beta" } }, "unknown beta", new Headers());
    return textResponse(validArticle);
  });
  const gen = new ArticleGenerator({ claude, language: "fr", client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "claude:claude-opus-5-5");
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].fallbacks, undefined);
});

test("ArticleGenerator : refus, troncature, JSON invalide, hors schéma → extractif", async () => {
  const cases = [
    { ...textResponse(validArticle), stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: "x" }, content: [] },
    { ...textResponse(validArticle), stop_reason: "max_tokens" },
    { ...textResponse(validArticle), content: [{ type: "text", text: "{pas du json" }] },
    textResponse({ ...validArticle, keyPoints: [] }),
  ];
  for (const response of cases) {
    const client = fakeClient(() => response);
    const gen = new ArticleGenerator({ claude, language: "fr", client });
    const a = await gen.generate(recordByPmid("40000001"), topic);
    assert.equal(a.generator, "extractive");
    assert.equal(gen.usesClaude, true, "Claude reste actif pour le tour suivant");
  }
});

test("ArticleGenerator : erreur d'authentification → Claude désactivé durablement", async () => {
  const client = fakeClient(() => { throw new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "invalid x-api-key", new Headers()); });
  const gen = new ArticleGenerator({ claude, language: "fr", client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "extractive");
  assert.equal(gen.usesClaude, false);
  assert.match(gen.disabledReason, /authentification/);
  await gen.generate(recordByPmid("40000002"), topic);
  assert.equal(client.calls.length, 1, "plus aucun appel après désactivation");
});

test("ArticleGenerator : limite de débit → extractif pour ce tour seulement", async () => {
  const client = fakeClient(() => { throw new Anthropic.RateLimitError(429, { error: { message: "slow down" } }, "slow down", new Headers()); });
  const gen = new ArticleGenerator({ claude, language: "fr", client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "extractive");
  assert.equal(gen.usesClaude, true);
});

test("classifyError", () => {
  assert.equal(classifyError(new Anthropic.AuthenticationError(401, {}, "x", new Headers())), "auth");
  assert.equal(classifyError(new Anthropic.RateLimitError(429, {}, "x", new Headers())), "ratelimit");
  assert.equal(classifyError(new Anthropic.APIConnectionError({ message: "net" })), "network");
  assert.equal(classifyError(new Anthropic.BadRequestError(400, {}, "x", new Headers())), "api");
  assert.equal(classifyError(new Error("boom")), "unknown");
});

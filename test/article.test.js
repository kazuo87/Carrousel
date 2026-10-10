import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { ArticleGenerator, ArticleSchema, buildArticleSchema, buildSystemPrompt, classifyError } from "../src/generate/article.js";
import { TOPICS } from "../src/topics.js";
import { recordByPmid } from "./helpers.js";

const topic = TOPICS.find((t) => t.id === "biosimilaires");
const claude = { enabled: true, model: "claude-opus-5-5", effort: "medium", maxTokens: 8000, fallbacks: "default", timeoutMs: 1000 };

const frContent = {
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
  imageAlt: "Deux anticorps monoclonaux identiques côte à côte",
};
const enContent = {
  ...frContent,
  title: "An adalimumab biosimilar confirms equivalence after switching",
  dek: "A 52-week randomised trial shows no loss of efficacy and no safety signal after a single switch.",
  summary: "In 526 patients with rheumatoid arthritis, switching from the reference product to the biosimilar ABP 501 maintained the clinical response. Immunogenicity and tolerability were comparable over one year.",
  sections: [
    { heading: "Background", content: "Adalimumab biosimilars promise substantial savings, but the clinical consequences of switching remained poorly documented in some populations of patients with rheumatoid arthritis." },
    { heading: "Results", content: "The change in DAS28-CRP at week 26 was -0.04 versus -0.02, within the equivalence margin. ACR20 response at week 52 was maintained in 84.1% and 83.6% of patients respectively." },
    { heading: "Limitations", content: "This was a single switch in a stable population; the results do not cover multiple switches and rely on the abstract of the study only, not on the full publication." },
  ],
  keyPoints: ["526 adults randomised 1:1 for 52 weeks.", "DAS28-CRP difference of -0.02 (90% CI -0.15 to 0.11).", "Anti-drug antibodies: 7.9% versus 8.3%."],
  tags: ["biosimilar", "adalimumab", "rheumatoid arthritis"],
  imageAlt: "Two identical monoclonal antibodies side by side",
};
const arContent = {
  ...frContent,
  title: "دواء حيوي مماثل لـ adalimumab يؤكد التكافؤ بعد التبديل",
  dek: "تجربة عشوائية لمدة 52 أسبوعًا لا تُظهر أي فقدان للفعالية ولا إشارة أمان بعد تبديل واحد.",
  summary: "لدى 526 مريضًا بالتهاب المفاصل الروماتويدي، حافظ التبديل من المنتج المرجعي إلى الدواء الحيوي المماثل ABP 501 على الاستجابة السريرية. وكانت المناعة والتحمل متماثلين على مدى عام.",
  sections: [
    { heading: "السياق", content: "تعد الأدوية الحيوية المماثلة لـ adalimumab بوفورات كبيرة، لكن العواقب السريرية للتبديل ظلت موثقة بشكل ضعيف لدى بعض فئات مرضى التهاب المفاصل الروماتويدي." },
    { heading: "النتائج", content: "كان التغير في DAS28-CRP في الأسبوع 26 هو -0.04 مقابل -0.02، ضمن هامش التكافؤ. وحافظ 84.1% و83.6% من المرضى على الاستجابة ACR20 في الأسبوع 52 على التوالي." },
    { heading: "القيود", content: "كان هذا تبديلًا واحدًا لدى فئة مستقرة من المرضى؛ ولا تغطي النتائج التبديلات المتعددة، وتعتمد على ملخص الدراسة فقط وليس على المنشور الكامل." },
  ],
  keyPoints: ["526 بالغًا وُزّعوا عشوائيًا 1:1 لمدة 52 أسبوعًا.", "فرق DAS28-CRP قدره -0.02 (فاصل ثقة 90%: من -0.15 إلى 0.11).", "الأجسام المضادة للدواء: 7.9% مقابل 8.3%."],
  tags: ["دواء حيوي مماثل", "adalimumab", "التهاب المفاصل الروماتويدي"],
  imageAlt: "جسمان مضادان وحيدا النسيلة متطابقان جنبًا إلى جنب",
};
const validArticle = {
  content: { fr: frContent, en: enContent, ar: arContent },
  imagePrompt: "Schematic illustration of two identical monoclonal antibodies side by side, soft blue laboratory background, no text",
};
const LANGS = ["fr", "en", "ar"];

/** Faux client : beta.messages.stream(params, options).finalMessage() comme le SDK. */
function fakeClient(responder) {
  const calls = [];
  const options = [];
  return {
    calls,
    options,
    beta: {
      messages: {
        stream: (params, opts) => {
          calls.push(params);
          options.push(opts);
          return { finalMessage: async () => responder(params, calls.length) };
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

test("ArticleSchema : une version par langue et un prompt d'illustration", () => {
  assert.equal(ArticleSchema.safeParse(validArticle).success, true);
  assert.equal(ArticleSchema.safeParse({ ...validArticle, content: { fr: frContent, en: enContent } }).success, false, "arabe manquant");
  assert.equal(ArticleSchema.safeParse({ ...validArticle, content: { ...validArticle.content, fr: { ...frContent, sections: [] } } }).success, false);
  const frOnly = buildArticleSchema(["fr"]);
  assert.equal(frOnly.safeParse({ content: { fr: frContent }, imagePrompt: validArticle.imagePrompt }).success, true);
  assert.match(buildSystemPrompt(LANGS), /French \(fr\), English \(en\), Modern Standard Arabic \(ar\)/);
  assert.match(buildSystemPrompt(["ar"]), /Modern Standard Arabic/);
});

test("ArticleGenerator : sans identifiants → extractif, Claude désactivé à la première requête", async () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, home: process.env.HOME };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.HOME = "/nonexistent-home-for-tests"; // aucun profil `ant auth login`
  try {
    const gen = new ArticleGenerator({ claude, languages: LANGS });
    assert.equal(gen.usesClaude, true, "le SDK résout les identifiants à la première requête");
    const a = await gen.generate(recordByPmid("40000001"), topic);
    assert.equal(a.generator, "extractive");
    assert.deepEqual(Object.keys(a.content), LANGS);
    assert.equal(gen.usesClaude, false);
    assert.match(gen.disabledReason, /identifiants/);
  } finally {
    if (saved.key) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    process.env.HOME = saved.home;
  }
});

test("ArticleGenerator : CLAUDE_ENABLED=false → extractif sans client", async () => {
  const gen = new ArticleGenerator({ claude: { ...claude, enabled: false }, languages: ["fr"] });
  assert.equal(gen.usesClaude, false);
  assert.equal((await gen.generate(recordByPmid("40000001"), topic)).generator, "extractive");
});

test("ArticleGenerator : requête structurée, cache et repli serveur", async () => {
  const client = fakeClient(() => textResponse(validArticle, { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } }));
  const gen = new ArticleGenerator({ claude, languages: LANGS, client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "claude:claude-opus-5-5");
  assert.equal(a.content.fr.title, frContent.title);
  assert.equal(a.content.ar.title, arContent.title);
  assert.equal(a.bodyLanguage, null);
  const params = client.calls[0];
  assert.ok(client.options[0].signal instanceof AbortSignal, "signal d'abandon global sur la requête diffusée");
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.max_tokens, 8000);
  assert.equal(params.output_config.effort, "medium");
  assert.equal(params.output_config.format.type, "json_schema");
  const schema = params.output_config.format.schema;
  assert.deepEqual(schema.required, ["content", "imagePrompt"]);
  assert.deepEqual(Object.keys(schema.properties.content.properties), LANGS);
  assert.match(params.system, /science journalist/);
  assert.match(params.system, /French \(fr\), English \(en\), Modern Standard Arabic \(ar\)/);
  assert.match(params.messages[0].content, /Carousel topic: fr: Biosimilaires \| en: Biosimilars \| ar: /);
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.fallbacks, "default");
  assert.equal(params.thinking, undefined, "pas de paramètre thinking explicite");
  assert.match(params.messages[0].content, /PMID: 40000001/);
  assert.match(params.messages[0].content, /BACKGROUND: Biosimilars of adalimumab/);
});

test("ArticleGenerator : CLAUDE_FALLBACKS=off → pas de bêta", async () => {
  const client = fakeClient(() => textResponse({ content: { en: enContent }, imagePrompt: validArticle.imagePrompt }));
  const gen = new ArticleGenerator({ claude: { ...claude, fallbacks: "off" }, languages: ["en"], client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.deepEqual(Object.keys(a.content), ["en"]);
  assert.equal(client.calls[0].betas, undefined);
  assert.equal(client.calls[0].fallbacks, undefined);
  assert.match(client.calls[0].system, /English \(en\)/);
  assert.doesNotMatch(client.calls[0].system, /French/);
});

test("ArticleGenerator : bêta refusée (400) → nouvelle tentative sans fallbacks, mémorisée", async () => {
  const client = fakeClient((params, n) => {
    if (n === 1) throw new Anthropic.BadRequestError(400, { error: { message: "unknown beta: server-side-fallback" } }, "unknown beta: server-side-fallback", new Headers());
    return textResponse(validArticle);
  });
  const gen = new ArticleGenerator({ claude, languages: LANGS, client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "claude:claude-opus-5-5");
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].fallbacks, undefined);
  await gen.generate(recordByPmid("40000002"), topic);
  assert.equal(client.calls.length, 3, "une seule requête au tour suivant");
  assert.equal(client.calls[2].fallbacks, undefined);
  assert.equal(claude.fallbacks, "default", "la configuration partagée n'est pas modifiée");
});

test("ArticleGenerator : un 400 sans rapport avec la bêta n'est pas rejoué", async () => {
  const client = fakeClient(() => { throw new Anthropic.BadRequestError(400, { error: { message: "max_tokens too large" } }, "max_tokens too large", new Headers()); });
  const gen = new ArticleGenerator({ claude, languages: LANGS, client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "extractive");
  assert.equal(client.calls.length, 1);
});

test("ArticleGenerator : bloc fallback avant le texte (requête rejouée côté serveur)", async () => {
  const client = fakeClient(() => ({
    ...textResponse(validArticle),
    model: "claude-opus-4-8",
    content: [{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } }, { type: "text", text: JSON.stringify(validArticle) }],
  }));
  const gen = new ArticleGenerator({ claude, languages: LANGS, client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "claude:claude-opus-4-8");
});

test("ArticleGenerator : refus, troncature, JSON invalide, hors schéma → extractif", async () => {
  const cases = [
    { ...textResponse(validArticle), stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: "x" }, content: [] },
    { ...textResponse(validArticle), stop_reason: "max_tokens" },
    { ...textResponse(validArticle), content: [{ type: "text", text: "{pas du json" }] },
    textResponse({ ...validArticle, content: { ...validArticle.content, en: { ...enContent, keyPoints: [] } } }),
  ];
  for (const response of cases) {
    const client = fakeClient(() => response);
    const gen = new ArticleGenerator({ claude, languages: LANGS, client });
    const a = await gen.generate(recordByPmid("40000001"), topic);
    assert.equal(a.generator, "extractive");
    assert.equal(gen.usesClaude, true, "Claude reste actif pour le tour suivant");
  }
});

test("ArticleGenerator : erreur d'authentification → Claude désactivé durablement", async () => {
  const client = fakeClient(() => { throw new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "invalid x-api-key", new Headers()); });
  const gen = new ArticleGenerator({ claude, languages: LANGS, client });
  const a = await gen.generate(recordByPmid("40000001"), topic);
  assert.equal(a.generator, "extractive");
  assert.equal(gen.usesClaude, false);
  assert.match(gen.disabledReason, /identifiants/);
  await gen.generate(recordByPmid("40000002"), topic);
  assert.equal(client.calls.length, 1, "plus aucun appel après désactivation");
});

test("ArticleGenerator : limite de débit → extractif pour ce tour seulement", async () => {
  const client = fakeClient(() => { throw new Anthropic.RateLimitError(429, { error: { message: "slow down" } }, "slow down", new Headers()); });
  const gen = new ArticleGenerator({ claude, languages: LANGS, client });
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
  assert.equal(classifyError(new Error("Could not resolve authentication method. Expected one of apiKey, authToken…")), "auth");
});

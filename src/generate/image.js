/**
 * Fournisseurs d'illustration :
 *  - "svg" (défaut) : illustration scientifique procédurale, sans dépendance externe ;
 *  - "openai" : image générée par l'API Images d'OpenAI (gpt-image-1) à partir du prompt
 *    rédigé par le générateur d'article, avec repli automatique sur le SVG en cas d'erreur.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logger.js";
import { renderScientificSvg } from "./svg-art.js";

const log = createLogger("image");

export class SvgImageProvider {
  constructor({ imagesDir, language = "fr" }) {
    this.imagesDir = imagesDir;
    this.language = language;
  }

  async generate({ id, record, topic, article }) {
    // Pas de légende dans l'image : l'interface superpose le libellé du sujet dans la langue affichée.
    const svg = renderScientificSvg({ seed: record.pmid, theme: topic.theme, hue: topic.hue });
    const file = `${id}.svg`;
    await fsp.writeFile(path.join(this.imagesDir, file), svg, "utf8");
    return { file, url: `/images/${file}`, alt: article.imageAlt, provider: "svg", prompt: null };
  }
}

export class OpenAiImageProvider {
  constructor({ imagesDir, language = "fr", apiKey, model = "gpt-image-1", size = "1536x1024", baseUrl = "https://api.openai.com/v1", timeoutMs = 120000, fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new Error("IMAGE_PROVIDER=openai nécessite OPENAI_API_KEY");
    this.fallback = new SvgImageProvider({ imagesDir, language });
    this.imagesDir = imagesDir;
    this.apiKey = apiKey;
    this.model = model;
    this.size = size;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async generate(ctx) {
    const { id, article } = ctx;
    const prompt = `${article.imagePrompt}. Clean scientific editorial illustration, high detail, no text, no watermark, no logos, no identifiable people.`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, prompt, n: 1, size: this.size, quality: "medium", output_format: "png" }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`API Images ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new Error("réponse sans b64_json");
      const file = `${id}.png`;
      await fsp.writeFile(path.join(this.imagesDir, file), Buffer.from(b64, "base64"));
      return { file, url: `/images/${file}`, alt: article.imageAlt, provider: `openai:${this.model}`, prompt };
    } catch (err) {
      log.warn(`Image OpenAI indisponible (${err.message}) → illustration SVG`);
      return this.fallback.generate(ctx);
    }
  }
}

export function createImageProvider(config, { language }) {
  const { provider, openaiApiKey, openaiModel, openaiSize, openaiBaseUrl, timeoutMs } = config.image;
  if (provider === "openai") {
    return new OpenAiImageProvider({
      imagesDir: config.imagesDir,
      language,
      apiKey: openaiApiKey,
      model: openaiModel,
      size: openaiSize,
      baseUrl: openaiBaseUrl,
      timeoutMs,
    });
  }
  return new SvgImageProvider({ imagesDir: config.imagesDir, language });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer, publicArticle } from "../src/server.js";
import { Store } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { getTopics } from "../src/topics.js";
import { buildConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

const sample = (n) => ({
  id: `pmid-${n}`, createdAt: new Date().toISOString(), language: "fr",
  topic: { id: "peptides", label: "Peptides thérapeutiques", theme: "peptide", hue: 160 },
  title: `Titre ${n}`, dek: "Sous-titre", summary: "Résumé", sections: [{ heading: "A", content: "B" }], keyPoints: ["k"], tags: ["t"],
  image: { file: `pmid-${n}.svg`, url: `/images/pmid-${n}.svg`, alt: "alt", provider: "svg", prompt: null },
  generator: "extractive", relevance: { score: 9, reasons: [] },
  source: { pmid: String(n), doi: "", title: "Source", journal: "J", authors: [], pubDate: "2026-10-01", url: `https://pubmed.ncbi.nlm.nih.gov/${n}/` },
});

async function startApp({ adminToken = "", withScheduler = true } = {}) {
  const { dir, images, cleanup } = await tmpDir();
  const config = buildConfig({ DATA_DIR: dir, ADMIN_TOKEN: adminToken, PORT: "0", HOST: "127.0.0.1" });
  const store = await new Store({ dataDir: config.dataDir, imagesDir: config.imagesDir }).init();
  fs.writeFileSync(path.join(images, "pmid-1.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await store.addArticle(sample(1));
  const runs = [];
  const runNow = async () => { runs.push(1); const a = sample(100 + runs.length); fs.writeFileSync(path.join(images, a.image.file), "<svg/>"); await store.addArticle(a); return { status: "created", article: a }; };
  const scheduler = withScheduler ? new Scheduler({ intervalMs: 60_000, task: runNow, runOnStart: false }) : null;
  const server = createServer({ config, store, scheduler, runNow, topics: getTopics([]), meta: { article: "extractive", image: "svg" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, runs, config, close: async () => { await new Promise((r) => server.close(r)); await cleanup(); } };
}

test("serveur : page, API, images et sécurité", async () => {
  const app = await startApp();
  try {
    const home = await fetch(`${app.base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /text\/html/);
    assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(await home.text(), /Carrousel scientifique/);

    for (const file of ["/app.js", "/styles.css"]) {
      const res = await fetch(`${app.base}${file}`);
      assert.equal(res.status, 200, file);
    }

    const list = await (await fetch(`${app.base}/api/articles?limit=5`)).json();
    assert.equal(list.total, 1);
    assert.equal(list.articles[0].id, "pmid-1");
    assert.equal(list.articles[0].image.file, undefined, "le chemin local n'est pas exposé");
    assert.equal(list.articles[0].image.url, "/images/pmid-1.svg");

    const one = await fetch(`${app.base}/api/articles/pmid-1`);
    assert.equal(one.status, 200);
    assert.equal((await fetch(`${app.base}/api/articles/nope`)).status, 404);
    assert.equal((await fetch(`${app.base}/api/articles?topic=biosimilaires`).then((r) => r.json())).total, 0);

    const topics = await (await fetch(`${app.base}/api/topics`)).json();
    assert.ok(topics.length >= 4 && topics[0].label);

    const status = await (await fetch(`${app.base}/api/status`)).json();
    assert.equal(status.articleCount, 1);
    assert.equal(status.intervalMinutes, 6);
    assert.equal(status.scheduler.running, false);
    assert.equal(status.generators.article, "extractive");

    const img = await fetch(`${app.base}/images/pmid-1.svg`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/svg+xml");
    assert.match(img.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal((await fetch(`${app.base}/images/missing.svg`)).status, 404);
    assert.equal((await fetch(`${app.base}/images/..%2Farticles.json`)).status, 400, "traversée de répertoire refusée");
    assert.equal((await fetch(`${app.base}/images/.hidden`)).status, 400);
    assert.equal((await fetch(`${app.base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${app.base}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${app.base}/api/articles`, { method: "DELETE" })).status, 405);
  } finally {
    await app.close();
  }
});

test("serveur : déclenchement manuel (loopback sans jeton, jeton requis sinon) et flux SSE", async () => {
  const app = await startApp();
  try {
    const events = [];
    const controller = new AbortController();
    const sse = await fetch(`${app.base}/api/events`, { signal: controller.signal });
    assert.match(sse.headers.get("content-type"), /text\/event-stream/);
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    const readEvent = (async () => {
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const m = buffer.match(/event: article\ndata: (.*)\n\n/);
        if (m) { events.push(JSON.parse(m[1])); break; }
      }
    })();

    const run = await fetch(`${app.base}/api/run`, { method: "POST" });
    assert.equal(run.status, 200);
    const body = await run.json();
    assert.equal(body.status, "created");
    assert.equal(body.article.id, "pmid-101");
    assert.equal(app.runs.length, 1);

    await Promise.race([readEvent, new Promise((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), 3000))]);
    assert.equal(events[0].id, "pmid-101");
    assert.equal(events[0].image.file, undefined);
    controller.abort();
  } finally {
    await app.close();
  }
});

test("serveur : ADMIN_TOKEN protège le déclenchement", async () => {
  const app = await startApp({ adminToken: "secret-token" });
  try {
    assert.equal((await fetch(`${app.base}/api/run`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${app.base}/api/run`, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401);
    const ok = await fetch(`${app.base}/api/run`, { method: "POST", headers: { Authorization: "Bearer secret-token" } });
    assert.equal(ok.status, 200);
    assert.equal(app.runs.length, 1);
  } finally {
    await app.close();
  }
});

test("publicArticle : masque le fichier local", () => {
  const a = publicArticle(sample(1));
  assert.deepEqual(a.image, { url: "/images/pmid-1.svg", alt: "alt", provider: "svg" });
  assert.equal(publicArticle({ ...sample(1), image: null }).image, null);
});

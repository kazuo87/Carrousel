/**
 * Serveur HTTP (node:http, sans framework) : carrousel statique, API JSON, flux SSE des
 * nouveaux articles, images générées, déclenchement manuel protégé.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ROOT_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("server");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

async function sendFile(res, file, { cache = "no-cache", extraHeaders = {} } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {import("./store.js").Store} deps.store
 * @param {import("./scheduler.js").Scheduler|null} deps.scheduler
 * @param {() => Promise<any>} [deps.runNow]
 * @param {object[]} deps.topics
 * @param {object} deps.meta  Informations sur les générateurs utilisés
 */
export function createServer({ config, store, scheduler, runNow, topics, meta }) {
  const clients = new Set();

  store.onArticle((article) => {
    const data = `event: article\ndata: ${JSON.stringify(publicArticle(article))}\n\n`;
    for (const res of clients) res.write(data);
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        if (pathname === "/" || pathname === "/index.html") {
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
          );
          if (await sendFile(res, path.join(PUBLIC_DIR, "index.html"))) return;
        }
        if (pathname === "/healthz") return sendJson(res, 200, { ok: true });

        if (pathname === "/api/articles") {
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 200);
          const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
          const topic = url.searchParams.get("topic") || undefined;
          const articles = store.listArticles({ limit, offset, topic }).map(publicArticle);
          const total = topic ? store.articles.filter((a) => a.topic?.id === topic).length : store.articles.length;
          return sendJson(res, 200, { articles, total, limit, offset });
        }
        const articleMatch = pathname.match(/^\/api\/articles\/([A-Za-z0-9._-]+)$/);
        if (articleMatch) {
          const article = store.getArticle(articleMatch[1]);
          return article ? sendJson(res, 200, publicArticle(article)) : sendJson(res, 404, { error: "article introuvable" });
        }
        if (pathname === "/api/topics") {
          return sendJson(
            res,
            200,
            topics.map((t) => ({ id: t.id, label: t.label[config.articleLanguage] ?? t.id, theme: t.theme, hue: t.hue })),
          );
        }
        if (pathname === "/api/status") {
          return sendJson(res, 200, {
            now: new Date().toISOString(),
            intervalMinutes: config.intervalMinutes,
            language: config.articleLanguage,
            articleCount: store.articles.length,
            seenCount: store.seen.pmids.size,
            scheduler: scheduler ? scheduler.status() : null,
            state: {
              runs: store.state.runs,
              lastRunAt: store.state.lastRunAt,
              lastSuccessAt: store.state.lastSuccessAt,
              lastError: store.state.lastError,
              lastResult: store.state.lastResult ?? null,
            },
            generators: meta,
          });
        }
        if (pathname === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.write("retry: 5000\n\n");
          clients.add(res);
          req.on("close", () => clients.delete(res));
          return;
        }
        const imageMatch = pathname.match(/^\/images\/([^/]+)$/);
        if (imageMatch) {
          const name = decodeURIComponent(imageMatch[1]);
          if (!SAFE_FILE.test(name)) return sendJson(res, 400, { error: "nom de fichier invalide" });
          const file = path.join(config.imagesDir, name);
          if (await sendFile(res, file, {
            cache: "public, max-age=86400, immutable",
            extraHeaders: { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" },
          })) return;
          return sendJson(res, 404, { error: "image introuvable" });
        }
        // Fichiers statiques du carrousel
        const rel = pathname.replace(/^\/+/, "");
        if (SAFE_FILE.test(rel)) {
          const file = path.join(PUBLIC_DIR, rel);
          if (file.startsWith(PUBLIC_DIR + path.sep) && (await sendFile(res, file))) return;
        }
        return sendJson(res, 404, { error: "introuvable" });
      }

      if (req.method === "POST" && pathname === "/api/run") {
        const header = req.headers.authorization ?? "";
        const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        const allowed = config.adminToken ? tokenMatches(provided, config.adminToken) : isLoopback(req);
        if (!allowed) return sendJson(res, 401, { error: "non autorisé (ADMIN_TOKEN requis)" });
        if (!runNow) return sendJson(res, 503, { error: "génération désactivée sur ce serveur" });
        const result = await runNow();
        if (result?.status === "error") return sendJson(res, 500, { status: "error", message: result.error?.message });
        return sendJson(res, 200, {
          status: result?.status ?? "done",
          reason: result?.reason,
          article: result?.article ? publicArticle(result.article) : undefined,
        });
      }

      return sendJson(res, 405, { error: "méthode non autorisée" });
    } catch (err) {
      log.error(`Erreur de requête ${req.method} ${pathname} : ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "erreur interne" });
      else res.end();
    }
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  });

  return server;
}

/** Représentation publique d'un article (sans chemin de fichier local). */
export function publicArticle(article) {
  const { image, ...rest } = article;
  return { ...rest, image: image ? { url: image.url, alt: image.alt, provider: image.provider } : null };
}

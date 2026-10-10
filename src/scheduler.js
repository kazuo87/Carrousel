/** Planificateur : exécute une tâche à intervalle fixe, sans chevauchement. */
import { createLogger } from "./logger.js";

const log = createLogger("scheduler");

export class Scheduler {
  /**
   * @param {object} options
   * @param {number} options.intervalMs
   * @param {() => Promise<any>} options.task
   * @param {boolean} [options.runOnStart]
   */
  constructor({ intervalMs, task, runOnStart = true }) {
    if (!(intervalMs > 0)) throw new Error("intervalMs doit être > 0");
    this.intervalMs = intervalMs;
    this.task = task;
    this.runOnStart = runOnStart;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastFinishedAt = null;
    this.nextRunAt = null;
    this.lastResult = null;
    this.runs = 0;
    this.skippedOverlaps = 0;
    this.current = null;
  }

  start() {
    if (this.timer) return;
    const schedule = () => {
      this.nextRunAt = Date.now() + this.intervalMs;
      this.timer = setTimeout(async () => {
        await this.tick();
        if (this.timer) schedule();
      }, this.intervalMs);
    };
    if (this.runOnStart) {
      // Premier tour immédiat, puis cadence régulière.
      this.nextRunAt = Date.now();
      this.timer = setTimeout(async () => {
        await this.tick();
        if (this.timer) schedule();
      }, 0);
    } else {
      schedule();
    }
    log.info(`Planificateur démarré : un article toutes les ${Math.round(this.intervalMs / 60000 * 10) / 10} minute(s)`);
  }

  /** Arrête la cadence ; la promesse renvoyée se résout quand le tour en cours (s'il y en a un) est terminé. */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    return this.current ?? Promise.resolve();
  }

  /** Exécute la tâche maintenant (ignorée si un tour est déjà en cours). */
  async tick() {
    if (this.running) {
      this.skippedOverlaps += 1;
      log.warn("Tour précédent toujours en cours : ce tour est ignoré");
      return { status: "busy" };
    }
    this.running = true;
    this.lastRunAt = Date.now();
    this.runs += 1;
    this.current = (async () => {
      try {
        const result = await this.task();
        this.lastResult = summarize(result);
        return result;
      } catch (err) {
        this.lastResult = { status: "error", message: err.message };
        log.error(`Tâche en erreur : ${err.message}`);
        return { status: "error", error: err };
      } finally {
        this.running = false;
        this.lastFinishedAt = Date.now();
        this.current = null;
      }
    })();
    return this.current;
  }

  status() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      runs: this.runs,
      skippedOverlaps: this.skippedOverlaps,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      lastFinishedAt: this.lastFinishedAt ? new Date(this.lastFinishedAt).toISOString() : null,
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      lastResult: this.lastResult,
    };
  }
}

function summarize(result) {
  if (!result || typeof result !== "object") return { status: "done" };
  if (result.status === "error") return { status: "error", message: result.error?.message ?? "erreur" };
  if (result.status === "created") {
    return { status: "created", articleId: result.article?.id, title: result.article?.title, topic: result.article?.topic?.id };
  }
  return { status: result.status, reason: result.reason };
}

/**
 * Planificateur : exécute une tâche sur une grille de temps fixe (toutes les N minutes, quelle que
 * soit la durée du tour), sans chevauchement. Un créneau manqué par un tour trop long est sauté,
 * pas rattrapé.
 */
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
    this.generation = 0;
    this.anchorAt = null;
    this.running = false;
    this.current = null;
    this.lastRunAt = null;
    this.lastFinishedAt = null;
    this.nextRunAt = null;
    this.lastResult = null;
    this.runs = 0;
    this.skippedOverlaps = 0;
    this.skippedSlots = 0;
  }

  start() {
    if (this.timer) return;
    const generation = ++this.generation;
    const now = Date.now();
    this.anchorAt = now;
    const arm = (at) => {
      this.nextRunAt = at;
      this.timer = setTimeout(async () => {
        if (generation !== this.generation) return;
        await this.tick();
        if (generation === this.generation && this.timer) arm(this.nextSlot());
      }, Math.max(0, at - Date.now()));
    };
    // Premier tour immédiat (optionnel), puis cadence régulière ancrée sur l'heure de démarrage.
    arm(this.runOnStart ? now : now + this.intervalMs);
    log.info(`Planificateur démarré : un article toutes les ${Math.round(this.intervalMs / 60000 * 10) / 10} minute(s)`);
  }

  /** Prochain créneau de la grille strictement dans le futur. */
  nextSlot() {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.anchorAt);
    const k = Math.floor(elapsed / this.intervalMs) + 1;
    const missed = k - 1 - Math.floor(Math.max(0, (this.nextRunAt ?? now) - this.anchorAt) / this.intervalMs);
    if (missed > 0) {
      this.skippedSlots += missed;
      log.warn(`${missed} créneau(x) sauté(s) : le tour précédent a duré plus que l'intervalle`);
    }
    return this.anchorAt + k * this.intervalMs;
  }

  /** Arrête la cadence ; la promesse renvoyée se résout quand le tour en cours (s'il y en a un) est terminé. */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    this.generation += 1;
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
      skippedSlots: this.skippedSlots,
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

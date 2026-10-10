/** Journalisation minimaliste avec niveaux et horodatage ISO. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let current = LEVELS.info;

export function setLogLevel(level) {
  current = LEVELS[level] ?? LEVELS.info;
}

function emit(level, scope, message, extra) {
  if (LEVELS[level] < current) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) fn(line, extra);
  else fn(line);
}

export function createLogger(scope) {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
  };
}

// src/utils/id.ts
import { randomBytes } from "crypto";
function generateId() {
  const timestamp = Date.now().toString(36);
  const randomPart = randomBytes(6).toString("base64url");
  return `${timestamp}${randomPart}`;
}

// src/utils/logger.ts
var LOG_LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var ConsoleLogger = class {
  prefix;
  minLevel;
  constructor(prefix = "[workflow]", level = "info") {
    this.prefix = prefix;
    this.minLevel = LOG_LEVEL_PRIORITY[level];
  }
  debug(message, ...args) {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.debug) {
      console.debug(`${this.prefix} [DEBUG]`, message, ...args);
    }
  }
  info(message, ...args) {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.info) {
      console.info(`${this.prefix} [INFO]`, message, ...args);
    }
  }
  warn(message, ...args) {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.warn) {
      console.warn(`${this.prefix} [WARN]`, message, ...args);
    }
  }
  error(message, ...args) {
    if (this.minLevel <= LOG_LEVEL_PRIORITY.error) {
      console.error(`${this.prefix} [ERROR]`, message, ...args);
    }
  }
};
var SilentLogger = class {
  debug() {
  }
  info() {
  }
  warn() {
  }
  error() {
  }
};
function sanitizeErrorForStorage(error) {
  const { stack: _stack, ...rest } = error;
  return rest;
}
function createScopedLogger(logger, runId, stepKey) {
  const prefix = stepKey ? `[run:${runId}][step:${stepKey}]` : `[run:${runId}]`;
  return {
    debug: (message, ...args) => logger.debug(`${prefix} ${message}`, ...args),
    info: (message, ...args) => logger.info(`${prefix} ${message}`, ...args),
    warn: (message, ...args) => logger.warn(`${prefix} ${message}`, ...args),
    error: (message, ...args) => logger.error(`${prefix} ${message}`, ...args)
  };
}

// src/utils/safe-json.ts
var corruptionCount = 0;
function safeJsonParse(json, fallback, ctx) {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) {
      corruptionCount++;
      ctx.logger?.warn(
        `[${ctx.component}] Corrupted JSON in database row, using fallback`,
        {
          rowId: ctx.rowId,
          column: ctx.column,
          length: typeof json === "string" ? json.length : void 0,
          type: typeof json,
          error: error.message,
          corruptionCount
        }
      );
      return fallback;
    }
    throw error;
  }
}
function safeParseField(value, fallback, ctx) {
  if (typeof value === "string") {
    return safeJsonParse(value, fallback, ctx);
  }
  return value;
}
function safeParseOptionalField(value, ctx) {
  if (!value) return void 0;
  if (typeof value === "string") {
    return safeJsonParse(value, void 0, ctx);
  }
  return value;
}

// src/utils/postgres-deps.ts
var cached;
var loadingPromise;
async function loadPostgresDeps() {
  if (cached) return cached;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    let Kysely;
    let PostgresDialect;
    let sql;
    let pgModule;
    try {
      const kyselyMod = await import("kysely");
      Kysely = kyselyMod.Kysely;
      PostgresDialect = kyselyMod.PostgresDialect;
      sql = kyselyMod.sql;
    } catch {
      throw new Error(
        'PostgreSQL support requires the "kysely" package. Install it with: npm install kysely'
      );
    }
    try {
      const pg = await import("pg");
      pgModule = pg.default ?? pg;
    } catch {
      throw new Error(
        'PostgreSQL support requires the "pg" package. Install it with: npm install pg'
      );
    }
    cached = { Kysely, PostgresDialect, sql, pgModule };
    return cached;
  })();
  return loadingPromise;
}
function requirePostgresDeps() {
  if (!cached) {
    throw new Error(
      "PostgreSQL dependencies have not been loaded yet. Call loadPostgresDeps() (or PostgresStorageAdapter.initialize()) first."
    );
  }
  return cached;
}

export {
  generateId,
  ConsoleLogger,
  SilentLogger,
  sanitizeErrorForStorage,
  createScopedLogger,
  safeJsonParse,
  safeParseField,
  safeParseOptionalField,
  loadPostgresDeps,
  requirePostgresDeps
};
//# sourceMappingURL=chunk-JPXPB7U5.js.map
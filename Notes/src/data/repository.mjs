import { getRuntimeKey } from "hono/adapter";
import { createD1Repository } from "./d1-repository.mjs";
import { createSqliteRepository } from "./sqlite-repository.mjs";

export function createRepository(options = {}) {
  const runtime = options.runtime || getRuntimeKey();

  if (runtime === "workerd") {
    if (!options.env?.DB && !options.db) {
      throw new Error("Cloudflare runtime requires a D1 binding named DB.");
    }
    return createD1Repository({ db: options.db || options.env.DB });
  }

  if (runtime === "node") {
    return createSqliteRepository({ dbPath: options.dbPath });
  }

  throw new Error(`Unsupported runtime for data repository: ${runtime}`);
}

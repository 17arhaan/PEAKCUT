import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

// ponytail: node-postgres locally; neon-http swap lands with the Neon task.

type Db = NodePgDatabase<typeof schema>;

let instance: Db | undefined;

// Lazy Pool: `import "@/lib/env"` runs at build time (app/layout.tsx boot
// check), and anything that imports this module inherits that. The Pool/
// drizzle instance is only constructed on first property access via the
// Proxy below, not at module import — so `npm run build`'s static
// generation never opens a socket even if a page ends up importing `db`.
function getDb(): Db {
  if (!instance) {
    instance = drizzle(new Pool({ connectionString: env.DATABASE_URL }), { schema });
  }
  return instance;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});

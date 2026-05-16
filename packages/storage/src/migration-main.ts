import { runDbMigrations } from "./db-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run pi runtime DB migrations.");
}
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is required to run pi runtime DB migrations.");
}

const result = await runDbMigrations({ databaseUrl, redisUrl });
console.log(JSON.stringify({ event: "pi_agent_db_migration_completed", ...result }));

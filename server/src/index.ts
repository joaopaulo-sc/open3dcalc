import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { listUsers } from "./users.ts";

const config = loadConfig();
const db = openDb(config.dataDir);
const app = await buildApp({ db, config, logger: true });

if (listUsers(db).length === 0) {
  app.log.warn("Nenhum usuário cadastrado. Crie um com: npm run users -- add <usuario> --admin");
}

// Limpeza diária de sessões vencidas.
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now()), 86_400_000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });

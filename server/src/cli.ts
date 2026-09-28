/**
 * Gestão de usuários pela linha de comando (dentro do container):
 *
 *   docker compose exec calc npm run users -- list
 *   docker compose exec calc npm run users -- add joao --name "João Paulo" --admin
 *   docker compose exec calc npm run users -- passwd joao
 *   docker compose exec calc npm run users -- disable maria
 *   docker compose exec calc npm run users -- enable maria
 *
 * A senha é pedida no terminal (sem eco) ou lida de CALC_PASSWORD.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createUser, getUserByUsername, listUsers, setDisabled, setPassword } from "./users.ts";

async function askPassword(prompt: string): Promise<string> {
  if (process.env.CALC_PASSWORD) return process.env.CALC_PASSWORD;
  if (!process.stdin.isTTY) throw new Error("Sem TTY: defina CALC_PASSWORD ou use `docker compose exec -it`.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Esconde o que é digitado.
  const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  rlAny._writeToOutput = (s: string) => {
    if (!muted) rlAny.output.write(s);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
    muted = true;
  });
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function askNewPassword(): Promise<string> {
  const first = await askPassword("Nova senha: ");
  if (process.env.CALC_PASSWORD) return first;
  const second = await askPassword("Repita a senha: ");
  if (first !== second) throw new Error("As senhas não conferem.");
  return first;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      admin: { type: "boolean", default: false },
    },
  });
  const [command, username] = positionals;
  const db = openDb(loadConfig().dataDir);

  const need = () => {
    if (!username) throw new Error(`Uso: users ${command} <usuario>`);
    const user = getUserByUsername(db, username);
    if (!user) throw new Error(`Usuário não encontrado: ${username}`);
    return user;
  };

  switch (command) {
    case "list": {
      const users = listUsers(db);
      if (users.length === 0) console.log("(nenhum usuário)");
      for (const u of users) {
        const flags = [u.isAdmin && "admin", u.disabled && "desativado"].filter(Boolean).join(", ");
        console.log(`${u.id}\t${u.username}\t${u.displayName}${flags ? `\t[${flags}]` : ""}`);
      }
      break;
    }
    case "add": {
      if (!username) throw new Error("Uso: users add <usuario> [--name \"Nome\"] [--admin]");
      const password = await askNewPassword();
      const user = await createUser(db, {
        username,
        displayName: values.name,
        password,
        isAdmin: values.admin,
      });
      console.log(`Criado: ${user.username} (id ${user.id})`);
      break;
    }
    case "passwd": {
      const user = need();
      await setPassword(db, user.id, await askNewPassword());
      console.log(`Senha de ${user.username} alterada; sessões encerradas.`);
      break;
    }
    case "disable":
    case "enable": {
      const user = need();
      setDisabled(db, user.id, command === "disable");
      console.log(`${user.username}: ${command === "disable" ? "desativado" : "reativado"}.`);
      break;
    }
    default:
      console.log("Comandos: list | add <usuario> [--name N] [--admin] | passwd <u> | disable <u> | enable <u>");
      process.exitCode = command ? 1 : 0;
  }
  db.close();
}

main().catch((error: Error) => {
  console.error(`Erro: ${error.message}`);
  process.exit(1);
});

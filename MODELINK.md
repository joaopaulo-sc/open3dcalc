# Fork ModelInk3D do Open3DCalc

Fork de [ils15/open3dcalc](https://github.com/ils15/open3dcalc) rodando como app web
multiusuário em `calc.modelink3d.link`, na mesma VM Oracle (AMD, 2 vCPU, 1 GB RAM)
que já roda o modelink3d-app (landing + vitrine continuam lá, intocados).

Branch: `feat/modelink-server`. Rascunho anterior (upload direto com chave no bundle)
guardado em `git stash list` → "rascunho upload gdrive".

## Objetivos

1. Mesmos dados em qualquer computador (hoje tudo fica no `localStorage`).
2. Login com usuário e senha — 3 usuários.
3. Arquivos de projeto (.3mf, .stl, .step, .gcode…) guardados no Google Drive,
   não na VM.
4. Identidade visual ModelInk3D.
5. Diff pequeno e isolado no front, para continuar puxando updates do upstream.

## Arquitetura

```
calc.modelink3d.link ─ Cloudflare (Full) ─ Traefik (modelink_net)
                                              │
                                   calc  (1 container Node 24, ~60 MB RAM)
                                   ├─ /login, /api/auth/*   sessão por cookie httpOnly
                                   ├─ /*                    build web do open3dcalc (só logado)
                                   ├─ /api/kv               sync chave→valor versionado (SQLite)
                                   ├─ /api/files/*          sessão de upload resumable + download proxy
                                   └─ backup diário do SQLite → Drive
                                              │
navegador ── PUT direto (resumable) ──▶ Google Drive   (upload não passa pela VM/Cloudflare)
```

### Sincronização

- Todo store do app já passa por `src/shared/lib/manifestStorage.ts` (ponto único de
  escrita). Um hook ali avisa o módulo de sync (`src/platform/web/sync/`), que só
  existe no build web.
- Boot: `GET /api/kv` → grava no `localStorage` → só então renderiza o React
  (mesma estratégia do `persistence-bridge` do desktop).
- Escrita: debounce por chave → `PUT /api/kv/:key` com `baseVersion`.
- Conflito (409, outro usuário gravou antes): merge 3-way (base = último valor
  sincronizado). Listas de objetos com `id` são mescladas item a item, respeitando
  exclusões. Depois reidrata o store.
- Pull em foco da aba + a cada 30 s.

### Escopo das chaves

| Escopo | Chaves |
|--------|--------|
| **Compartilhado** (a farm) | history_v2, customers_v1, quotes_v1, catalog_v1, filaments, color_palette_v1, products, dashboard_v1, dashboard_goal |
| **Por usuário** | settings_v2 (rascunho do cálculo em andamento), theme, sections, layout_v1, consent_v1, tutorial_v1, onboarded, quickstart_dismissed, share_prefs_v1, model_comparison, marketplace_comparison_v1, i18nextLng |
| **Só local** (não sincroniza) | erasure_*, migration_done_v2, chaves de staging/diagnóstico |

O servidor aplica essa lista; chave fora dela → 400.

### Google Drive

- Conta Google única da ModelInk3D, OAuth client próprio, escopo `drive.file`
  (o app só enxerga o que ele mesmo criou). Refresh token em secret.
- **Service account não serve**: não tem cota no "Meu Drive" de conta @gmail.com.
- O app OAuth precisa estar **"In production"** no Google Cloud (em "Testing" o
  refresh token expira em 7 dias).
- Upload: o servidor abre uma sessão resumable (com `Origin` do app); o navegador
  envia o arquivo direto ao Google. Isso evita o limite de 100 MB da Cloudflare e o
  1 GB de RAM.
- Download: `GET /api/files/:id` faz stream do Drive (os 3 usuários não precisam
  ter acesso ao Drive).

### Segurança

- Senhas com scrypt (`node:crypto`); sessão = token aleatório, guardado como hash.
- Cookie `HttpOnly; Secure; SameSite=Lax`; mutações exigem header `X-Calc` (CSRF).
- Rate limit no login.
- Nenhuma chave de API no bundle do front.

### Deploy (1 GB RAM)

- **Não buildar na VM** (Vite + three.js estoura 1 GB). A imagem é gerada no GitHub
  Actions → GHCR (amd64); a VM só faz `docker compose pull && up -d`.
- Compose próprio (`deploy/docker-compose.yml`) entra na rede externa `modelink_net`
  do Traefik existente. TLS igual ao resto: Cloudflare Full, `tls=true` sem ACME.
- Recomendado: swapfile de 2 GB na VM.

## Fases

| # | Entrega | Status |
|---|---------|--------|
| 1 | `server/`: login, sessões, usuários (CLI), KV versionado, serve estáticos | ✅ |
| 2 | Front: sync web (boot, push, merge, pull), tela de login, logout/usuário no menu, PWA sem cachear `/login` e `/api` | ✅ |
| 3 | Drive: script de autorização OAuth, upload resumable + download proxy, campo de arquivo em Produtos/Orçamentos, backup do SQLite | — |
| 4 | Marca: logo, paleta grafite + ciano, nome/ícones do PWA | — |
| 5 | Deploy: Dockerfile multi-stage, GH Actions → GHCR, compose, DNS `calc` na Cloudflare, runbook | — |

## Registro

- 2026-09-28: diagnóstico + plano. Decisões: manter landing/vitrine no modelink3d-app;
  subdomínio `calc.`; 3 usuários com dados compartilhados; rascunho anterior no stash.
- 2026-09-28: Fase 1 feita. `server/` roda em Node 24 com type-stripping (sem build),
  `node:sqlite` (sem módulo nativo), Fastify. 13 testes (`npm test` dentro de
  `node:24-alpine`), ~65 MB RSS. Usuários via `npm run users -- add|passwd|list|disable`.
- 2026-09-28: Fase 2 feita. `src/platform/web/sync/` (keys, api, merge, engine, rehydrate,
  SessionPanel) + gancho `setStorageWriteListener` em `manifestStorage.ts`. Ativado só com
  `VITE_CALC_SERVER=1` no build (sem a flag, comportamento do upstream). Fixes no caminho:
  migração legada apagava `open3dcalc_products` (formato novo) em todo boot com histórico
  vazio; SW com fallback `index.html` inexistente no precache. Regras que protegem dados:
  só sobe chave gravada via manifestStorage (limpar localStorage nunca vira exclusão no
  servidor); logout deixa marcador `calc_sync_user=logged-out`. E2E (Chrome headless):
  login, sync entre 2 usuários sem reload, conflito simultâneo mesclado, logout sem vazar
  dados. Testes do fork rodam em `node:22-slim` com volume `o3c_node_modules`.
- Pendências conhecidas p/ Fase 4: banner de privacidade diz "dados só no navegador";
  `favicon.png` referenciado não existe (upstream).
- 2026-09-28: **Deploy feito** (antes das fases 3/4) em https://calc.modelink3d.link.
  VM: swap 2 GB em `/swapfile` (fstab) + `vm.swappiness=10` (`/etc/sysctl.d/99-swappiness.conf`).
  Compose em `~/modelink-calc/` na VM; volume `modelink_calc_data`; container ~55 MB.
  Traefik só roteia depois do healthcheck ficar `healthy` (~30 s de 404 a cada deploy).
  Fase 5 parcial: falta GH Actions → GHCR (hoje: `docker save | ssh docker load`).

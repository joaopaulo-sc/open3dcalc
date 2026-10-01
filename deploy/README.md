# Deploy — calc.modelink3d.link

VM Oracle (AMD, 2 vCPU, **1 GB RAM**), a mesma do modelink3d-app. O Traefik e a rede
`modelink_net` vêm do compose de produção do modelink3d-app.

> **Nunca rode `docker build` na VM.** O build do Vite estoura 1 GB e pode travar a
> máquina. A imagem é gerada na máquina de dev e enviada pronta.

## Pré-requisitos (uma vez)

1. **DNS na Cloudflare:** registro `A` `calc` → `129.158.229.186`, proxy **ligado**.
   O modo SSL/TLS da zona já é "Full".
2. **Swap na VM** (folga para picos de memória; a VM não tem swap por padrão):
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

## Publicar (primeira vez e atualizações)

Passo a passo (build local, backup, envio, rollback) em
[`../MODELINK.md` → "Publicar uma atualização"](../MODELINK.md#publicar-uma-atualização).
Na primeira vez, antes: `ssh … 'mkdir -p ~/modelink-calc'`.

## Usuários

A senha é pedida no terminal (precisa de `-t` para ter TTY):

```bash
ssh -t -i ~/.ssh/modelink-oracle-instance.key ubuntu@129.158.229.186 \
  docker exec -it modelink_calc npm run users -- add joao --name "João Paulo" --admin
```

Outros comandos: `list`, `passwd <usuario>`, `disable <usuario>`, `enable <usuario>`.
Senha mínima: 10 caracteres.

## Verificar, backup e rollback

Ver [`../MODELINK.md` → "Publicar uma atualização"](../MODELINK.md#publicar-uma-atualização).

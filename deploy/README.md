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

Na máquina de dev, na raiz do fork:

```bash
SSH="ssh -i ~/.ssh/modelink-oracle-instance.key ubuntu@129.158.229.186"
docker build -t modelink-calc:latest .
docker save modelink-calc:latest | gzip | $SSH 'gunzip | docker load'
$SSH 'mkdir -p ~/modelink-calc'
scp -i ~/.ssh/modelink-oracle-instance.key deploy/docker-compose.yml ubuntu@129.158.229.186:~/modelink-calc/
$SSH 'cd ~/modelink-calc && docker compose up -d && docker image prune -f'
```

Os dados ficam no volume `modelink_calc_data` e sobrevivem às atualizações.

## Usuários

A senha é pedida no terminal (precisa de `-t` para ter TTY):

```bash
ssh -t -i ~/.ssh/modelink-oracle-instance.key ubuntu@129.158.229.186 \
  docker exec -it modelink_calc npm run users -- add joao --name "João Paulo" --admin
```

Outros comandos: `list`, `passwd <usuario>`, `disable <usuario>`, `enable <usuario>`.
Senha mínima: 10 caracteres.

## Verificar

```bash
$SSH 'docker ps --filter name=modelink_calc; docker stats --no-stream modelink_calc; docker logs --tail 20 modelink_calc'
curl -sI https://calc.modelink3d.link/ | head -3   # espera 302 para /login
```

## Backup manual do banco

```bash
$SSH 'docker exec modelink_calc node -e "new (require(\"node:sqlite\").DatabaseSync)(\"/data/calc.sqlite\").exec(\"VACUUM INTO \x27/data/backup.sqlite\x27\")" && docker cp modelink_calc:/data/backup.sqlite - ' > calc-backup.tar
```

(Backup automático para o Google Drive entra na Fase 3.)

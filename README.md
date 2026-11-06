# keepalive-siaa

Serviço que mantém viva uma sessão autenticada do SIAA (Cruzeiro do Sul) e consulta
RGMs de uma fila, resolvendo nome a partir da grade. Node 18+ (fetch nativo) + PostgreSQL.

## Como funciona

- Guarda a sessão (cookie + `javax.faces.ViewState`) no Postgres.
- A cada 8–22 min (dentro da janela/dias configurados) dispara um POST AJAX JSF "vazio"
  (`execute=@none`) que **reinicia o timeout de inatividade** do SIAA — o *ping* — e
  regrava o ViewState/cookie atualizados.
- Em paralelo, 1x/hora consulta o próximo RGM da fila e grava o nome encontrado.
- Expõe uma UI mínima (token Bearer) para reviver a sessão, ajustar a agenda e testar um RGM.

> A sessão só é mantida contra expiração **por inatividade**. Tetos de SSO/WAF (ex.: Azure AD,
> F5) têm validade própria que o ping não renova.

## Rodar

```bash
npm install
cp .env.example .env   # preencha DATABASE_URL e AUTH_TOKEN
# gere um token: openssl rand -hex 20
node scripts/keepalive.mjs
# modo único (um ping e sai): node scripts/keepalive.mjs --once
# semear sessão de um arquivo cURL: node scripts/keepalive.mjs --curl ./curl.txt
```

O schema do banco é criado automaticamente no boot (`ensureSchema`).

## Variáveis de ambiente

| Var | Obrigatória | Descrição |
|-----|:--:|-----------|
| `DATABASE_URL` | sim | string de conexão Postgres |
| `AUTH_TOKEN` | sim | Bearer token que protege as rotas autenticadas |
| `PORT` | não | porta HTTP (padrão 3000) |
| `INTERVAL_SEC` | não | valor inicial do intervalo, só na 1ª criação da agenda |
| `DATABASE_SSL` | não | `true` para TLS no Postgres |
| `SIAA_CURL` / `CURL_FILE` | não | semear a sessão no boot a partir de uma cURL |

## API

| Método | Rota | Auth | Descrição |
|--------|------|:--:|-----------|
| GET | `/` | — | UI |
| GET | `/health` | — | `{ ok, session }` |
| GET | `/status` | Bearer | sessão, agenda, último ping |
| POST | `/schedule` | Bearer | atualiza janela/dias/intervalo |
| POST | `/session` | Bearer | revive a sessão a partir de uma cURL |
| GET/POST | `/alunos` | Bearer | lista a fila / testa um RGM |

## Build (Docker)

`Dockerfile` incluso (Node 24 Alpine). Em plataformas tipo EasyPanel/Railway com Nixpacks,
o build usa `npm run start` automaticamente.

## Deploy

- **Fila de RGMs**: definida na constante `FILA` em `scripts/keepalive.mjs`.
- O serviço é *stateless*: todo o estado (sessão, agenda, fila, histórico) fica no Postgres.

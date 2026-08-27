# Deploying shatters

From a bare VPS to a working instance. Around ten minutes, most of it waiting
for Docker.

## What you need

- A VPS with Docker and the Compose plugin. 1 GB of RAM is enough for a small
  instance; the database is the only thing that grows.
- A domain name with an **A record already pointing at the server**. Certificate
  issuance fails if the name does not resolve to this host yet, so do this
  first and let it propagate.
- Ports 80 and 443 reachable from the internet. Port 80 is required even though
  everything ends up on 443 — the certificate challenge uses it.

## Set it up

```sh
git clone https://github.com/SuperpositionLabs/shatters.git
cd shatters/deploy
cp .env.example .env
```

Edit `.env`. Three values are required and the stack refuses to start without
them:

```sh
SHATTERS_DOMAIN=chat.example.com
TLS_EMAIL=you@example.com
POSTGRES_PASSWORD=      # openssl rand -base64 32
```

Generate the password rather than choosing one. It is never typed by a human,
so there is no reason for it to be memorable.

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

The first start builds both images and obtains a certificate. Watch it finish:

```sh
docker compose -f docker-compose.prod.yml logs -f proxy
```

`certificate obtained successfully` means you are done. Open
`https://your-domain` and create an account.

## What the stack runs

| Service | Exposed | Purpose |
|---|---|---|
| `proxy` | **80, 443** | TLS termination and routing. The only service reachable from outside. |
| `web` | no | Serves the client. |
| `server` | no | The API and WebSocket. |
| `db` | no | PostgreSQL. |

Only the proxy publishes ports. The database in particular is reachable solely
over the internal network — publishing 5432 on a VPS exposes it to the internet
unless a firewall happens to be in the way, which is not something to rely on.

Client and API share one origin. That is what keeps `CORS_ALLOWED_ORIGINS`
empty, which is its safe default, and what lets the WebSocket pass its
same-origin check with no configuration.

## Operating it

**Updating.** The database survives; the images are rebuilt.

```sh
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run automatically at startup, in a transaction each.

**Backups.** Everything worth keeping is in the `pgdata` volume. Nothing in it
is readable without the users' keys, so a backup leaks ciphertext and routing
metadata rather than messages — but it is still the whole server.

```sh
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U shatters shatters | gzip > shatters-$(date +%F).sql.gz
```

**Message history lives on devices, not here.** A restored database brings back
undelivered envelopes and public keys. It does not bring back anyone's
conversations, because the server never had them. Users who lose their device
lose their history; that is the design, not a gap in the backup.

**Logs.**

```sh
docker compose -f docker-compose.prod.yml logs -f server
```

The server logs no message content, no account identifiers and no IP addresses
— there is nothing sensitive in them, and nothing useful for debugging a
delivery problem either.

## Tuning

All optional, all in `.env`.

| Variable | Default | When to change it |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | `60` | A busy instance, or a deliberately restrictive private one |
| `RATE_LIMIT_BURST` | `20` | Same |
| `SWEEP_INTERVAL` | `1h` | Set `0` to run the deletes from your own cron |
| `TRUSTED_PROXIES` | `1` | Only if you put another proxy or a CDN **in front of** Caddy |

`TRUSTED_PROXIES` deserves a word. Behind a proxy every request arrives from the
proxy's address, so the per-IP rate limiter would put every user in one bucket
and they would throttle each other. The count tells the server how many hops to
look back through `X-Forwarded-For`. The bundled stack has exactly one, which is
the default here. **Do not raise it past the number of proxies that actually
exist** — each extra hop is one more address a caller can prepend and have
believed.

## Before you invite anyone

- **Try it with two accounts.** Register on two devices, exchange a message,
  and compare the safety number in each conversation. If they match, the
  handshake worked and nobody is in the middle.
- **Tell people there is no recovery.** Forgetting the passphrase loses the
  history. Losing the device loses the account. There is nothing you can do as
  the operator, which is the point, but it is unkind to let someone discover it
  afterwards.
- **Know what you can still see.** You cannot read messages. You *can* see which
  account IDs exchange envelopes, when, and roughly how large they are.
  [`threat-model.md`](threat-model.md) is explicit about this; so should you be
  with your users.
- **This has not been independently audited.** The cryptography follows the
  Signal specifications and uses only libsodium and the Go standard library, but
  nobody outside the repository has reviewed it. That is a reasonable thing to
  run for yourself and your friends, and not a reasonable thing to recommend to
  someone whose safety depends on it.

## If something is wrong

**The certificate never arrives.** The domain must resolve to this host and
port 80 must be reachable. Check both:

```sh
dig +short your-domain
curl -sI http://your-domain/.well-known/acme-challenge/test
```

**The client loads but nothing connects.** The account panel shows a connection
dot. If it stays red, the API is not reachable through the proxy:

```sh
curl -sS https://your-domain/healthz
docker compose -f docker-compose.prod.yml logs server
```

**Everyone is being rate limited at once.** `TRUSTED_PROXIES` is unset or zero,
so every request is attributed to the proxy and all users share one bucket. It
should be `1` for the bundled stack.

**The server will not start.** It refuses rather than falling back on invalid
configuration, and says which value it disliked:

```sh
docker compose -f docker-compose.prod.yml logs server | tail
```

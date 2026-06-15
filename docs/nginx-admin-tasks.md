# Edge nginx on ostapLase — serves `https://bidberry.animeenigma.ru/` + gated `/admin/tasks`

## Architecture (as of 2026-06-15)

`bidberry.animeenigma.ru` (DNS → `212.124.23.244`, which is **this box's own
public IP**) → router `192.168.0.1` forwards inbound **80 + 443** to this box
(`192.168.0.10`) → **nginx on this box** terminates TLS and reverse-proxies to
the Bun app on `127.0.0.1:3000`.

There is **no separate edge VPS**. The VPN VPS `103.137.249.134` referenced in
the xray config (`/usr/local/etc/xray/config.json`) is only this box's
*outbound* circumvention proxy (`127.0.0.1:3128` / `:1080`) for reaching blocked
foreign services; `.ru` domains (including this one) are routed direct. It plays
no part in inbound domain traffic.

> Note: from this box you can't curl `https://bidberry.animeenigma.ru/` directly
> — hairpin NAT (a host can't reach its own public IP from inside the LAN).
> Test TLS locally with `--resolve bidberry.animeenigma.ru:443:127.0.0.1`, or
> test the real public path from outside (e.g. check-host.net).

## Files on the box (NOT in the repo — root-owned)

- `/etc/nginx/sites-available/bidberry.animeenigma.ru` (symlinked into
  `sites-enabled/`) — the vhost. A reference copy is kept in this repo at
  `docs/nginx/bidberry.animeenigma.ru.conf`; keep them in sync by hand.
- `/etc/letsencrypt/live/bidberry.animeenigma.ru/` — Let's Encrypt cert
  (webroot authenticator, webroot `/var/www/certbot`). Auto-renews via
  `certbot.timer`; the `/.well-known/acme-challenge/` location on :80 is kept
  for renewals. Renew dry-run: `sudo certbot renew --dry-run`.
- `/etc/nginx/conf.d/wb-emulators.conf` — auto-generated emulator locations
  (the app writes it via the `/etc/nginx/conf.d` bind-mount + a `.reload-trigger`).
  Created empty so the `include` resolves. **TODO:** there is no host-side
  watcher reloading nginx on the trigger yet — if/when emulators are provisioned,
  add one (e.g. a systemd path unit on the trigger file running `nginx -s reload`).

## The login gate

The board is gated with nginx `auth_request /_auth/tasks`, which proxies to the
app's `GET /api/auth/check-user` (`src/web/auth-routes.ts`): **200** for any
valid login JWT, **401** otherwise. Telegram login already enforces the
whitelist (`auth-service.checkWhitelist`), so "logged in" == "whitelisted" —
the board is open to the **same whitelisted users** that can use the app, not
admin-only. Unauthenticated requests get `error_page 401/403 =302 /`, bouncing
to the SPA login page.

## Verify

- `https://bidberry.animeenigma.ru/admin/tasks` logged out → 302 to `/`.
- Logged in as any whitelisted user → the board loads (its `/api/dev-tasks`
  reads are same-origin so the cookie rides along; mutations still need the
  `X-Trigger-Secret` via the 🔑 button).
- `curl -I http://bidberry.animeenigma.ru/` → 301 to HTTPS.

## Apply config changes

Edit `/etc/nginx/sites-available/bidberry.animeenigma.ru`, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

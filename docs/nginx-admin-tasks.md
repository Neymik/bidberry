# Exposing `/admin/tasks` (Dev Task Board) on the public domain, gated by login

The dev task board is served by the Bun app at `/admin/tasks` (see
`src/web/dev-tasks-routes.ts`). It is reachable on the box at
`http://127.0.0.1:3000/admin/tasks`, but the public edge proxy only forwards an
explicit allowlist of paths, so `https://bidberry.animeenigma.ru/admin/tasks`
returns **404** until the location below is added.

## Architecture recap

`bidberry.animeenigma.ru` → **edge nginx on the VPS `212.124.23.244`** (TLS) →
tunnel → this host's Bun app on `127.0.0.1:3000`. The server block lives on the
VPS at `/etc/nginx/sites-enabled/bidberry.animeenigma.ru` (there is no nginx on
ostapLase). This is the same file that holds the `/_auth/admin` and
`/_auth/emu` blocks.

## App side (already done)

`src/web/auth-routes.ts` exposes `GET /api/auth/check-user`: returns **200** for
any valid login JWT, **401** otherwise. Telegram login already enforces the
whitelist (`auth-service.checkWhitelist`), so "has a valid JWT" == "is a
whitelisted user". This is the `auth_request` target — it gates the board for
the **same whitelisted users** that can use the app (not admin-only).

## Nginx side (apply on the VPS)

In `/etc/nginx/sites-enabled/bidberry.animeenigma.ru`, inside the `server { }`
block (next to the existing `/_auth/emu` block, before `location /`), add:

```nginx
    # Dev task board auth check (internal) — 200 if logged in (= whitelisted)
    location = /_auth/tasks {
        internal;
        proxy_pass http://127.0.0.1:3000/api/auth/check-user;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Original-URI $request_uri;
    }

    # Dev task board — gated behind Telegram login (whitelisted users)
    location /admin/tasks {
        auth_request /_auth/tasks;
        error_page 401 =302 /;   # not logged in → bounce to login page
        error_page 403 =302 /;

        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

Then test and reload:

```bash
nginx -t && nginx -s reload
```

The board's data calls (`GET /api/dev-tasks`) are same-origin, so the browser
sends the login cookie automatically; mutations still require the
`X-Trigger-Secret` entered via the 🔑 button (unchanged).

## Verify

- Logged out: `https://bidberry.animeenigma.ru/admin/tasks` → 302 to `/` (login).
- Logged in (any whitelisted user): the board loads and lists tasks.

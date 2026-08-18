# Deployment

## Cloudflare Tunnel setup

The domain must already be active in Cloudflare DNS.

1. Sign in to the Cloudflare dashboard and open **Networking → Tunnels**.
2. Select **Create a tunnel**, choose Cloudflared, name it `anonshock`, and create it.
3. Copy the tunnel token from the Docker installation command. The token is the long value after
   `--token`; store only that value as `TUNNEL_TOKEN` in `.env`.
4. Open the tunnel's **Routes** tab and select **Add route → Published application**.
5. Set the subdomain to `anonshock`, select `namelessnanashi.dev`, and leave the path empty.
6. Enter the complete protocol and socket path in the **Service URL** field:

   ```text
   unix:/run/anonshock/anonshock.sock
   ```

7. Save the route. Cloudflare creates the proxied DNS route for
   `anonshock.namelessnanashi.dev`.

The tunnel token grants permission to connect an origin to this tunnel. Keep it secret and rotate
it from the tunnel settings if it is exposed. The host must be able to make outbound connections to
Cloudflare on port 7844.

## Production image

Copy `.env.example` to `.env`, fill in the required secrets and tunnel token, then run:

```bash
docker compose up -d
```

The main Compose file pulls `ghcr.io/nanashithenameless/anonshock:latest`. Wait for the app to become
healthy and `cloudflared` to be running, then open `https://anonshock.namelessnanashi.dev`.

## Local image

The standalone local stack builds the current checkout and uses separate containers and volumes:

```bash
docker compose -f docker-compose.local.yml up -d --build
```

## Required setup

- Set `PUBLIC_ORIGIN=https://anonshock.namelessnanashi.dev`.
- Set `APP_VERSION` to the deployed AnonShock version. The outbound OpenShock User-Agent uses this
  version and automatically uses `PUBLIC_ORIGIN` as its URL.
- For an unmodified deployment, leave `IS_FORK=false`. A fork must set `IS_FORK=true` and set
  `GIT_REPO_URL` to its public source repository; the site will identify and link to that fork.

> **Fork disclosure:** Any modified deployment exposed to the open internet must declare itself as
> a fork with `IS_FORK=true` and link to its public source repository with `GIT_REPO_URL`.
- Generate `STORE_KEY`, `TOKEN_PEPPER`, and optionally `ALTCHA_HMAC_KEY` with
  `openssl rand -base64 32`.
- Set `TUNNEL_TOKEN` to a Cloudflare Tunnel token.
- Keep `.env` readable only by the operator and back up `STORE_KEY`; losing it makes stored links
  unreadable.
- Keep the data volume backed up if existing links must survive a host failure.

Check the stack with `docker compose ps` and view startup failures with `docker compose logs`.

Do not run the production and local stacks at the same time with the same tunnel token unless both
should receive public traffic as tunnel replicas.

Cloudflare's current dashboard walkthrough is available in the
[official Tunnel setup guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).

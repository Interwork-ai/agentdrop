# Quick trial without a domain (plain http on a high port)

Use this when 80/443 are already taken or there is no domain yet. It is the same image and stack as
`compose.local.yaml`, exposed on a host port of your choice.

```bash
cat > .env.trial <<EOF
AGENTDROP_PORT=3300
PUBLIC_BASE_URL=http://<server-ip>:3300
AUTH_SECRET=$(openssl rand -base64 48)
EOF
chmod 600 .env.trial
set -a; . ./.env.trial; set +a
sudo -E docker compose -f compose.local.yaml -p agentdrop up -d --build
curl -s http://127.0.0.1:3300/health/ready
```

Then open `<server-ip>:3300` inbound in the cloud security group / firewall.

Clients must opt in to cleartext because credentials would travel unencrypted:

```bash
agentdrop login --server http://<server-ip>:3300 --allow-http
```

Keep this to a trusted network and move to HTTPS as soon as you can: either the Caddy setup in `DEPLOY.md` (needs
80/443 free) or, when a host nginx already owns 80/443, the vhost recipe below.

## HTTPS through an existing host nginx (no domain needed)

`sslip.io` resolves `<anything>.203-0-113-10.sslip.io` to `203.0.113.10`, and Let's Encrypt issues certificates
for such names, so a public IP is enough:

```bash
# 1. plain-http vhost that proxies to the container (certbot upgrades it to https)
sudo tee /etc/nginx/sites-available/agentdrop >/dev/null <<'NGX'
server {
    listen 80;
    listen [::]:80;
    server_name agentdrop.203-0-113-10.sslip.io;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
NGX
sudo ln -sf /etc/nginx/sites-available/agentdrop /etc/nginx/sites-enabled/agentdrop
sudo nginx -t && sudo systemctl reload nginx
# 2. certificate + automatic https redirect
sudo certbot --nginx -d agentdrop.203-0-113-10.sslip.io -n --agree-tos --redirect
# 3. tell the app it is behind TLS and stop exposing the plain port publicly
cat >> .env.trial <<EOF
PUBLIC_BASE_URL=https://agentdrop.203-0-113-10.sslip.io
TRUST_PROXY=true
AGENTDROP_BIND=127.0.0.1
EOF
set -a; . ./.env.trial; set +a
sudo -E docker compose -f compose.local.yaml -p agentdrop up -d
```

Clients then use `agentdrop setup --server https://agentdrop.203-0-113-10.sslip.io` (no `--allow-http`). Endpoints
paired against the old `http://<ip>:3300` address must run `setup` again.

If the cloud firewall does not allow 443 yet, nginx can terminate TLS on the port that is already open: add
`listen 3300 ssl;` to the certbot-generated server block, move the container to another local port
(`AGENTDROP_PORT=3301`, `proxy_pass http://127.0.0.1:3301`), and set `WEB_ORIGIN=https://agentdrop.203-0-113-10.sslip.io:3300`
so browser pairing links and the CSRF origin check use the reachable address: `https://agentdrop.203-0-113-10.sslip.io:3300`
works at once, and the same name on 443 starts working as soon as the port is opened (then drop `WEB_ORIGIN` to
make the clean URL canonical).

Operations:

```bash
sudo docker compose -p agentdrop ps
sudo docker compose -p agentdrop logs -f api
sudo docker compose -p agentdrop down          # keeps volumes (database + attachments)
```

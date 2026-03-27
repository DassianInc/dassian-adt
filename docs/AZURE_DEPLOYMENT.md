# dassian-adt: Azure Deployment Guide

## What This Is

A Node.js server that gives AI assistants (Claude) access to SAP systems. Runs as a single process, listens on HTTP, handles multiple concurrent users — each gets their own SAP session. Your job: get it running, reachable by the team, reachable to SAP.

---

## 1. VM

**B2s** (2 vCPU, 4 GB RAM, ~$30/month). This is not compute-heavy — it proxies HTTP requests to SAP.

- **OS:** Ubuntu 22.04 LTS
- **Disk:** 30 GB Standard SSD
- **Region:** Same as the SAP systems (they're already on Azure)

---

## 2. Network

**Outbound to SAP (NSG egress rules, port 44300 TCP):**

| Destination | Host | Purpose |
|-------------|------|---------|
| D23 | `d23app.dassian.org:44300` | Dev 2023 |
| D25 | `d25app.dassian.org:44300` | Dev 2025 |
| X22 | `x22app.dassian.org:44300` | Dev 2022 |
| C23 | `c23app.dassian.azure:44300` | Consolidation 2023 |
| C25 | `c25app.dassian.azure:44300` | Consolidation 2025 |
| M25 | `m25app.dassian.org:44300` | Replatform dev |

The `.dassian.azure` hosts are on the same Azure network — confirm the VM is in the same VNet or has peering. The `.dassian.org` hosts need routing through existing network paths (same as how the current SAP Azure systems reach them).

**Inbound (NSG ingress rule):**

| Source | Port | Purpose |
|--------|------|---------|
| Team IP range or VPN CIDR | 3000 TCP | MCP HTTP endpoint |

Do NOT expose port 3000 to the public internet. Restrict to your VPN/office CIDR. If you need public access later, put it behind an Azure Application Gateway with auth.

---

## 3. Install

SSH into the VM and run:

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Clone and build
git clone https://github.com/DassianInc/dassian-adt.git /opt/dassian-adt
cd /opt/dassian-adt
npm install
npm run build

# Verify
npm test  # Should show 165 passing tests
```

---

## 4. Configure

Create `/opt/dassian-adt/.env`:

```bash
# Transport mode
MCP_TRANSPORT=http
MCP_HTTP_PORT=3000

# SAP connection (one server instance per SAP system)
SAP_URL=https://d25app.dassian.org:44300
SAP_USER=GCTSBOT
SAP_PASSWORD=<get from Paul>
SAP_CLIENT=100
SAP_LANGUAGE=EN

# Self-signed SAP certs
NODE_TLS_REJECT_UNAUTHORIZED=0
```

For multiple SAP systems, run one instance per system on different ports:

```bash
# D25 on port 3000
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 SAP_URL=https://d25app.dassian.org:44300 ...

# D23 on port 3001
MCP_TRANSPORT=http MCP_HTTP_PORT=3001 SAP_URL=https://d23app.dassian.org:44300 ...
```

---

## 5. Run as systemd Service

Create `/etc/systemd/system/dassian-adt-d25.service`:

```ini
[Unit]
Description=dassian-adt MCP server (D25)
After=network.target

[Service]
Type=simple
User=dassian
WorkingDirectory=/opt/dassian-adt
EnvironmentFile=/opt/dassian-adt/.env.d25
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
# Create service user
sudo useradd -r -s /bin/false dassian
sudo chown -R dassian:dassian /opt/dassian-adt

# Copy .env to per-system files
sudo cp /opt/dassian-adt/.env /opt/dassian-adt/.env.d25
# Edit .env.d25 with D25 connection details, set MCP_HTTP_PORT=3000

# Repeat for D23 on port 3001 if needed:
# sudo cp /etc/systemd/system/dassian-adt-d25.service /etc/systemd/system/dassian-adt-d23.service
# Change EnvironmentFile and Description

sudo systemctl daemon-reload
sudo systemctl enable dassian-adt-d25
sudo systemctl start dassian-adt-d25
```

---

## 6. Verify

```bash
# Check service
sudo systemctl status dassian-adt-d25

# Check logs
sudo journalctl -u dassian-adt-d25 -f

# Health check (from the VM)
curl http://localhost:3000/health
# Should return: {"status":"ok","sessions":0}

# Health check (from your machine, through VPN)
curl http://<vm-ip>:3000/health
```

---

## 7. What to Give Paul

Once it's running and reachable:

- The URL: `http://<vm-ip-or-dns>:3000/mcp` (D25)
- The URL: `http://<vm-ip-or-dns>:3001/mcp` (D23, if running)
- Confirm which SAP systems are reachable from the VM

Paul will register these as team MCP integrations. Team members don't need to install anything.

---

## 8. Maintenance

**Updates:**
```bash
cd /opt/dassian-adt
git pull
npm install
npm run build
sudo systemctl restart dassian-adt-d25
```

**Logs:** `sudo journalctl -u dassian-adt-d25 --since "1 hour ago"`

**SAP password rotation:** Edit `.env.d25`, then `sudo systemctl restart dassian-adt-d25`

**Monitoring:** The `/health` endpoint returns `{"status":"ok","sessions":N}`. Point your monitoring at it. If it stops responding, the service needs a restart.

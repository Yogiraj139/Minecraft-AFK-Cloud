# Minecraft AFK Cloud

CloudAFK Pro X is a Node.js dashboard for running a Minecraft AFK bot from cloud hosting such as Railway.

## Railway Setup

1. Upload this folder to GitHub.
2. Create a Railway project from the GitHub repo.
3. Add variables:
   - `NODE_ENV=production`
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD=your-dashboard-password`
   - `SESSION_SECRET=${{ secret() }}`
   - `APP_SECRET=${{ secret() }}`
   - `DATA_DIR=/data`
   - `AUTO_START_ON_BOOT=true`
   - `MAX_RSS_MB=768`
4. Add a Railway volume mounted at `/data` if available.
5. Deploy and open the Railway domain.

## Proxy Use

In the dashboard scroll to Proxy System, paste proxies such as:

```txt
socks4://199.102.104.70:4145
socks5://user:pass@host:port
host:port:user:pass
```

Import, Test, set Proxy Mode to Rotate, Save Settings, then Start.

Some Minecraft servers block datacenter/cloud/proxy IPs or disallow automation. Use this only where allowed by the server rules.

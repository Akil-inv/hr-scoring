# Deploying HR Scoring on the EC2 server (via SSM)

HR Scoring runs as a second Docker stack on the same EC2 server as the live
hackathon platform. It has its own folder, containers, database and volume,
publishes no ports, and is reachable only over Tailscale. Nothing below
touches `/opt/hackjudge` or the live containers.

| | Live platform | HR Scoring |
| --- | --- | --- |
| Folder | `/opt/hackjudge/hackathon-platform` | `/opt/hr-scoring/hr-scoring` |
| Containers | `hackathon-platform-*` | `hr-scoring-*` |
| Database | its own volume | `hr-scoring_pgdata` |
| Reached at | judge.uobigedm.com (ALB) | `https://hr-scoring.<tailnet>.ts.net` (Tailscale only) |

---

## One-time setup

### 1. Tailscale (in the browser)

1. Open https://login.tailscale.com/admin/dns and make sure **MagicDNS** and
   **HTTPS Certificates** are both enabled. The stack serves HTTPS with a
   Tailscale certificate, which needs both.
2. Open https://login.tailscale.com/admin/settings/keys and **Generate auth
   key**. Leave *Reusable* off and *Ephemeral* off. Copy the key (`tskey-auth-…`).
   It is only used for the first start.
3. Make sure your laptop is signed in to the same tailnet.

### 2. Open an SSM session and become root

```bash
aws ssm start-session --target <instance-id>
sudo -i
```

### 3. Check the server has room

```bash
free -m
df -h /
swapon --show
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}"
```

You want at least **1.5 GB** in the `available` column of `free -m`, and at
least **5 GB** free disk. Builds (especially the web app) need memory on top
of what is running.

If memory is short and `swapon --show` prints nothing, add 2 GB of swap. This
is safe to do with the live platform running:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -m
```

### 4. Give the server read access to the private repo

`hr-scoring` is private, so the server needs a deploy key (read-only, this
repo only).

```bash
ssh-keygen -t ed25519 -f ~/.ssh/hr_scoring_deploy -N "" -C "hr-scoring deploy (EC2)"
cat ~/.ssh/hr_scoring_deploy.pub
```

Copy the line that is printed. On GitHub: **Akil-inv/hr-scoring → Settings →
Deploy keys → Add deploy key**, paste it, leave *Allow write access* off.

Then tell SSH to use that key for this repo:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-hr-scoring
  HostName github.com
  User git
  IdentityFile ~/.ssh/hr_scoring_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T github-hr-scoring
```

The last command should say *"You've successfully authenticated"*. (It also
says GitHub does not provide shell access; that is expected.)

### 5. Clone and configure

```bash
mkdir -p /opt/hr-scoring && cd /opt/hr-scoring
git clone -b feature/day-based-judging git@github-hr-scoring:Akil-inv/hr-scoring.git
cd hr-scoring

cp .env.example .env
sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^JUDGE_TOKEN_SALT=.*/JUDGE_TOKEN_SALT=$(openssl rand -hex 16)/" .env
sed -i "s/^TS_AUTHKEY=.*/TS_AUTHKEY=PASTE-YOUR-KEY-HERE/" .env   # replace with your tskey-auth-… key
chmod 600 .env
grep -c '=$' .env   # should print 1 (only PUBLIC_ORIGIN is still blank)
```

### 6. First deploy

The first build takes several minutes. If the SSM session drops mid-build the
build stops, so run it in the background and watch the log:

```bash
nohup ./deploy.sh > deploy.log 2>&1 &
tail -f deploy.log
```

Press `Ctrl+C` to stop watching (the deploy keeps going). It ends with either

```
✓ deployed — open https://hr-scoring.<tailnet>.ts.net from a device on your tailnet
```

or an error with the last API log lines and the rollback commands.

### 7. Create your admin login

```bash
docker-compose exec api node scripts/create-super-admin.js you@example.com
```

It asks for a password (at least 12 characters). Run it again any time to
reset that password.

### 8. Open it from your laptop

Open the address printed by the deploy. The first visit can take a few seconds
while Tailscale issues the certificate.

Then lock the API to that address. Put it in `.env` and restart the API:

```bash
sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://hr-scoring.<tailnet>.ts.net|" .env
docker-compose up -d api
```

You can now remove the auth key from `.env` (`sed -i "s/^TS_AUTHKEY=.*/TS_AUTHKEY=/" .env`).
The Tailscale container stays signed in through its own volume.

---

## Every later deploy

```bash
aws ssm start-session --target <instance-id>
sudo -i
cd /opt/hr-scoring/hr-scoring
nohup ./deploy.sh > deploy.log 2>&1 &
tail -f deploy.log
```

`deploy.sh` backs up the database, pulls the branch that is checked out, keeps
the running images as the rollback point, builds one service at a time,
applies migrations, restarts only this stack, and then checks it: API,
database, scheduler, sign-in page and GraphQL. To deploy a different branch:
`DEPLOY_BRANCH=main ./deploy.sh`.

## Rolling back

**Automatic, when a deploy's check fails.** The previous release is put back
straight away: its images (kept on the server, so nothing is built or
downloaded), its code, and, if the release changed the database, the backup
taken at the start of the deploy. The database as it was is saved to
`../backups/` first. An alert is sent, and `deploy.sh` exits with code 2.

**By hand, when someone finds something broken later:**

```bash
./deploy.sh --status      # what is running, and what a rollback would put back
./deploy.sh --rollback    # asks you to type ROLLBACK
```

If that release changed the database, `--rollback` stops and explains. Run
`./deploy.sh --rollback --with-database` to also restore the backup taken
just before the release. Anything saved since then is removed from the app,
although a copy of the database is kept in `../backups/` first. Run rollbacks
in the foreground, not with `nohup`: they ask before doing anything.

Only one step back is kept: the release before the current one.

**After any rollback, the next deploy is refused** while the branch still
contains the release that was rolled back. Revert it in git first. For a
patch-kit upgrade, use GitHub → Actions → patch-kit → Run workflow →
`roll-back-last-upgrade`, review the pull request and merge it, then deploy.
If later commits fix the problem instead, deploy with `--allow-blocked`.

**Alerts** go to `../releases/alerts.log`, and to email when `ALERT_TOPIC_ARN`
is set in `.env` (see below). The history of deploys and rollbacks is in
`../releases/releases.log`.

### Alerts by email (one time)

Use the SNS topic from the encryption setup (`hr-scoring-key-alerts`, already
emailing you). In CloudShell, let the server publish to it:

```bash
aws iam put-role-policy --role-name SSMroleforEC2 --policy-name hr-scoring-deploy-alerts \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sns:Publish",
  "Resource":"arn:aws:sns:ap-southeast-1:<account>:hr-scoring-key-alerts"}]}'
```

Then on the server add `ALERT_TOPIC_ARN=arn:aws:sns:ap-southeast-1:<account>:hr-scoring-key-alerts`
to `.env`. No restart is needed: `deploy.sh` reads it when it runs.

## Useful commands

All from `/opt/hr-scoring/hr-scoring`:

| What | Command |
| --- | --- |
| Status | `docker-compose ps` |
| API logs | `docker-compose logs -f --tail=100 api` |
| Tailscale address and state | `docker-compose exec tailscale tailscale status` |
| Stop the stack (keeps data) | `docker-compose down` |
| Start it again | `docker-compose up -d` |
| Clear all event data, keep logins | `./reset.sh` |
| What a rollback would put back | `./deploy.sh --status` |
| Put back the previous release | `./deploy.sh --rollback` |

Never run `docker-compose down -v`: `-v` deletes the database volume.

## If something goes wrong

- **Tailscale address never appears.** `docker-compose logs --tail=50 tailscale`.
  An expired or already-used auth key is the usual cause: generate a new one,
  put it in `.env`, and run `docker-compose up -d tailscale`.
- **Browser says the certificate is invalid.** HTTPS Certificates is not
  enabled in the Tailscale DNS settings (step 1).
- **`git clone` fails with "Permission denied (publickey)".** The deploy key
  was not added, or was added to a different repo (step 4).
- **The live platform slows down during a build.** Builds run one at a time,
  but if it still matters, deploy outside event hours or add swap (step 3).

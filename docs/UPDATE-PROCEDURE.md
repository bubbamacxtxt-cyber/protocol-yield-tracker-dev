# Update Procedure: Dev → Prod

How to promote the dev repo (`protocol-yield-tracker-dev`) to prod (`protocol-yield-tracker`) safely, with rollback at every step.

**Last validated:** 2026-04-26 — initial swap from legacy DeBank-heavy prod to scanner-first dev.

---

## When to run this

Run this procedure when dev has been stable for at least 24 hours of automated scans and you want to promote it to the live dashboard at https://bubbamacxtxt-cyber.github.io/protocol-yield-tracker/.

**Do NOT run this** when:
- Dev has failing workflow runs in the last 2 hours
- Dev has uncommitted local changes
- You just added a new scanner that hasn't been tested through a full `free-scans-hourly` run

---

## What gets replaced

Everything. Code, workflows, DB, data files, docs. Prod's git history after the swap will point to dev's latest commit.

Secrets and Pages settings on the prod repo are NOT touched by the swap — they live at the repo level, not the branch level. Verify them manually (step 3 below).

---

## Prerequisites

- Local workspace has both repos cloned at `/home/node/.openclaw/workspace/protocol-yield-tracker{,-dev}`
- Git auth works for both repos (the `ghp_*` token embedded in remote URLs)
- Node 20+ available (for encrypting secrets via the GitHub API)

---

## Step 1: Pre-flight checks

### 1.1 Dev is clean and up to date
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker-dev
git status                      # should say "working tree clean"
git fetch origin && git log --oneline origin/main -5
```

### 1.2 Dev's latest workflow runs are green
Browse to https://github.com/bubbamacxtxt-cyber/protocol-yield-tracker-dev/actions. The last `free-scans-hourly`, `vaults`, and `recon-daily` runs should all be green. If the most recent is red, investigate and fix before promoting.

### 1.3 Prod is clean and up to date
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker
git status
git fetch origin && git log --oneline origin/main -5
```

---

## Step 2: Archive current prod state (rollback safety)

Never skip this. If the swap goes wrong, this is your restore point.

### 2.1 Archive the remote branch
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker
DATE=$(date -u +%Y-%m-%d)
git push origin main:prod-archive-$DATE
# Expect: "* [new branch]      main -> prod-archive-YYYY-MM-DD"
```

### 2.2 Archive the local DB
```bash
cp /home/node/.openclaw/workspace/protocol-yield-tracker/yield-tracker.db \
   /home/node/.openclaw/workspace/prod-db-backup-$DATE.db
ls -lh /home/node/.openclaw/workspace/prod-db-backup-$DATE.db
```

---

## Step 3: Verify secrets parity between dev and prod

Dev's workflows reference a set of secrets. Prod must have the same set, or workflows will crash silently on missing env vars.

### 3.1 List secrets dev workflows need
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker-dev
grep -rhoE 'secrets\.[A-Z_]+' .github/workflows/ | sort -u
# Excludes .disabled workflows automatically unless you pass --include-disabled
# (Telegram secrets are only in .disabled workflows; they're not required.)
```

**Current active list (as of 2026-04-26):**
- `ALCHEMY_API_KEY`
- `ALCHEMY_INK_RPC_URL`
- `ALCHEMY_MNT_RPC_URL`
- `ALCHEMY_MONAD_RPC_URL`
- `ALCHEMY_PLASMA_RPC_URL`
- `ALCHEMY_RPC_URL`
- `ALCHEMY_SONIC_RPC_URL`
- `ARB_RPC_URL`
- `BASE_RPC_URL`
- `DEBANK_API_KEY`
- `DRPC_API_KEY`

Not required (disabled workflows only): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

### 3.2 List secrets currently on prod

```bash
TOKEN="ghp_xxx"   # your GitHub token with repo scope
curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/bubbamacxtxt-cyber/protocol-yield-tracker/actions/secrets?per_page=30" \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));d.secrets.forEach(s=>console.log(s.name));"
```

### 3.3 Add any missing secrets via the API

Go to `/home/node/.openclaw/workspace/protocol-yield-tracker-dev/.env` for the values. Then run this helper (adjust the `secrets` object to include only the missing names):

```javascript
// save as /tmp/add-secrets.js
const sodium = require('tweetsodium');    // npm install -g tweetsodium (or in /tmp)
const https = require('https');

const TOKEN = 'ghp_xxx';
const REPO = 'bubbamacxtxt-cyber/protocol-yield-tracker';
const secrets = {
  ALCHEMY_API_KEY: 'your_key_here',
  // ...add only missing names + their values
};

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'bub2-prod-swap',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const r = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({status: res.statusCode, body: d}));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const k = await req('GET', `/repos/${REPO}/actions/secrets/public-key`);
  const { key: publicKey, key_id } = JSON.parse(k.body);
  const pubKeyBytes = Buffer.from(publicKey, 'base64');
  for (const [name, value] of Object.entries(secrets)) {
    const enc = Buffer.from(sodium.seal(Buffer.from(value, 'utf8'), pubKeyBytes)).toString('base64');
    const res = await req('PUT', `/repos/${REPO}/actions/secrets/${name}`,
      JSON.stringify({ encrypted_value: enc, key_id }));
    console.log((res.status === 201 || res.status === 204 ? '✅' : '❌'), name, res.status);
  }
})();
```

Run: `cd /tmp && npm install --silent tweetsodium && node /tmp/add-secrets.js`.

A 201 means created, 204 means updated. Anything else is an error.

### 3.4 Verify branch protection allows the Actions bot to commit

The scanner workflows auto-commit their output back to `main`. If the prod repo has branch protection requiring PRs, the bot will fail on the `Commit updated data` step.

Either:
- **Disable "Require a pull request before merging"** on the prod repo's `main` branch rule, OR
- **Add `github-actions[bot]` as a bypass actor** in the protection rule.

The former is what we did on 2026-04-26. If you want to keep branch protection on, go with the bypass actor route.

You also need "Allow force pushes" enabled on `main` for Step 4 to work.

---

## Step 4: The swap

This is the irreversible step if you skip Step 2. Do not skip Step 2.

### 4.1 Add dev as a remote on the prod repo
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker
git remote | grep -q "^dev-source$" || \
  git remote add dev-source \
    https://ghp_xxx@github.com/bubbamacxtxt-cyber/protocol-yield-tracker-dev.git
git fetch dev-source
git log --oneline dev-source/main -3   # sanity check
```

### 4.2 Force-push dev's main to prod's main
```bash
git push origin dev-source/main:main --force
# Expect: "+ <old>...<new> dev-source/main -> main (forced update)"
```

If you see `remote rejected ... protected branch hook declined`, revisit 3.4.

### 4.3 Sync the local prod checkout
```bash
git fetch origin
git reset --hard origin/main
git log --oneline -3
# Should show the same commits as dev's main
```

---

## Step 5: Validate the swap with a manual workflow run

Don't wait for the next scheduled cron — trigger manually and watch.

### 5.1 Dispatch the hourly scan workflow
```bash
TOKEN="ghp_xxx"
curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/bubbamacxtxt-cyber/protocol-yield-tracker/actions/workflows/free-scans-hourly.yml/dispatches" \
  -d '{"ref":"main"}' -w "HTTP %{http_code}\n"
# Expect: HTTP 204
```

### 5.2 Poll status until complete
```bash
# Get the latest run id
RUN_ID=$(curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/bubbamacxtxt-cyber/protocol-yield-tracker/actions/runs?per_page=3" \
  | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const run = d.workflow_runs.find(r => r.name === 'Protocol Scans (2h)' && r.status !== 'completed');
    console.log(run ? run.id : '');
  ")
echo "Run: $RUN_ID"

# Poll
for i in $(seq 1 30); do
  ST=$(curl -s -H "Authorization: token $TOKEN" \
    "https://api.github.com/repos/bubbamacxtxt-cyber/protocol-yield-tracker/actions/runs/$RUN_ID" \
    | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.status+'|'+(d.conclusion||'-'));")
  echo "t+$((i*30))s  $ST"
  case "$ST" in completed*) break;; esac
  sleep 30
done
```

A full scan takes ~10-12 minutes. Conclusion should be `success`.

If it fails on `Commit updated data`, revisit 3.4 (branch protection).

### 5.3 Also dispatch vaults + recon-daily
```bash
for WF in vaults.yml recon-daily.yml; do
  curl -s -X POST -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/bubbamacxtxt-cyber/protocol-yield-tracker/actions/workflows/$WF/dispatches" \
    -d '{"ref":"main"}' -w "$WF: HTTP %{http_code}\n"
done
```

Watch them finish. `vaults.yml` takes ~3 min. `recon-daily.yml` takes ~5 min (hits DeBank API, uses budget).

### 5.4 Verify the live dashboard
```bash
# Give Pages ~60s to rebuild after the scan's commit
sleep 60
curl -s "https://bubbamacxtxt-cyber.github.io/protocol-yield-tracker/data.json?v=$(date +%s)" \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('generated_at:', d.generated_at);
    console.log('total_positions:', d.summary?.total_positions);
    console.log('total_value:', d.summary?.total_value);
  "
```

Expected: `generated_at` within the last 15 minutes, `total_positions` roughly matching dev's most recent export, `total_value` in the same ballpark as dev.

Also load https://bubbamacxtxt-cyber.github.io/protocol-yield-tracker/ in a browser and spot-check a whale page.

---

## Step 6: Post-swap checks

### 6.1 Confirm the old DeBank-heavy workflow is NOT running
The legacy `update.yml` burns DeBank credits. In dev it lives as `update.yml.disabled`. After the swap, prod should inherit the `.disabled` name.

```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker
ls .github/workflows/
# Expected active: free-scans-hourly.yml, recon-daily.yml, vaults.yml
# Expected disabled: morpho-scanner.yml.disabled, update.yml.disabled
```

If `update.yml` is still active, the swap missed something. Stop and investigate.

### 6.2 Wait for the next scheduled cron
The `free-scans-hourly` cron fires at `:15` every 2 hours. Check https://github.com/bubbamacxtxt-cyber/protocol-yield-tracker/actions 15 min past the next even hour to confirm it runs on its own.

### 6.3 Delete the `dev-source` remote (housekeeping)
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker
git remote remove dev-source
```

You can leave it if you plan to repeat the swap soon — it's harmless.

---

## Rollback

If anything breaks and the dashboard is serving wrong/broken data:

### Quick rollback (remote only)
```bash
cd /home/node/.openclaw/workspace/protocol-yield-tracker
DATE=<the date you ran the swap>
git push origin --force prod-archive-$DATE:main
```

Pages will rebuild from the archive in ~60s.

### Full rollback (remote + DB)
```bash
# After the above:
cp /home/node/.openclaw/workspace/prod-db-backup-$DATE.db \
   /home/node/.openclaw/workspace/protocol-yield-tracker/yield-tracker.db
cd /home/node/.openclaw/workspace/protocol-yield-tracker
git fetch origin && git reset --hard origin/main
```

The archived DB goes back into the local checkout; if you want the remote to have it too, commit and push.

---

## Things that will catch you next time

1. **Branch protection surprises.** GitHub may add new rules or enforce required reviews on admin after repo settings changes. Always verify 3.4 right before the swap.

2. **Scanner secret changes.** When new scanners are added to dev, they may require new secrets. 3.1 catches this, but only if you actually run the grep. Don't skip.

3. **Manual DB edits on prod.** If you ever hotfix the prod DB manually (not via a commit that also lands on dev), the next swap overwrites your fix. Land ALL fixes on dev first, then swap.

4. **Branch protection "require status checks" can block force push.** Even with force push enabled, required status checks will fail because dev's commits haven't run against prod's branch rules. Disable status check requirements before the swap if present.

5. **GitHub Actions bot's commit permissions.** If you rotate the repo's default push permissions or move to "Restrict who can push to matching branches," the bot account may lose write access. Easiest: whitelist `github-actions[bot]` explicitly.

6. **Archive branches accumulate.** Delete `prod-archive-*` branches older than ~30 days — they're cheap but clutter the branch list. `git push origin --delete prod-archive-OLD_DATE`.

---

## Cheat sheet (if you've done this before and just need the commands)

```bash
# 1. Archive
cd /home/node/.openclaw/workspace/protocol-yield-tracker
DATE=$(date -u +%Y-%m-%d)
git push origin main:prod-archive-$DATE
cp yield-tracker.db /home/node/.openclaw/workspace/prod-db-backup-$DATE.db

# 2. Swap
git remote add dev-source https://TOKEN@github.com/bubbamacxtxt-cyber/protocol-yield-tracker-dev.git 2>/dev/null
git fetch dev-source
git push origin dev-source/main:main --force
git fetch origin && git reset --hard origin/main

# 3. Trigger + watch (see step 5.1–5.2 for full polling loop)
curl -s -X POST -H "Authorization: token TOKEN" \
  "https://api.github.com/repos/bubbamacxtxt-cyber/protocol-yield-tracker/actions/workflows/free-scans-hourly.yml/dispatches" \
  -d '{"ref":"main"}'
```

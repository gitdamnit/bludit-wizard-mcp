# Study C — Genuinely Free Hosting Platforms

**Question:** is there a free third-party platform (or a hybrid) that can host this MCP server reliably at $0?

**First principle, verified in [CLOUDFLARE_FREE_ANALYSIS.md](./CLOUDFLARE_FREE_ANALYSIS.md):** *no* third-party
platform can run the current code. `@cloudflare/workers-oauth-provider` needs workerd and a KV namespace bound as
`OAUTH_KV`. Every option below therefore implies the **Node/Deno port** described in
[HOSTINGER_ANALYSIS.md § 3](./HOSTINGER_ANALYSIS.md#3-what-would-replace-each-cloudflare-piece). The comparison is
about *where the port runs* and *how much it costs to keep running*.

All facts read 2026-10-15/16 from vendor pricing/limit pages; links inline. "Permanent?" means the free tier is
documented as ongoing, not a promotional trial.

---

## Summary

| Platform | Permanent free? | Card required? | Surprise charge risk | Public HTTPS MCP | OAuth 2.1 + PATs | Where data lives | Sleeps? | Rework | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Oracle Always Free** | ✅ | ✅ (verification) | Low (no card charges; **reclamation**) | ✅ | ✅ (Node port) | SQLite/Postgres on VM | No (if not reclaimed) | High | **Best $0 dedicated host**, with idle-reclaim caveat |
| **Google Cloud Run** | ✅ | ✅ | **Medium** (billed overage, no auto-cutoff) | ✅ | ✅ (Node port) | Cloud SQL (paid) / external free PG / SQLite on no disk | Scale-to-zero (~1.2 s) | High | Strong but billing-gated |
| **Deno Deploy** | ✅ | ⚠️ to unlock full free limits | **None** (pauses) | ✅ | ⚠️ (OAuth lib port + Deno KV) | Deno KV / Postgres | Edge, no cold-start implied | High (Deno runtime) | Good if a port happens |
| **Railway** | ⚠️ ($1/mo credit) | ❌ for trial | Low but **credit runs out** | ⚠️ no custom domain on free | ✅ (Node port) | Railway PG (uses credit) | No (always-on consumes credit) | High | Not reliably $0 |
| **Koyeb** | ❌ (card + $29 hold; Pro $29 default) | ✅ | Medium | ⚠️ sleeps 1 h | ✅ (Node port) | free PG only 5 h/mo | **Yes, 1 h** | High | **Reject** |
| **Render** | ⚠️ web free, **DB expires 30 days** | ✅ | Low | ⚠️ sleeps 15 min / ~1 min wake | ✅ (Node port) | Free PG deleted at day 44 | **Yes, 15 min** | High | **Reject for data** |
| **Vercel** | ✅ but **non-commercial only** | ❌ | Pauses at cap | ⚠️ serverless, no persistent AS | ✅ (function port) | External only (Neon etc.) | Serverless | High | **Reject** (license + no server) |
| **Netlify** | ✅ (300 credits ≈ 15 GB) | ❌ | Pauses at cap | ⚠️ functions | ✅ (function port) | External only | Serverless | High | **Reject** (no DB, credits) |
| **Supabase** | ✅ (DB only) | ❌ | None | n/a (DB) | n/a | 500 MB Postgres | **Pauses after 7 d idle** | DB adapter | **DB only**, keep-alive required |
| **Fly.io** | ❌ (no free tier since 2024) | ✅ | — | — | — | — | — | — | **Reject** |
| **Back4App Containers** | ✅ 1 container (256 MB) | ❌ | Low | ✅ | ✅ (Node port) | External DB needed | TBD | High | Marginal |
| **Desktop + Cloudflare Tunnel** | ✅ (uses existing CF account) | ❌ | None | ✅ stable hostname | ✅ (Node port) | local SQLite | No sleep (if desktop on) | High (port) | **Best true-$0**, needs 24/7 desktop |

Legend: ✅ yes/works · ⚠️ qualified · ❌ no.

---

## Platform detail (12 criteria)

For each: ① permanent? ② card needed? ③ surprise charges? ④ public HTTPS MCP? ⑤ OAuth 2.1 + PATs? ⑥ data location?
⑦ real persistent storage? ⑧ sleeps? ⑨ resource limits adequate? ⑩ rewrite needed? ⑪ secure deploy/backups/rotation?
⑫ viable with several users + many sites?

### Oracle Cloud Always Free
① Permanent "Always Free", not a trial. ② Credit card required for signup verification. ③ No usage billing on Always
Free resources, but **idle reclamation**: an instance is reclaimable if, over 7 days, **95th-percentile CPU < 20 %,
network < 20 %, and memory < 20 %** (A1 shapes) — a low-traffic MCP server **matches all three and is a reclamation
candidate**. ④ Yes (public IPv4 + TLS via Caddy/Let's Encrypt). ⑤ Yes with the Node port. ⑥ SQLite or Postgres on the
VM's 200 GB block storage — fully persistent and **local** (fast, no network DB). ⑦ Yes — real disk. ⑧ No sleep.
⑨ Generous: 2 AMD micro VMs **plus** 2 OCPU / 12 GB ARM (halved from 4/24 on 2026-06-15), 10 TB/month egress.
⑩ Rewrite required (no workerd/D1/KV). ⑪ You own patching, backups, secrets, TLS renewal. ⑫ Yes, comfortably, if not
reclaimed.
Sources: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>,
Notable risk: idle reclamation (documented) + "out of host capacity" at provisioning.

### Google Cloud Run
① Always Free, permanent (monthly reset). ② Billing account + card required. ③ **Yes** — overage is billed at standard
rates and there is **no automatic cutoff** unless you configure it; budget alerts/hard limits are recommended.
④ Yes (custom domain mapping). ⑤ Yes with the Node port. ⑥ Needs a store: Cloud SQL is **paid**; use an external free
Postgres (Neon/Supabase) or ship SQLite (but Cloud Run has **no persistent local disk**). ⑦ No local persistence by
default. ⑧ Scale-to-zero, ~1.2 s cold start. ⑨ 2 M requests, 180 k vCPU-s, 360 k GiB-s/month — ample. ⑩ Rewrite
required. ⑪ Managed platform, but secrets/backups are yours. ⑫ Yes, with an external DB.
Sources: <https://cloud.google.com/run/pricing>, <https://docs.cloud.google.com/run/docs/configuring/billing-settings>.

### Deno Deploy
① Permanent free plan. ② **Card required to unlock full free limits** ("restricted Free plan limits until you verify
your organization by linking a credit card"). ③ **No** — free orgs that exceed requests/CPU/memory are **paused** until
the next cycle (no surprise bill). ④ Yes. ⑤ OAuth 2.1/PATs must be re-implemented for Deno (the Cloudflare provider
cannot run); Deno KV/cron/Postgres available. ⑥ Deno KV (1 GiB, 1 M reads, 500 k writes/month) or Postgres integration.
⑦ Yes (managed). ⑧ Edge platform, no VM to sleep. ⑨ 1 M requests/month, **10 CPU-hours/month** (pricing page; the GA
blog quoted 15), 10 cron jobs. ⑩ Rewrite required (different runtime + KV API). ⑪ Managed; secrets via dashboard.
⑫ Yes within limits.
Sources: <https://deno.com/deploy/pricing>, <https://docs.deno.com/deploy/reference/cron/>, Deno Deploy GA blog (2026-02-03).
Note: 10 CPU-hours/month is the binding compute limit; MCP requests are cheap CPU, so 1 M requests/month is binding.

### Railway
① Free **plan** exists but is **$1 of credit/month** after a 30-day $5 trial — credit-based, not a capacity tier.
② No card for the trial. ③ Low, but the **credit runs out** and services stop. ④ **No custom domain on the free
plan.** ⑤ Node port possible. ⑥ Railway Postgres consumes the same $1 credit. ⑦ Volume storage only within credit.
⑧ Always-on by default, which is exactly what burns the $1 credit. ⑨ 1 vCPU / 0.5 GB per service, 1 project, 3 services.
⑩ Rewrite. ⑪ Managed. ⑫ Not on $1/month.
Source: <https://docs.railway.com/> pricing pages, read 2026-10-16.

### Koyeb — reject
The card-free Hobby plan was removed in **Feb 2026**; new accounts require a card with a **$29 pre-authorisation hold**
and default to the **$29/month Pro** plan. The 512 MB / 0.1 vCPU free instance **sleeps after 1 hour**, has no volumes,
and the accompanying free Postgres is limited to **5 active hours/month** — unusable as a database. Source:
<https://www.koyeb.com/docs/faqs/pricing>.

### Render — reject for data
Free web services **spin down after 15 minutes** of inactivity and take about **a minute** to wake; 750 instance
hours/month. Critically, **free Postgres expires 30 days after creation and is deleted after a 14-day grace period**,
with **no backups**. Render's own docs say not to use free instances for production. Source:
<https://render.com/docs/free>.

### Vercel — reject
Hobby is free but **"non-commercial, personal use only"**; a service used for anyone's financial gain requires Pro at
$20/seat. Functions are serverless (no persistent authorization-server state) and Hobby has 1 M invocations / 4 CPU-hrs.
Source: <https://vercel.com/docs/plans/hobby>.

### Netlify — reject
Free plan is **300 credits/month** (bandwidth re-priced to 20 credits/GB in Apr 2026 ⇒ ≈15 GB), spent across deploys,
compute and requests, with **no database**. Source: Netlify pricing, read 2026-10-16.

### Supabase — DB only, conditional
Free Postgres (500 MB, 2 active projects) is genuinely useful **as a database**, but free projects are **paused after
7 days of low activity** and require a **manual dashboard resume**. For an unattended OAuth server whose DB holds
grants, sites and credentials, a paused DB is an outage. Mitigation: a few daily queries keep it from pausing (and the
app itself would query it), but any quiet week risks a manual intervention. Source:
<https://supabase.com/docs/guides/platform/free-project-pausing>, <https://supabase.com/pricing>.

### Fly.io — reject
No free tier for new accounts since **2024-10-07**; a short trial then pay-as-you-go. Source:
<https://fly.io/docs/about/pricing/>.

### Back4App Containers — marginal
One free 256 MB container, no card. Workable only with an external database and 256 MB is tight. Mentioned for
completeness; not recommended.

### Desktop + Cloudflare Tunnel (hybrid) — the true-$0 always-on option
① Yes — Cloudflare Tunnel is free and the account/domain are already in use. ② No card beyond an existing Cloudflare
account. ③ None. ④ Yes — a **stable public hostname on a domain already on Cloudflare**, with WAF/CDN/DDoS in front.
Use a *named* tunnel, not a Quick Tunnel (`trycloudflare.com` is temporary, caps at 200 in-flight requests, and does
not support SSE). ⑤ Node port on the desktop; or self-host workerd (see below). ⑥ **Local SQLite** — persistent, fast,
no network DB, easy backups. ⑦ Yes. ⑧ **No sleep** as long as the desktop is on. ⑨ Bounded by the desktop; plenty for
this workload. ⑩ Rewrite required (or self-host workerd). ⑪ You own patching/backups/TLS (TLS is terminated by
Cloudflare; origin can be HTTP behind the tunnel). ⑫ Yes for a personal/small deployment.
Sources: <https://developers.cloudflare.com/tunnel/get-started/>, <https://developers.cloudflare.com/tunnel/concepts/routing/>.

> **workerd self-hosting note (honest caveat):** running Cloudflare's open-source `workerd` locally would let the
> *existing* code run, but standalone `workerd` does not provide D1/KV — those would be emulated locally (as the test
> harness does, via Miniflare persistence), which is a development mechanism, not a supported production datastore. So
> even the desktop path realistically needs the Node port. Do not represent "run the Workers code unchanged on the
> desktop" as production-grade.

---

## Hybrid architectures

Only hybrids that reduce cost/complexity **without weakening security** were considered:

1. **Compute on a free host + Postgres on Supabase/Neon (free), TLS via the host.** Reduces dependence on any one
   platform's ephemeral storage, but adds a network hop and a second vendor's pause/expiry risk. Acceptable only if the
   DB provider does not pause (Neon scale-to-zero wakes automatically; Supabase pauses with manual resume — prefer
   Neon for "wakes without a human").
2. **Cloudflare Workers (Free) for the MCP resource server + the Node/other host for the authorization server.** This
   keeps half the code on Cloudflare but splits the trust path over a network call, contradicts the current private
   Service-Binding design, and still hits the Free KV problem on the auth side. Rejected as complexity without benefit.
3. **Desktop + Tunnel for OAuth, free platform for the MCP resource server.** Two runtimes, two failure domains, and
   the desktop is on the critical auth path. Rejected.

No hybrid meaningfully helps: the port is the cost, and where the port runs is a separate, simpler decision.

---

## Conclusion for Study C

- **Truly free and permanent with adequate resources:** Oracle Always Free, Google Cloud Run, Deno Deploy, and the
  desktop + Cloudflare Tunnel. Of these, only the **desktop + Tunnel** avoids both a credit card and idle reclamation,
  and only **Oracle** gives a real always-on server without a card *charge* (but with a card *check* and reclaim risk).
- **Rejected:** Koyeb, Render (data), Vercel, Netlify, Fly.io, Railway (as reliably $0), Back4App (marginal).
- **Supabase/Neon:** useful only as an external database, not as the host.

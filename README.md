# Operations Monitor

One dashboard and one Joule agent over two existing monitors on SAP BTP:

- **IDoc Monitor** (`idoc-monitor-srv`): IDocs from SAP Cloud ALM Integration & Exception Monitoring. **Not changed.**
- **Job Failure Monitor** (`JOB_Failure_Dashboard`): failed S/4HANA Cloud application jobs from SAP Cloud ALM Job & Automation Monitoring.

The Operations Monitor stores no data. It is a thin app that asks both monitors as the logged-in user and merges the answers.

**Dashboard:** https://operations-monitor.cfapps.eu20-001.hana.ondemand.com/
**Agent card:** https://operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com/.well-known/agent-card.json

---

## 1. Why this design

| Option | Verdict |
|---|---|
| Group both apps as tiles in SAP Build Work Zone | No code, but still two dashboards side by side |
| UI mashup calling both OData services from the browser | Logins don't carry across two XSUAA apps; no Joule |
| **Aggregator app + orchestrator agent (chosen)** | One consistent view, one Joule entry point, both monitors stay independent |
| Merge into one app | Couples two syncs, schemas and deployments; large rewrite |

Two channels, each used for what it is good at:

| Channel | Used for | Why |
|---|---|---|
| **OData** (`getKpis`, `getTrend`, `getTopErrors`, entity lists) | The unified dashboard | Fast, filterable, pageable; charts need this |
| **A2A** (`message/send`) | Joule questions, via the orchestrator | Agents answer in the same shape (`parts[0].text` + `parts[1].data`); the orchestrator asks both and merges |

The dashboard is never built on A2A: A2A answers are messages, not query results, and take seconds per call.

## 1a. Benefits of this approach

| Benefit | What it means in practice |
|---|---|
| **One place to look** | Operations, AMS and business users see IDoc errors and job failures together: one set of tiles, one trend, one failure list, one "Pull from Cloud ALM". |
| **One Joule entry point** | "How are my integrations and jobs today?" is answered by one agent. Users do not need to know that two agents exist. |
| **Existing monitors untouched** | The IDoc Monitor is not changed at all; the Job Monitor only grants a scope. Each keeps its own sync, HANA, roles and release cycle. |
| **No data duplication** | The Operations Monitor stores nothing. It reads the monitors' HANA-backed APIs, so numbers are always identical to the source dashboards and never stale copies. |
| **Deterministic figures** | Sums and merges only; no LLM computes a number. The Joule answer and the dashboard show the same values. |
| **Security stays with the owner** | The caller's own identity is forwarded (XSUAA user token exchange / IAS token). Each monitor still enforces its own role collections. A user with only the job role sees job data and an "unavailable" marker for IDocs. |
| **Fails soft** | If one monitor is down or refuses, the other still shows; the missing one is marked, not hidden. |
| **Extensible** | A third monitor (e.g. interfaces, workflows) is one more client in `srv/backends.js` plus one branch in the orchestrator; dashboard and agent stay the same. |
| **Drill-down preserved** | Each failure row links to the detail page in the original monitor (IDoc object page / job run with job log and AI analysis). |

Trade-offs to be aware of: one more app to run and monitor; dashboard latency is the slower of the two monitors (both are called in parallel); and a user needs a role in each monitor to see its data.

## 2. Architecture

```
                         SAP Joule
                            │ A2A message/send (IAS user token, groups)
                            ▼
   ┌───────────── Operations Monitor (this app) ──────────────────────┐
   │ operations-monitor-router  (approuter, XSUAA login)               │
   │ operations-monitor-srv     (CAP Node.js)                          │
   │   ├─ /odata/v4/ops   aggregation service   ── user token exchange │
   │   ├─ Fiori dashboard  /ops-monitor/webapp                         │
   │   └─ /a2a            orchestrator agent (@a2a-js/sdk 0.3.14, IAS) │
   └──────────┬──────────────────────────────────────┬────────────────┘
       OData  │ dest IDOC_MONITOR_API         OData   │ dest JOB_MONITOR_API
              │ (OAuth2UserTokenExchange)     A2A     │ dest JOB_MONITOR_A2A (caller IAS token forwarded)
              ▼                                       ▼
      IDoc Monitor (unchanged)                 Job Failure Monitor
      /odata/v4/monitor                        /odata/v4/job-monitor  +  /a2a
      own HANA, own 60 s sync                  own HANA, own 60 s sync
              └──────────── both read SAP Cloud ALM ───────────┘
```

**Security model: the user's own identity is forwarded.** A technical client cannot read either monitor (both answer 403 to client-credentials tokens), so the dashboard exchanges the caller's XSUAA token for one of each monitor's XSUAA (`OAuth2UserTokenExchange` destinations). Each monitor keeps enforcing its own role collections. A user with only the job role sees job data and an "unavailable" marker for IDocs. The orchestrator forwards the caller's IAS token to the Job Monitor agent the same way.

Because the IDoc Monitor is unchanged and has no A2A endpoint, the orchestrator reads it through its OData functions and renders the same report shape the Job Monitor agent returns.

## 3. Dashboard (Fiori Elements, FPM custom page, same look as both monitors)

- **Header:** per-source sync status (IDoc / Job), period 1h / 24h / 7 days / 30 days (`?period=` preselects), auto-refresh 30 s, refresh, **Pull from Cloud ALM** (triggers `syncNow` on both monitors; the IDoc one requires its Admin role).
- **Tiles:** Total failures · IDoc errors · Job failures · Successful (with success rate) · Warnings · In Process. The first three filter the failure list.
- **Charts:** failures over time stacked by source; failures by message type / job (top 15, failures first).
- **Top errors** across both monitors with a Source column.
- **Failure list:** Source, Object (IDoc number / job name), Type, Error reason, System, Partner / Scheduled by, Time; source filter (All / IDocs / Jobs) and search. Clicking a row opens the detail page in the original monitor (IDoc object page or job run page) in a new tab, so both existing dashboards remain the drill-downs.

### OData service `/odata/v4/ops` (`srv/ops-service.cds`)

| Operation | Returns |
|---|---|
| `getOverview(period)` | summed counts, success rate, `idocErrors`, `jobErrors`, per-source status (available, last sync, dashboard link) |
| `getTrend(period)` | per bucket: `idocError`, `jobError`, `idocSuccess`, `jobSuccess`, `idocWarning`, `jobWarning` |
| `getCategories(period)` | top 15 message types / jobs with success/warning/error |
| `getTopErrors(period)` | top 15 errors across both, with source |
| `getFailures(period, top)` | merged failure rows (newest first) + list of unavailable sources |
| `syncAll()` | result of `syncNow` on each monitor |

Both monitors use identical period codes and time-bucket keys, so merging is by key with no estimation.

## 4. Orchestrator agent (`srv/a2a/`)

- Protocol 0.3.0, JSON-RPC `message/send`, no streaming. Agent card is public and holds no data.
- **Auth:** IAS token issued by `https://a21ttncfv.accounts.ondemand.com` for the IAS app **"Operations Monitor A2A Agent"** (client ID `cbbf003a-5e27-490d-b45b-e72abbb8a194`). Technical tokens and users without one of the groups `OpsMonitor_Viewer`, `JobMonitor_Viewer`, `IDocMonitor_Viewer`, `JobMonitor_Admin`, `IDocMonitor_Admin` get a `rejected` task; no data is read.
- **Routing:** "IDoc / interface / integration" → IDoc only; "job / batch / schedule" → jobs only; otherwise both. Period from the question (1H, 24H default, 7D, 30D).
- **Fan-out:** Job Monitor via A2A (caller token forwarded), IDoc Monitor via OData, in parallel, 20 s each.
- **Answer:** one Markdown text (headline total, one section per monitor, link to this dashboard with the period) plus `data` (`type: operations_report`, `targets`, `totalFailed`, `idoc`, `job`, `dashboardUrl`, `markdownTable`). A monitor that fails or refuses shows as "Unavailable" / "Not authorized" in its section while the other still answers.
- `npm test`: 6 tests (routing, card, viewer, job-only group, no group, technical/wrong audience/no token).

## 5. BTP resources (org BearingPointGmbH_sap-genai, space GenAI, eu20-001)

| Resource | Name |
|---|---|
| Backend | `operations-monitor-srv` → `operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com` |
| Approuter (URL users open) | `operations-monitor-router` → `operations-monitor.cfapps.eu20-001.hana.ondemand.com` |
| XSUAA | `operations-monitor-xsuaa` (role collection `OpsMonitor_Viewer`) |
| Destination service | `operations-monitor-destination` with `IDOC_MONITOR_API`, `JOB_MONITOR_API`, `JOB_MONITOR_A2A` (created by `scripts/create-destinations.ps1`) |
| IAS | `operations-monitor-identity` → IAS app "Operations Monitor A2A Agent" |
| Service keys used by the destinations | `idoc-monitor-auth/ops-monitor-link`, `cloud-alm-job-monitor-xsuaa/ops-monitor-link`, `operations-monitor-destination/ops-admin-key` |

All apps run on `cflinuxfs5`.

## 6. Build and deploy

```powershell
npm install
npm test
cf push                       # backend (serves the Fiori app from app/)
cd approuter; cf push -f manifest.yml; cd ..
powershell -File scripts/create-destinations.ps1   # once, or to update the destinations
```

`manifest.yml` carries all settings (destination names, dashboard URLs, IAS issuer/audience, required groups).

## 7. Steps done by the implementation

1. Scaffolded the CAP app in `Operations-Monitor` with user-token clients for both monitors.
2. Built the aggregation service (overview, trend, categories, top errors, failures, syncAll).
3. Built the unified Fiori dashboard.
4. Built the orchestrator A2A agent with IAS login and tests.
5. Created XSUAA, Destination and IAS instances; deployed backend and approuter on clean routes.
6. Created the three destinations with user token exchange.
7. Verified: health 200, agent card 200, `/a2a` and OData refuse calls without login (401), dashboard reachable behind login.

## 8. Steps for you (cannot be done from the CLI)

1. **Role collections.** Users with `JobMonitor_Viewer` or `JobFailureMonitor_Viewer` can already open this dashboard (the Job Monitor grants its `User` scope to this app; see `foreign-scope-references`). Alternatively add users to `OpsMonitor_Viewer`. You must also hold a role in each monitor you want to see: `JobMonitor_Viewer` (or `JobFailureMonitor_Viewer`) and the IDoc Monitor's viewer collection. Without the IDoc role the dashboard shows "You are not authorized in the IDoc Monitor" for that source.
2. **Open** https://operations-monitor.cfapps.eu20-001.hana.ondemand.com/ in a private window and check that both sources show data.
3. **IAS groups** (for Joule): in IAS `a21ttncfv` create the group `OpsMonitor_Viewer` (or reuse `JobMonitor_Viewer` / `IDocMonitor_Viewer`) and add the users. Map each group to the BTP role collection of the same name (Security → Trust Configuration → IAS → Role Collection Mappings).
4. **IAS proxy dependency** so Joule can call the agent with a user token: in IAS, on the Joule application add a dependency to "Operations Monitor A2A Agent" (API `operations-read`), the same way the PO Monitor agent was wired.
5. **Joule destination** in the Joule subaccount: name `operations_monitor_agent_a2a`, URL `https://operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com`, Authentication `OAuth2JWTBearer` (IAS, token exchange for the user), like `po_monitor_agent_a2a`.
6. **Joule capability** in Joule Studio: scenario "Operations Monitor: failed IDocs and jobs", function with `agent-request` to `system_alias: operations_monitor_agent_a2a`, `path: /a2a`, showing `artifacts[0].parts[0].text` and, when `hasFailures`, `parts[1].data.markdownTable`. Deploy with `joule deploy`.

## 9. Project structure

```
app/ops-monitor/webapp/        Fiori app (manifest, Component, ext/main custom page)
approuter/                     Approuter (xs-app.json, manifest.yml)
scripts/create-destinations.ps1  Creates the three destinations from service keys
srv/backends.js                Clients for both monitors (user token exchange)
srv/aggregate.js               Deterministic merge of both monitors
srv/ops-service.cds|js         OData aggregation service
srv/a2a/auth.js                IAS token validation + group check
srv/a2a/orchestrator.js        Routing, fan-out (A2A + OData), merge
srv/a2a/index.js               Agent card, executor, Express mount
server.js                      Bootstrap: redirects, /health, A2A mount
test/orchestrator.test.js      Agent and routing tests
manifest.yml, xs-security.json, ias-a2a.json
```

## 10. SAP Joule setup (step by step)

Goal: a user asks Joule "How many IDocs and jobs failed today?" and gets one combined answer with a link to this dashboard. Pattern identical to the PO Monitor agent (`po_monitor_agent_a2a`).

**A. Identity (IAS tenant `a21ttncfv`)**
1. Groups: create `OpsMonitor_Viewer` (and optionally reuse `JobMonitor_Viewer` / `IDocMonitor_Viewer`). Add the users who may ask Joule. These groups arrive in the token's `groups` claim and are checked by the agent.
2. Application "Operations Monitor A2A Agent" already exists (created by the `operations-monitor-identity` service instance, client ID `cbbf003a-5e27-490d-b45b-e72abbb8a194`, provided API `operations-read`).
3. Proxy chain: on the **Joule** IAS application (or its `Joule_A2A_Proxy`), add a **dependency** to "Operations Monitor A2A Agent" with API `operations-read`. This lets Joule exchange the user's token for one whose audience is the agent.

**B. BTP, Joule subaccount (`sap-joule-embedded-...`)**
4. Destination `operations_monitor_agent_a2a`:
   - URL `https://operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com`, Proxy `Internet`
   - Authentication `OAuth2JWTBearer`, token service = IAS (`https://a21ttncfv.accounts.ondemand.com/oauth2/token`), client ID/secret of the Joule proxy app, the same values used by `po_monitor_agent_a2a`
   - Additional property `HTML5.DynamicDestination=true` if the Joule capability requires it

**C. Joule Studio (capability)**
5. Create a capability "Operations Monitor" with scenario "Failed IDocs and jobs", example utterances: "How are my integrations and jobs today?", "How many IDocs failed this week?", "Which jobs failed in the last hour?".
6. Add a function with an `agent-request` step: `system_alias: operations_monitor_agent_a2a`, `path: /a2a`, method `message/send`, pass the user's utterance as the text part.
7. Render the answer: show `body['artifacts'][0]['parts'][0]['text']` as a Markdown message; if `body['artifacts'][0]['parts'][1]['data']['hasFailures']` show `['markdownTable']` as a second message. Failed/rejected tasks also carry a text artifact, so the same expression works.
8. `joule deploy`, then test in the Joule chat panel.

**D. Verify**
- A user in `OpsMonitor_Viewer` gets a combined answer; a user without a group gets "You are not authorized to view operations data".
- Agent logs show `a2a-auth-accepted` and `a2a-orchestration-complete` (no personal data is logged).

## 11. SAP Build Work Zone (optional launchpad)

Work Zone gives users one page with all three dashboards. It is optional; the Operations Monitor already works through its own URL.

1. Subscribe to **SAP Build Work Zone, standard edition** in subaccount `sap-genai` and assign `Launchpad_Admin` to yourself.
2. Create a **content provider** for the Cloud Foundry apps, or add each dashboard as a **URL app** in Content Manager:
   - Operations Monitor: `https://operations-monitor.cfapps.eu20-001.hana.ondemand.com/`
   - Job Failure Monitor: `https://job-failure-monitor.cfapps.eu20-001.hana.ondemand.com/`
   - IDoc Monitor: `https://bearingpointgmbh-sap-genai-genai-idoc-monitor.cfapps.eu20-001.hana.ondemand.com/`
3. Create a **group** "Operations" and a **catalog** containing the three apps; assign the catalog to a **role** (e.g. `OpsMonitor_Viewer`) and the role to the users' role collections.
4. Create a **page/space** "Operations" with the three tiles; optionally a **card** per monitor showing the error count (Work Zone cards can call `getOverview` / `getKpis` with `period='24H'`).
5. Enable **Joule in Work Zone** so the chat panel is available on the same page as the dashboards.

Single sign-on: all three apps use XSUAA with the same subaccount trust (IAS), so a Work Zone user logs in once.

## 12. Change history

1. Scaffolded the Operations Monitor, aggregation service, Fiori dashboard, orchestrator agent, BTP services and destinations.
2. Job Monitor grants its `User` scope to this app, so `JobMonitor_Viewer` / `JobFailureMonitor_Viewer` users can open the dashboard without a new role.
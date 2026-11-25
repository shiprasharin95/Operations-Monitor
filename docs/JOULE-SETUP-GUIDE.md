# Operations Monitor in Joule: step-by-step setup guide

Goal: a user opens SAP Build Work Zone, clicks the Joule icon, asks
"How are my integrations and jobs today?" and gets one combined answer
(IDoc errors + job failures) with a link to the Operations Monitor dashboard.

This guide assumes you are new to BTP and Joule. It is written for the
BearingPoint landscape used by this project:

| Item | Value |
|---|---|
| Global account | BearingPoint GmbH - TDD / Main Global Acct |
| Subaccount with the apps | `SAP GenAI` (CF org `BearingPointGmbH_sap-genai`, space `GenAI`, region eu20-001) |
| IAS tenant | `https://a21ttncfv.accounts.ondemand.com` |
| Agent backend | `https://operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com` |
| Agent endpoint | `/a2a` (JSON-RPC, A2A protocol 0.3.0) |
| Agent card | `https://operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com/.well-known/agent-card.json` |
| Dashboard | `https://operations-monitor.cfapps.eu20-001.hana.ondemand.com/` |
| IAS application of the agent | "Operations Monitor A2A Agent", client ID `cbbf003a-5e27-490d-b45b-e72abbb8a194`, API `operations-read` |
| IAS groups accepted by the agent | `OpsMonitor_Viewer`, `JobMonitor_Viewer`, `IDocMonitor_Viewer`, `JobMonitor_Admin`, `IDocMonitor_Admin` |
| Existing reference agent (same pattern) | PO Monitor, Joule destination `po_monitor_agent_a2a` |

---

## 0. Vocabulary (read this first)

| Term | What it means in plain words |
|---|---|
| **BTP cockpit** | The web admin console for SAP BTP: `https://emea.cockpit.btp.cloud.sap`. Everything below starts here. |
| **Global account / Subaccount** | A global account is the contract; subaccounts are isolated environments inside it. Services are subscribed per subaccount. |
| **Entitlement** | Permission for a subaccount to use a service. Without an entitlement you cannot subscribe. |
| **Subscription** | A SaaS service switched on in a subaccount (e.g. Joule, Work Zone, SAP Build). Listed under *Instances and Subscriptions*. |
| **Booster** | A wizard in the cockpit that performs a multi-step setup for you (entitlements, subscriptions, trust, roles). |
| **IAS** | SAP Cloud Identity Services - Identity Authentication. The login service. Users and groups live here. |
| **Trust configuration** | The link between a subaccount and IAS. Joule requires the *OpenID Connect* type. |
| **Role collection** | A bundle of permissions in BTP assigned to users (e.g. `Joule_End_User`). |
| **Destination** | A named connection (URL + credentials) stored in BTP. Joule uses one to reach your agent. |
| **Joule** | The chat assistant. One subscription per subaccount; it is the *runtime*. |
| **Joule Studio** | The low-code *design tool* inside SAP Build Process Automation to create skills. |
| **Joule CLI** | Command-line alternative to Joule Studio (`joule deploy`). Used for the PO Monitor. |
| **Skill / capability** | A unit of behaviour in Joule: example sentences + what to call + how to show the answer. |
| **A2A agent** | Your backend (`/a2a`) that answers in the Agent-to-Agent protocol. Joule calls it with an `agent-request`. |
| **Work Zone** | SAP Build Work Zone, standard edition: the launchpad with tiles. Joule can be shown in its header. |

The flow you are building:

```
User in Work Zone ──> Joule chat ──> skill "Operations Monitor" ──> destination operations_monitor_agent_a2a
                                                                          │ (user's IAS token, exchanged)
                                                                          ▼
                                                   operations-monitor-srv  /a2a  (orchestrator)
                                                            │                     │
                                                 IDoc Monitor (OData)     Job Monitor (A2A)
```

---

## 1. Prerequisites and permissions

### 1.1 Your BTP user

1. Open `https://emea.cockpit.btp.cloud.sap` and log in with your BearingPoint account.
2. Open global account *BearingPoint GmbH - TDD* and subaccount *SAP GenAI*.
3. Check the left menu. You need to see **Security**, **Entitlements** and **Boosters**.
   If the subaccount title shows `[Restricted]` or those items are missing, you have a viewer role.
   Ask a global account administrator (one of the Org Members, e.g. an Org Manager) to assign you:
   - `Subaccount Administrator` on *SAP GenAI*
   - `Subaccount Administrator` on the subaccount where Joule is subscribed (if different, see 1.3)

Nothing below works without this.

### 1.2 Check the trust configuration

1. Subaccount *SAP GenAI* → **Security → Trust Configuration**.
2. There must be an entry for IAS tenant `a21ttncfv.accounts.ondemand.com`.
3. Its **Protocol** column must read **OpenID Connect**. If it reads *SAML*, Joule will not work:
   - Click **Establish Trust**, choose the tenant `a21ttncfv`, keep OpenID Connect, confirm.
   - Keep the old SAML entry disabled or delete it only after confirming logins still work.

### 1.3 Find where Joule and SAP Build are subscribed

1. Subaccount *SAP GenAI* → **Services → Instances and Subscriptions** → tab/section **Subscriptions**.
2. Look for these three rows:
   - **Joule**
   - **SAP Build Process Automation** (this contains Joule Studio)
   - **SAP Build Work Zone, standard edition**
3. If **Joule** is not in *SAP GenAI*: go back to the global account (breadcrumb at the top),
   open **Subaccounts**, and open the one named like `sap-joule-embedded-...`. That is the "Joule subaccount".
   Everything in sections 3 and 4 is done there.
4. Rule: the Joule subaccount and the Work Zone subaccount must both trust the **same** IAS tenant `a21ttncfv`.
   Check section 1.2 in both.

### 1.4 If something is missing: entitlements and subscriptions

Only do this if a row from 1.3 is absent.

1. Subaccount → **Entitlements → Edit → Add Service Plans**.
2. Search and tick:
   - `Joule` (plan `default`/`standard`)
   - `SAP Build Process Automation` (plan `standard` or `build_default`)
   - `SAP Build Work Zone, standard edition` (plan `standard`)
3. **Add → Save**. If a service cannot be added, the global account has no quota; a global account admin must assign it under *Global account → Entitlements → Entity Assignments*.
4. **Services → Service Marketplace** → open each service → **Create** → plan as above → **Create**. Wait until the status is *Subscribed*.

---

## 2. Identity setup in IAS (groups and the proxy dependency)

Why: the agent accepts only IAS tokens whose `groups` claim contains one of the allowed groups, and Joule can only obtain such a token if its IAS application is allowed to call the agent's IAS application.

### 2.1 Open the IAS admin console

1. URL: `https://a21ttncfv.accounts.ondemand.com/admin`
2. If you cannot log in, ask the IAS administrator for the **Administrator** role in this tenant.

### 2.2 Create the user group

1. **Users & Authorizations → User Groups → Create**.
2. Name: `OpsMonitor_Viewer`. Display name: `Operations Monitor Viewer`. **Save**.
3. Open the group → **Add** → select the users who may ask Joule about operations (include yourself).

Note: users already in `JobMonitor_Viewer` or `IDocMonitor_Viewer` are accepted by the agent as well, but `OpsMonitor_Viewer` is the clean choice.

### 2.3 Verify the agent's IAS application exists

1. **Applications & Resources → Applications**.
2. Search for **Operations Monitor A2A Agent**. It was created automatically by the BTP service instance `operations-monitor-identity`.
3. Open it → **Client ID** should be `cbbf003a-5e27-490d-b45b-e72abbb8a194`.
4. Open **Provided APIs**; there must be an API named `operations-read`. If it is missing, add it:
   **Provided APIs → Add → Name `operations-read`** → Save (this must match `ias-a2a.json` in the project).

### 2.4 Add the proxy dependency on the Joule application

This is the step that lets Joule exchange the user's token for one addressed to your agent.

1. **Applications & Resources → Applications** → find the application that belongs to Joule.
   It is usually named **Joule** or `Joule_A2A_Proxy` (open the PO Monitor destination in step 3.2 later: its client ID tells you which IAS app it is).
2. Open it → **Dependencies** (under *Trust* / *Application APIs*) → **Add**.
3. Fields:
   - Dependency name: `operations-monitor` (free text, lowercase, no spaces; note it, Joule may ask for it)
   - Application: **Operations Monitor A2A Agent**
   - API: `operations-read`
4. **Save**.

### 2.5 Map the IAS group to BTP role collections (dashboard access)

This makes the same users able to open the dashboard behind Work Zone.

1. BTP cockpit → subaccount *SAP GenAI* → **Security → Trust Configuration** → click the IAS entry → **Role Collection Mappings → New Mapping**.
2. Role collection `OpsMonitor_Viewer`, attribute `Groups`, operator `equals`, value `OpsMonitor_Viewer`. **Save**.
3. Repeat for `Joule_End_User` ← group `OpsMonitor_Viewer` (role collection exists after the booster in section 4.1; come back if it is not there yet).
4. The users also need a role in each source monitor to see its data: `JobMonitor_Viewer` (or `JobFailureMonitor_Viewer`) and the IDoc Monitor viewer collection. Map them the same way or assign them directly under **Security → Users**.

---

## 3. Connect Joule to the agent (destination in the Joule subaccount)

Do this in the subaccount where **Joule** is subscribed (section 1.3).

### 3.1 Get the credentials from the existing PO Monitor destination

1. Joule subaccount → **Connectivity → Destinations**.
2. Open `po_monitor_agent_a2a` and note:
   - **Token Service URL** (should be `https://a21ttncfv.accounts.ondemand.com/oauth2/token`)
   - **Client ID** (this is the Joule IAS application from step 2.4)
   - Any **Additional Properties**
   The client secret is hidden; get it from the person who created `po_monitor_agent_a2a` or from the IAS application (**Client Authentication → Secrets**; you can add a new secret there if needed).

### 3.2 Create the destination for the Operations Monitor

1. **Connectivity → Destinations → Create Destination** and fill in:

| Field | Value |
|---|---|
| Name | `operations_monitor_agent_a2a` |
| Type | `HTTP` |
| URL | `https://operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com` |
| Proxy Type | `Internet` |
| Authentication | `OAuth2JWTBearer` |
| Token Service URL Type | `Dedicated` |
| Token Service URL | `https://a21ttncfv.accounts.ondemand.com/oauth2/token` |
| Client ID | same as in `po_monitor_agent_a2a` |
| Client Secret | the secret of that IAS application |

2. **Additional Properties** (click *New Property*): copy whatever `po_monitor_agent_a2a` has. Typical values:
   - `HTML5.DynamicDestination` = `true`
   - If the PO destination has a property with the IAS dependency name (e.g. `resource` or `assertion.audience`), set the same key with the value from step 2.4 (`operations-monitor`) or the agent's client ID.
3. **Save**, then **Check Connection**. A `401` or `403` here is normal (the check sends no user token); only a DNS/connection error means the URL is wrong.

### 3.3 Sanity check from the browser

Open `https://operations-monitor-srv.cfapps.eu20-001.hana.ondemand.com/.well-known/agent-card.json`.
You must see a JSON document with `"name": "Operations Monitor Agent"`. If not, the backend is down: see section 7.

---

## 4. Enable Joule and SAP Build in the subaccount (booster)

### 4.1 Run the Joule booster

1. Joule subaccount → **Boosters** (left menu, below *Entitlements*).
2. Search **Joule** → open **"Set Up Joule"** (or **"Setting Up Joule Studio"** if SAP Build Process Automation is also to be linked) → **Start**.
3. The wizard checks prerequisites, then asks which solutions to integrate. Tick:
   - **SAP Build Process Automation** (for Joule Studio) if it is in this subaccount
   - **SAP Build Work Zone, standard edition** and **only** the standard edition. Ticking both standard and advanced makes the integration fail.
4. **Finish** and wait until every step shows a green check. This creates:
   - the formation (link) between Joule and Work Zone / SAP Build
   - role collections `Joule_Admin`, `Joule_End_User`
5. If the booster fails on the trust step, go back to section 1.2.

If Work Zone and Joule are in **different** subaccounts, the booster still lets you select the Work Zone subaccount (same global account, same IAS tenant).

### 4.2 Assign role collections

Joule subaccount → **Security → Users** → find your user → **Assign Role Collection**:

| Role collection | Who |
|---|---|
| `Joule_Admin` | you |
| `Joule_End_User` | you + all end users (or via the group mapping in 2.5) |
| `ProcessAutomationAdmin` | you (Joule Studio, needed only for section 5A) |
| `ProcessAutomationDeveloper` | anyone else who builds skills |

Log out and in again after changing roles.

---

## 5. Build and deploy the skill

Pick **one** of the two options. Both end with the capability deployed in the same Joule tenant.

- **5A Joule Studio** (click-through UI, no tooling on your PC).
- **5B Joule CLI** (YAML + command line; this is how the PO Monitor was done, so copying it is fastest).

### What the agent returns (needed for both options)

The agent answers a `message/send` with a task whose first artifact looks like:

```json
{
  "artifacts": [{
    "name": "operations_report",
    "parts": [
      { "kind": "text", "text": "**3 failures in the last 24 hours** ..." },
      { "kind": "data", "data": {
          "type": "operations_report", "period": "24H", "targets": ["idoc", "job"],
          "totalFailed": 3, "hasFailures": true,
          "dashboardUrl": "https://operations-monitor.cfapps.eu20-001.hana.ondemand.com/...?period=24H",
          "markdownTable": "| Source | ... |", "idoc": { ... }, "job": { ... } } }
    ]
  }]
}
```

- `parts[0].text` is a ready-to-show Markdown answer. Always display it.
- `parts[1].data.markdownTable` exists only when `hasFailures` is `true`.
- Errors and "not authorized" also come back as a text artifact, so the same display rule works.

### 5A. Joule Studio (UI)

#### 5A.1 Open Joule Studio

1. Subaccount with **SAP Build Process Automation** → **Instances and Subscriptions** → row *SAP Build Process Automation* → **Go to Application**. The **SAP Build lobby** opens.
2. Top right **Create** → **Build an Automated Process** / **Joule Studio** → **Joule Skills** (wording changes between releases; the tile mentions "Joule").
3. Project name: `Operations Monitor`. Description: `Failed IDocs and jobs from Cloud ALM`. **Create**.

#### 5A.2 Register the destination in SAP Build

1. In the lobby go to **Control Tower → Destinations** (sometimes *Settings → Destinations*).
2. **New Destination** → select `operations_monitor_agent_a2a` from the subaccount list → **Add**.
   If it is not listed, the destination is in another subaccount; create it again in this subaccount with the same values (section 3.2).

#### 5A.3 Create the skill

1. Inside the project: **Create → Skill**.
2. **Name**: `Failed IDocs and jobs`.
3. **Description** (Joule uses this to decide when to trigger): `Reports failed IDocs and failed application jobs from SAP Cloud ALM for the last hour, 24 hours, 7 days or 30 days, with a link to the Operations Monitor dashboard.`
4. **Example sentences** (add at least 5):
   - How are my integrations and jobs today?
   - How many IDocs failed this week?
   - Which jobs failed in the last hour?
   - Show me failed IDocs in the last 30 days
   - Any job failures today?
   - What is the status of my interfaces?
5. **Parameters**: none. The agent extracts the period from the sentence itself.

#### 5A.4 Add the call to the agent

1. In the skill editor add a step **Agent Request** (if your release shows only *Action* steps, use **Call A2A Agent**; both need a destination).
2. Settings:
   - **Destination / System alias**: `operations_monitor_agent_a2a`
   - **Path**: `/a2a`
   - **Method**: `message/send`
   - **Message text**: the user's utterance (bind to the built-in variable, e.g. `{{utterance}}` or *User Input*).
   - **Output variable**: `report`

#### 5A.5 Show the answer

1. Add a **Message** step after the agent request.
2. Content (Markdown): `{{report.artifacts[0].parts[0].text}}`
3. Add a **Condition** step: `report.artifacts[0].parts[1].data.hasFailures == true`.
   - In the *true* branch add a second **Message**: `{{report.artifacts[0].parts[1].data.markdownTable}}`.
4. Optional third message: `[Open dashboard]({{report.artifacts[0].parts[1].data.dashboardUrl}})`.
5. **Save**.

#### 5A.6 Test inside Joule Studio

1. Click **Test** (top right). A Joule chat preview opens that runs as *your* user.
2. Ask `How are my integrations and jobs today?`.
3. Expected: a headline with the total, one section per monitor, a link. If you get
   "You are not authorized to view operations data", your user is not in `OpsMonitor_Viewer` (section 2.2) or the destination has no token exchange (section 3.2).

#### 5A.7 Release and deploy

1. **Release** (top right) → version `1.0.0` → **Release**.
2. **Deploy** → choose the **Joule environment** connected to Work Zone (usually the only one, named after the subaccount) → **Deploy**.
3. Wait for status *Deployed*.

### 5B. Joule CLI (YAML)

Use this if the PO Monitor capability project is available (ask the colleague who built `po_monitor_agent_a2a` for the folder) because you can copy its structure.

#### 5B.1 Install the CLI

1. Install Node.js 20 LTS from nodejs.org if `node -v` fails in PowerShell.
2. `npm install -g @sap/joule-cli` (name as used in the PO Monitor project; check its README if different).
3. `joule login` → it opens a browser; log in with your IAS user. The CLI asks for the Joule tenant/subaccount if several are available.

#### 5B.2 Create the capability project

```
operations-monitor-capability/
  capability.yaml
  scenarios/operations_monitor.yaml
  functions/get_operations_report.yaml
  dialogs/operations_report.yaml
```

`capability.yaml`

```yaml
name: operations_monitor
version: 1.0.0
description: Failed IDocs and jobs from SAP Cloud ALM
```

`scenarios/operations_monitor.yaml`

```yaml
name: operations_monitor
description: >
  Reports failed IDocs and failed application jobs from SAP Cloud ALM for the
  last hour, 24 hours, 7 days or 30 days, with a link to the Operations Monitor dashboard.
examples:
  - How are my integrations and jobs today?
  - How many IDocs failed this week?
  - Which jobs failed in the last hour?
  - Show me failed IDocs in the last 30 days
  - Any job failures today?
dialog: operations_report
```

`functions/get_operations_report.yaml`

```yaml
name: get_operations_report
steps:
  - id: ask_agent
    type: agent-request
    system_alias: operations_monitor_agent_a2a
    path: /a2a
    method: message/send
    message:
      role: user
      parts:
        - kind: text
          text: "{{ utterance }}"
    result: report
```

`dialogs/operations_report.yaml`

```yaml
name: operations_report
steps:
  - call: get_operations_report
  - message:
      type: markdown
      text: "{{ report.artifacts[0].parts[0].text }}"
  - if: "{{ report.artifacts[0].parts[1].data.hasFailures }}"
    then:
      - message:
          type: markdown
          text: "{{ report.artifacts[0].parts[1].data.markdownTable }}"
```

Field names (`system_alias`, `agent-request`, `message`, `if`) must match the version used by the PO Monitor project; copy its files and change only the alias, path, texts and examples.

#### 5B.3 Validate and deploy

```powershell
joule validate            # checks YAML
joule deploy              # uploads to the logged-in Joule tenant
joule list                # shows deployed capabilities; operations_monitor must appear
```

#### 5B.4 Test

Open the standalone Joule chat (Joule subaccount → **Instances and Subscriptions → Joule → Go to Application**) and ask `How many IDocs failed this week?`.

---

## 6. Enable Joule in Work Zone so users can use it from the launchpad

Do this in the subaccount where **SAP Build Work Zone, standard edition** is subscribed (*SAP GenAI*).

### 6.1 Make sure you are a Work Zone admin

**Security → Users** → your user → role collection `Launchpad_Admin` must be assigned.

### 6.2 Switch Joule on in the site

1. **Instances and Subscriptions → SAP Build Work Zone, standard edition → Go to Application**. The **Site Manager** opens.
2. Left menu **Site Directory** → tile of your site (create one with **Create Site** if none exists: name `Operations`).
3. Click the tile's **Settings** (gear icon) → **Site Settings** → **Edit**.
4. Scroll to **Services** → toggle **Joule** to **On** → **Save**.
   If there is no Joule toggle, the booster in section 4.1 did not finish for this subaccount, or the trust is not OpenID Connect (1.2).

### 6.3 Add the dashboards as tiles (so Joule and the dashboards are on one page)

1. **Content Manager → My Content → Create → App** (three times):

| Title | App UI Technology | URL |
|---|---|---|
| Operations Monitor | URL | `https://operations-monitor.cfapps.eu20-001.hana.ondemand.com/` |
| Job Failure Monitor | URL | `https://job-failure-monitor.cfapps.eu20-001.hana.ondemand.com/` |
| IDoc Monitor | URL | `https://bearingpointgmbh-sap-genai-genai-idoc-monitor.cfapps.eu20-001.hana.ondemand.com/` |

   Under *Navigation* choose *Open in new tab* (each app has its own approuter login; this avoids iframe issues).
2. **Create → Catalog** `Operations` → add the three apps.
3. **Create → Group** `Operations` → add the three apps (groups are what the user sees as tile sections).
4. **Create → Role** `OpsMonitor_Viewer` → assign the catalog and the group → **Save**.
5. Back in **Site Directory → your site → Settings → Assignments**: assign role `OpsMonitor_Viewer` to the site.
6. BTP cockpit → **Security → Role Collections**: a role collection named `OpsMonitor_Viewer` now contains the Work Zone role (and already contains the app's XSUAA role). Make sure it is mapped to IAS group `OpsMonitor_Viewer` (section 2.5) so users get everything with one group.

### 6.4 Open it as a user

1. Site Directory → your site → **Go to site** (or copy the runtime URL; it ends with `/site`).
2. Log in. The tiles *Operations Monitor*, *Job Failure Monitor*, *IDoc Monitor* are visible.
3. Click the **Joule icon** (top right of the header). The chat panel opens.
4. Ask `How are my integrations and jobs today?`.

---

## 7. Verify and troubleshoot

| Symptom | Likely cause | Fix |
|---|---|---|
| No **Boosters**/**Entitlements** menu | Viewer role | Get `Subaccount Administrator` (1.1) |
| Booster fails at trust check | SAML trust | Switch to OpenID Connect (1.2) |
| No Joule toggle in Site Settings | Booster not run for this subaccount / wrong edition ticked | Re-run booster, tick only standard edition (4.1) |
| Joule icon missing in the site header | Toggle off, or user lacks `Joule_End_User` | 6.2 / 4.2, then log out and in |
| Joule answers "I can't help with that" | Skill not deployed, or deployed to another environment | `joule list` / Joule Studio deployment status (5) |
| "You are not authorized to view operations data" | User not in an accepted IAS group | Add to `OpsMonitor_Viewer` (2.2) |
| Joule shows an error about the destination / 401 | Destination auth wrong or IAS dependency missing | 2.4 and 3.2; compare with `po_monitor_agent_a2a` |
| Answer shows IDoc section "Not authorized" | User lacks the IDoc Monitor viewer role | Assign the IDoc viewer role collection (2.5 item 4) |
| Agent card URL returns an error | Backend down | `cf login -a https://api.cf.eu20-001.hana.ondemand.com`, `cf target -o BearingPointGmbH_sap-genai -s GenAI`, `cf app operations-monitor-srv`, `cf restart operations-monitor-srv` |
| Need to see what the agent did | Logs | `cf logs operations-monitor-srv --recent` and look for `a2a-auth-accepted`, `a2a-orchestration-complete` |

Backend redeploy (from the project folder):

```powershell
npm install
npm test
cf push                          # backend + dashboard
cd approuter; cf push -f manifest.yml; cd ..
```

---

## 8. Checklist

- [ ] Subaccount Administrator on SAP GenAI and on the Joule subaccount
- [ ] Trust to IAS `a21ttncfv` is OpenID Connect in both subaccounts
- [ ] Subscriptions present: Joule, SAP Build Process Automation (for Studio), Work Zone standard
- [ ] IAS group `OpsMonitor_Viewer` created and users added
- [ ] IAS dependency from Joule app to "Operations Monitor A2A Agent" / `operations-read`
- [ ] Destination `operations_monitor_agent_a2a` (OAuth2JWTBearer) in the Joule subaccount
- [ ] Joule booster run (standard edition only), `Joule_End_User` assigned
- [ ] Skill built (Joule Studio or CLI), released and deployed
- [ ] Work Zone site: Joule toggle on, tiles + role assigned
- [ ] End-to-end test from the Work Zone chat panel as a user in `OpsMonitor_Viewer`

# Creates the destinations the Operations Monitor needs, in the destination service instance
# 'operations-monitor-destination'. Secrets are read from service keys and never printed.
#   IDOC_MONITOR_API  -> IDoc Monitor OData   (OAuth2UserTokenExchange with the IDoc app's XSUAA)
#   JOB_MONITOR_API   -> Job Monitor OData    (OAuth2UserTokenExchange with the Job app's XSUAA)
#   JOB_MONITOR_A2A   -> Job Monitor A2A      (NoAuthentication; the orchestrator forwards the caller's IAS token)
#   GENERATIVE_AI_HUB -> SAP AI Core          (OAuth2ClientCredentials; AI analysis via chat completions)
#                        skip with -SkipAI, or name the AI Core service key instance/name with
#                        -AiServiceKey <instance> <key> (default: 'generative-ai-hub' 'ops-monitor-ai')
param(
  [switch] $SkipAI,
  [string] $AiServiceKeyInstance = 'generative-ai-hub',
  [string] $AiServiceKeyName = 'ops-monitor-ai',
  [string] $AiDeploymentId = 'd4da60fb50a82e0d',
  [string] $AiChatPath = ''
)
$ErrorActionPreference = 'Stop'

function KeyCreds($instance, $key) {
  $raw = (cf service-key $instance $key) -join "`n"
  $c = ($raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json)
  if ($c.credentials) { $c = $c.credentials }
  return $c
}

$dest = KeyCreds 'operations-monitor-destination' 'ops-admin-key'
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($dest.clientid):$($dest.clientsecret)"))
$tok = (Invoke-RestMethod -Method Post -Uri "$($dest.url)/oauth/token" -Headers @{ Authorization = "Basic $basic" } -Body @{ grant_type = 'client_credentials' }).access_token
$api = "$($dest.uri)/destination-configuration/v1/instanceDestinations"
$headers = @{ Authorization = "Bearer $tok"; 'Content-Type' = 'application/json' }

function Upsert($body) {
  $json = $body | ConvertTo-Json -Compress
  try { Invoke-RestMethod -Method Post -Uri $api -Headers $headers -Body $json | Out-Null; "created $($body.Name)" }
  catch { if ($_.Exception.Response.StatusCode.value__ -eq 409) { Invoke-RestMethod -Method Put -Uri $api -Headers $headers -Body $json | Out-Null; "updated $($body.Name)" } else { throw } }
}

$idoc = KeyCreds 'idoc-monitor-auth' 'ops-monitor-link'
$job = KeyCreds 'cloud-alm-job-monitor-xsuaa' 'ops-monitor-link'

Upsert @{ Name = 'IDOC_MONITOR_API'; Type = 'HTTP'; URL = 'https://bearingpointgmbh-sap-genai-genai-idoc-monitor-srv.cfapps.eu20-001.hana.ondemand.com'; ProxyType = 'Internet';
  Authentication = 'OAuth2UserTokenExchange'; clientId = $idoc.clientid; clientSecret = $idoc.clientsecret; tokenServiceURL = "$($idoc.url)/oauth/token"; tokenServiceURLType = 'Dedicated'; Description = 'IDoc Monitor OData for the Operations Monitor (user token exchange)' }

Upsert @{ Name = 'JOB_MONITOR_API'; Type = 'HTTP'; URL = 'https://job-failure-monitor-srv.cfapps.eu20-001.hana.ondemand.com'; ProxyType = 'Internet';
  Authentication = 'OAuth2UserTokenExchange'; clientId = $job.clientid; clientSecret = $job.clientsecret; tokenServiceURL = "$($job.url)/oauth/token"; tokenServiceURLType = 'Dedicated'; Description = 'Job Failure Monitor OData for the Operations Monitor (user token exchange)' }

Upsert @{ Name = 'JOB_MONITOR_A2A'; Type = 'HTTP'; URL = 'https://job-failure-monitor-srv.cfapps.eu20-001.hana.ondemand.com'; ProxyType = 'Internet';
  Authentication = 'NoAuthentication'; Description = 'Job Monitor A2A agent; the orchestrator forwards the caller IAS token' }

if (-not $SkipAI) {
  # SAP AI Core service key: API base URL + OAuth client credentials. Non-fatal: the dashboard works
  # without AI analysis, so a missing key only warns instead of failing the whole script.
  try {
    $ai = KeyCreds $AiServiceKeyInstance $AiServiceKeyName
    $aiUrl = if ($ai.AI_API_URL) { $ai.AI_API_URL } elseif ($ai.serviceurls.AI_API_URL) { $ai.serviceurls.AI_API_URL } else { $ai.url }
    $aiClient = if ($ai.clientid) { $ai.clientid } else { $ai.uaa.clientid }
    $aiSecret = if ($ai.clientsecret) { $ai.clientsecret } else { $ai.uaa.clientsecret }
    $aiToken = if ($ai.uaa.url) { "$($ai.uaa.url)/oauth/token" } else { "$($ai.url)/oauth/token" }
    $aiGroup = if ($ai.AI_RESOURCE_GROUP) { $ai.AI_RESOURCE_GROUP } else { 'default' }
    Upsert @{ Name = 'GENERATIVE_AI_HUB'; Type = 'HTTP'; URL = $aiUrl; ProxyType = 'Internet';
      Authentication = 'OAuth2ClientCredentials'; clientId = $aiClient; clientSecret = $aiSecret; tokenServiceURL = $aiToken;
      # Optional overrides read by srv/ai.js; the deployment defaults are used when these are absent.
      AiDeploymentId = $AiDeploymentId; AiResourceGroup = $aiGroup;
      AiChatPath = if ($AiChatPath) { $AiChatPath } else { "/v2/inference/deployments/$AiDeploymentId/chat/completions?api-version=2024-10-21" };
      Description = 'SAP AI Core foundation-model deployment for AI root-cause analysis (Operations Monitor)' }
  } catch {
    "WARNING: GENERATIVE_AI_HUB destination not created ($($_.Exception.Message)). AI analysis stays unavailable until it exists."
  }
}

(Invoke-RestMethod -Method Get -Uri $api -Headers $headers) | ForEach-Object { "exists: $($_.Name) [$($_.Authentication)]" }

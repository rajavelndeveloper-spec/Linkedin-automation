<#
.SYNOPSIS
  Sends one SMTP notification for a qualifying /enrich outcome (fetch failure,
  session_expired, a genuine final zero, or a partial/failed PATCH run).
  Resolves SMTP settings and recipients across Process/User/Machine env scope
  and .env, builds a plain-text body, sends as UTF-8, and logs every attempt.

.PARAMETER Result
  One of: FAILURE | NO DATA | OTHERS

.PARAMETER Headline
  One plain-English sentence - the business answer, no jargon.

.PARAMETER KeyFacts
  Array of "<label>: <value>" strings.

.PARAMETER Trigger
  One line: what specifically caused this email.

.PARAMETER RunResultJson
  The orchestrator's own RUN_RESULT JSON, or "not available to this stage".

.PARAMETER LogPath
  Resolved log path, or "see logs/ on the run machine".
#>
param(
  [Parameter(Mandatory = $true)][string]$Result,
  [Parameter(Mandatory = $true)][string]$Headline,
  [string[]]$KeyFacts = @(),
  [Parameter(Mandatory = $true)][string]$Trigger,
  [string]$RunResultJson = "not available to this stage",
  [string]$LogPath = "see logs/ on the run machine"
)

$startedAt = Get-Date
$projectDir = Split-Path -Parent $PSScriptRoot

$dotenv = @{}
$envFile = Join-Path $projectDir ".env"
if (Test-Path $envFile) {
  foreach ($rawLine in Get-Content -Path $envFile) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { continue }
    $eq = $line.IndexOf('=')
    $key = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2 -and $value[0] -eq $value[-1] -and ($value[0] -eq "'" -or $value[0] -eq '"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ($key) { $dotenv[$key] = $value }
  }
}

function Resolve-Var([string]$Name) {
  foreach ($scope in 'Process', 'User', 'Machine') {
    $val = [Environment]::GetEnvironmentVariable($Name, $scope)
    if ($val) { return @{ Value = $val; Scope = $scope } }
  }
  if ($dotenv.ContainsKey($Name)) { return @{ Value = $dotenv[$Name]; Scope = 'dotenv' } }
  return $null
}

$required = 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'
$resolved = @{}
foreach ($name in $required) {
  $r = Resolve-Var $name
  if ($r) { $resolved[$name] = $r }
}
$missing = $required | Where-Object { -not $resolved.ContainsKey($_) }

$recipients = @()
foreach ($rname in 'NOTIFY_BDE_EMAILS', 'NOTIFY_DEV_EMAILS') {
  $r = Resolve-Var $rname
  if ($r) { $recipients += @($r.Value -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
}
$recipients = @($recipients | Select-Object -Unique)

$logDir = Join-Path $projectDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$notifyLog = Join-Path $logDir "enrich-notifications.md"

function Mask-Email([string]$addr) {
  if ($addr -notmatch '^(.)(.*)(@.*)$') { return $addr }
  return "$($matches[1])***$($matches[3])"
}

function Write-LogRow([string]$date, [string]$time, [string]$varsResolved, [string]$recipientsSummary, [string]$result, [double]$durationSec, [string]$detail) {
  if (-not (Test-Path $notifyLog)) {
    Add-Content -Path $notifyLog -Value "# /enrich notification log`n"
    Add-Content -Path $notifyLog -Value "| Date | Time | Trigger | Vars resolved (name:scope) | Recipients (masked, count) | Result | Duration (s) | Detail |"
    Add-Content -Path $notifyLog -Value "|---|---|---|---|---|---|---:|---|"
  }
  $row = "| $date | $time | $Trigger | $varsResolved | $recipientsSummary | $result | $durationSec | $detail |"
  Add-Content -Path $notifyLog -Value $row -Encoding UTF8
}

$varsSummary = ($required | ForEach-Object {
    $short = $_.Replace('SMTP_', '')
    if ($resolved.ContainsKey($_)) { "$short`:$($resolved[$_].Scope)" } else { "$short`:MISSING" }
  }) -join ", "

if ($missing.Count -gt 0 -or $recipients.Count -eq 0) {
  $endedAt = Get-Date
  $durationSec = [math]::Round(($endedAt - $startedAt).TotalSeconds, 1)
  $detail = "missing=$($missing -join ',') recipients=$($recipients.Count)"
  Write-LogRow -date $startedAt.ToString("dd-MM-yyyy") -time $startedAt.ToString("HH:mm:ss") `
    -varsResolved $varsSummary -recipientsSummary "$($recipients.Count) (none)" `
    -result "configuration-incomplete" -durationSec $durationSec -detail $detail
  Write-Output (@{ result = "configuration-incomplete"; recipients = $recipients.Count; masked = "" } | ConvertTo-Json -Compress)
  exit 0
}

$maskedList = ($recipients | ForEach-Object { Mask-Email $_ }) -join ", "
$recipientsSummary = "$($recipients.Count) ($maskedList)"

$dateStr = $startedAt.ToString("dd-MM-yyyy")
$timeStr = $startedAt.ToString("HH:mm")

$keyFactsBlock = ($KeyFacts | ForEach-Object { "- $_" }) -join "`n"

$subject = "[LinkedIn Enrichment] enrich - $Result - $dateStr $timeStr"
$body = @"
Run: enrich
Result: $Result

$Headline

Key facts:
$keyFactsBlock

Technical details:
Trigger: $Trigger
RUN_RESULT: $RunResultJson
Log: $LogPath
"@

try {
  $securePass = ConvertTo-SecureString $resolved['SMTP_PASS'].Value -AsPlainText -Force
  $cred = New-Object System.Management.Automation.PSCredential($resolved['SMTP_USER'].Value, $securePass)
  Send-MailMessage -SmtpServer $resolved['SMTP_HOST'].Value -Port $resolved['SMTP_PORT'].Value `
    -UseSsl -Credential $cred -From $resolved['SMTP_FROM'].Value -To $recipients `
    -Subject $subject -Body $body -Encoding ([System.Text.Encoding]::UTF8)
  $sendResult = "sent"
}
catch {
  $sendResult = "failed"
}

$endedAt = Get-Date
$durationSec = [math]::Round(($endedAt - $startedAt).TotalSeconds, 1)
Write-LogRow -date $dateStr -time $startedAt.ToString("HH:mm:ss") -varsResolved $varsSummary `
  -recipientsSummary $recipientsSummary -result $sendResult -durationSec $durationSec -detail $Trigger

Write-Output (@{ result = $sendResult; recipients = $recipients.Count; masked = $maskedList } | ConvertTo-Json -Compress)

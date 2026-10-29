[CmdletBinding()]
param(
  [string]$ServiceName = $env:SYS4SYS_SERVICE_NAME,
  [string]$PackageRoot = $PSScriptRoot,
  [string]$HealthUrl = "",
  [int]$Port = 4110,
  [int]$ServiceControlTimeoutSec = 120,
  [int]$HealthTimeoutSec = 60,
  [switch]$NoServiceControl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
  $PackageRoot = $PSScriptRoot
}

if ([string]::IsNullOrWhiteSpace($ServiceName)) {
  $ServiceName = "sys4sysDemoNssmApi"
}

$ownerRaw = if ($env:SYS4SYS_SERVICE_CONTROL) {
  $env:SYS4SYS_SERVICE_CONTROL
} else {
  "script"
}
$owner = $ownerRaw.Trim().ToLowerInvariant()

if ($owner -notin @("sys4sys", "script")) {
  throw "SYS4SYS_SERVICE_CONTROL は sys4sys または script のいずれかを指定してください: $ownerRaw"
}

if ([string]::IsNullOrWhiteSpace($HealthUrl)) {
  $HealthUrl = "http://127.0.0.1:$Port/health"
}

$actionId = if ($env:SYS4SYS_DEPLOY_ACTION_ID) {
  $env:SYS4SYS_DEPLOY_ACTION_ID
} else {
  "manual"
}

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "  OK   $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "  WARN $Message" -ForegroundColor Yellow
}

function Test-Sys4SysControlsService {
  return ($owner -eq "sys4sys") -or $NoServiceControl
}

function Wait-ServiceState {
  param(
    [string]$Name,
    [string]$Target,
    [int]$TimeoutSec = 120
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $service = Get-Service -Name $Name -ErrorAction Stop
    if ($service.Status -eq $Target) {
      return
    }
    Start-Sleep -Milliseconds 500
  }

  $current = (Get-Service -Name $Name -ErrorAction Stop).Status
  throw "service $Name did not reach $Target (current=$current)"
}

function Invoke-Build {
  Write-Step "build"

  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm) {
    Write-Host "  pnpm --filter @sys4sys/demo-nssm-api build"
    & $pnpm.Source --filter '@sys4sys/demo-nssm-api' build
  } else {
    Write-Host "  npm run build (pnpm not found)"
    Push-Location $PackageRoot
    try {
      & npm.cmd run build
    } finally {
      Pop-Location
    }
  }

  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "build failed (exit=$exitCode)"
  }

  Write-Ok "build completed"
}

function Wait-HttpHealth {
  param(
    [string]$Url,
    [int]$TimeoutSec = 60
  )

  Write-Step "health wait"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $lastError = ""

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) {
        Write-Ok "health is healthy: $Url"
        return
      }
      $lastError = "status=$($response.StatusCode)"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 1000
  }

  throw "health wait failed for ${Url}: $lastError"
}

Write-Host "sys4sys NSSM demo deploy" -ForegroundColor White
Write-Host "service: $ServiceName"
Write-Host "owner:   $owner"
Write-Host "action:  $actionId"
Write-Host "package: $PackageRoot"

if (Test-Sys4SysControlsService) {
  Write-Step "service control (owned by sys4sys)"
  Write-Ok "sys4sys が SCM の stop / start / health を担当するため、このスクリプトはサービスを操作しません。"
} else {
  Write-Step "stop service (owned by script)"
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
    Wait-ServiceState -Name $ServiceName -Target "Stopped" -TimeoutSec $ServiceControlTimeoutSec
  }
  Write-Ok "service is stopped"
}

Invoke-Build

if (Test-Sys4SysControlsService) {
  Write-Step "start service (owned by sys4sys after deploy)"
  Write-Ok "sys4sys が deploy 後にサービスを起動し、health 確認を行います。"
} else {
  Write-Step "start service (owned by script)"
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne "Running") {
    Start-Service -Name $ServiceName
    Wait-ServiceState -Name $ServiceName -Target "Running" -TimeoutSec $ServiceControlTimeoutSec
  }
  Write-Ok "service is running"
  Wait-HttpHealth -Url $HealthUrl -TimeoutSec $HealthTimeoutSec
}

exit 0

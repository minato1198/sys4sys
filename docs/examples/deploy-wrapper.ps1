[CmdletBinding()]
param(
  [string]$ServiceName = $env:SYS4SYS_SERVICE_NAME,
  [int]$ServiceControlTimeoutSec = 60,
  [switch]$NoServiceControl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ownerRaw = if ($env:SYS4SYS_SERVICE_CONTROL) {
  $env:SYS4SYS_SERVICE_CONTROL
} else {
  "script"
}
$owner = $ownerRaw.Trim().ToLowerInvariant()

if ($owner -notin @("sys4sys", "script")) {
  throw "SYS4SYS_SERVICE_CONTROL は sys4sys または script のいずれかを指定してください: $ownerRaw"
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
    [int]$TimeoutSec = 60
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

if (-not $ServiceName) {
  throw "ServiceName を指定するか、SYS4SYS_SERVICE_NAME を設定してください。"
}

Write-Host "deploy wrapper" -ForegroundColor White
Write-Host "service: $ServiceName"
Write-Host "owner:   $owner"

if (Test-Sys4SysControlsService) {
  Write-Step "service control (owned by sys4sys)"
  Write-Ok "sys4sys が SCM の stop / start / health を管理します。このスクリプトはサービスを操作しません。"
} else {
  Write-Step "stop service (owned by script)"
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
    Wait-ServiceState -Name $ServiceName -Target "Stopped" -TimeoutSec $ServiceControlTimeoutSec
  }
  Write-Ok "service is stopped"
}

# ここにビルド・配置・マイグレーションなど、サービスファイルを差し替える処理を書く。
# 失敗時は throw し、必要なら旧成果物へロールバックする。
Write-Step "deploy command"
Write-Ok "deploy payload completed"

if (Test-Sys4SysControlsService) {
  Write-Step "start service (owned by sys4sys after deploy)"
  Write-Ok "sys4sys が deploy 後にサービスを起動します。"
} else {
  Write-Step "start service (owned by script)"
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne "Running") {
    Start-Service -Name $ServiceName
    Wait-ServiceState -Name $ServiceName -Target "Running" -TimeoutSec $ServiceControlTimeoutSec
  }
  Write-Ok "service is running"

  # 必要ならここで HTTP / TCP の health check を行う。sys4sys が wait できる場合は省略可。
  Write-Warn "health check はスクリプト内の運用要件に合わせて追加してください。"
}

exit 0

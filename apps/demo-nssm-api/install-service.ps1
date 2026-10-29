[CmdletBinding()]
param(
  [string]$ServiceName = "sys4sysDemoNssmApi",
  [string]$NssmPath = "",
  [int]$Port = 4110,
  [ValidateSet("SERVICE_AUTO_START", "SERVICE_DEMAND_START", "SERVICE_DISABLED")]
  [string]$StartType = "SERVICE_DEMAND_START",
  [string]$AppExit = "Restart",
  [string]$LogDirectory = "",
  [switch]$Build,
  [switch]$Start
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PackageRoot = if ($PSScriptRoot) {
  $PSScriptRoot
} else {
  (Get-Location).Path
}

if ([string]::IsNullOrWhiteSpace($LogDirectory)) {
  $LogDirectory = Join-Path $PackageRoot "logs"
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

function Resolve-NssmPath {
  if (-not [string]::IsNullOrWhiteSpace($NssmPath)) {
    if (-not (Test-Path -LiteralPath $NssmPath -PathType Leaf)) {
      throw "NSSM が見つかりません: $NssmPath"
    }
    return (Resolve-Path -LiteralPath $NssmPath).Path
  }

  $command = Get-Command nssm -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $command = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  throw "nssm.exe が PATH にありません。-NssmPath で nssm.exe の絶対パスを指定してください。"
}

function Invoke-Nssm {
  param([string[]]$Arguments)

  & $Nssm @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "nssm $($Arguments -join ' ') failed (exit=$exitCode)"
  }
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

$Nssm = Resolve-NssmPath
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  $nodeCommand = Get-Command node -ErrorAction Stop
}

$serverPath = Join-Path $PackageRoot "dist/server.js"

Write-Host "sys4sys NSSM demo service installer" -ForegroundColor White
Write-Host "service:      $ServiceName"
Write-Host "package:      $PackageRoot"
Write-Host "node:         $($nodeCommand.Source)"
Write-Host "nssm:         $Nssm"
Write-Host "port:         $Port"
Write-Host "startType:    $StartType"
Write-Host "appExit:      $AppExit"

if ($Build -or -not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  Invoke-Build
}

if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  throw "dist/server.js が見つかりません。先にビルドしてください: $serverPath"
}

New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$stdoutPath = Join-Path $LogDirectory "demo-nssm-api.out.log"
$stderrPath = Join-Path $LogDirectory "demo-nssm-api.err.log"

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Warn "service は既に存在します。NSSM パラメータだけ更新します。適用するにはサービスを再起動してください。"
} else {
  Write-Step "install service"
  try {
    Invoke-Nssm @("install", $ServiceName, $nodeCommand.Source, $serverPath)
  } catch {
    Write-Host "  管理者権限が必要になる場合があります。PowerShell を「管理者として実行」で再試行してください。"
    throw
  }
}

Write-Step "configure service"
Invoke-Nssm @("set", $ServiceName, "AppDirectory", $PackageRoot)
Invoke-Nssm @("set", $ServiceName, "AppStdout", $stdoutPath)
Invoke-Nssm @("set", $ServiceName, "AppStderr", $stderrPath)
Invoke-Nssm @(
  "set",
  $ServiceName,
  "AppEnvironmentExtra",
  "PORT=$Port",
  "HOST=127.0.0.1",
  "SYS4SYS_SERVICE_NAME=$ServiceName"
)
Invoke-Nssm @("set", $ServiceName, "AppRotateFiles", "1")
Invoke-Nssm @("set", $ServiceName, "AppRotateBytes", "10485760")
Invoke-Nssm @("set", $ServiceName, "AppExit", $AppExit)
Invoke-Nssm @("set", $ServiceName, "Start", $StartType)

$actualStartOutput = & $Nssm get $ServiceName Start
if ($LASTEXITCODE -ne 0) {
  throw "nssm get $ServiceName Start failed (exit=$LASTEXITCODE)"
}
$actualStart = (($actualStartOutput | Out-String) -replace '\s+', ' ').Trim()
if ($actualStart -ne $StartType) {
  throw "NSSM Start 設定を確認できません。expected=$StartType actual=$actualStart"
}

Write-Ok "NSSM parameters applied"
Write-Host ""
Write-Host "sys4sys 側の登録値:"
Write-Host "  controlMode = windows-service"
Write-Host "  serviceName = $ServiceName"
Write-Host "  expectedPorts = [$Port]"
Write-Host "  healthUrl = http://127.0.0.1:$Port/health"
Write-Host "  log stdout = $stdoutPath"
Write-Host "  log stderr = $stderrPath"

if ($Start) {
  Write-Step "start service"
  Start-Service -Name $ServiceName
  Start-Sleep -Seconds 2
  Write-Ok "service started"
}

exit 0

[CmdletBinding()]
param(
  [string]$ServiceName = "sys4sysDemoNssmApi",
  [string]$NssmPath = "",
  [string]$LogDirectory = "",
  [switch]$RemoveLogs
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

$Nssm = Resolve-NssmPath

Write-Host "sys4sys NSSM demo service uninstaller" -ForegroundColor White
Write-Host "service: $ServiceName"
Write-Host "nssm:    $Nssm"

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Warn "service が存在しません: $ServiceName"
} else {
  Write-Step "remove service"
  & $Nssm remove $ServiceName confirm
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Write-Host "  管理者権限が必要になる場合があります。PowerShell を「管理者として実行」で再試行してください。"
    throw "nssm remove failed (exit=$exitCode)"
  }
  Write-Ok "service removed"
}

if ($RemoveLogs) {
  Write-Step "remove logs"
  if (Test-Path -LiteralPath $LogDirectory) {
    Remove-Item -LiteralPath $LogDirectory -Recurse -Force
    Write-Ok "logs removed: $LogDirectory"
  } else {
    Write-Warn "logs directory does not exist: $LogDirectory"
  }
}

exit 0

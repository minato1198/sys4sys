[CmdletBinding()]
param(
  [string]$ServiceName = "demo-api",
  [string]$Branch = "main",
  [string]$ApiBaseUrl = $(if ($env:SYS4SYS_API_URL) { $env:SYS4SYS_API_URL } else { "http://127.0.0.1:8787" }),
  [string]$Email = $env:SYS4SYS_EMAIL,
  [string]$Password = $env:SYS4SYS_PASSWORD,
  [string]$SessionCookie = $env:SYS4SYS_SESSION_COOKIE,
  [string]$RepoRoot = "",
  [switch]$SkipPull,
  [switch]$SkipInstall,
  [switch]$RunTests,
  [switch]$NoRestart,
  [switch]$NoServiceControl,
  [switch]$AllowDirty,
  [int]$HealthTimeoutSec = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # Some hosts do not allow changing console encoding. Deploy continues as-is.
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

function Write-Fail([string]$Message) {
  Write-Host "  FAIL $Message" -ForegroundColor Red
}

function Invoke-Git {
  param([string[]]$GitArgs)
  & git @GitArgs
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArgs -join ' ') に失敗しました (exit $LASTEXITCODE)"
  }
}

function Get-LastErrorText {
  param($ErrorRecord)
  if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
    return $ErrorRecord.ErrorDetails.Message
  }
  return $ErrorRecord.Exception.Message
}

function Invoke-Api {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int]$TimeoutSec = 15
  )

  $request = @{
    Method = $Method
    Uri = "$ApiBaseUrl$Path"
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) {
    $request["ContentType"] = "application/json"
    $request["Body"] = ($Body | ConvertTo-Json -Compress -Depth 10)
  }
  if ($null -ne $webSession) {
    $request["WebSession"] = $webSession
  }
  if ($headers.Count -gt 0) {
    $request["Headers"] = $headers
  }
  return Invoke-RestMethod @request
}

$exitCode = 0
$pushedLocation = $false
$createdSession = $false
$webSession = $null
$headers = @{}

try {
  foreach ($command in @("git", "pnpm", "node")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
      throw "$command が見つかりません。PATH を確認してください。"
    }
  }

  if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = (& git -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($RepoRoot)) {
      throw "git リポジトリが見つかりません。deploy.ps1 をリポジトリ内で実行するか -RepoRoot を指定してください。"
    }
    $RepoRoot = $RepoRoot.Trim()
  } else {
    $RepoRoot = (Resolve-Path $RepoRoot).Path
  }

  $ApiBaseUrl = $ApiBaseUrl.TrimEnd("/")
  Push-Location $RepoRoot
  $pushedLocation = $true

  Write-Host "sys4sys demo-api deploy" -ForegroundColor White
  Write-Host "repo:    $RepoRoot"
  Write-Host "service: $ServiceName"
  Write-Host "branch:  $Branch"

  $serviceControlRaw = if ($env:SYS4SYS_SERVICE_CONTROL) {
    $env:SYS4SYS_SERVICE_CONTROL
  } else {
    "script"
  }
  $serviceControl = $serviceControlRaw.Trim().ToLowerInvariant()
  if ($serviceControl -notin @("sys4sys", "script")) {
    throw "SYS4SYS_SERVICE_CONTROL は sys4sys または script のいずれかを指定してください: $serviceControlRaw"
  }
  Write-Host "control: $serviceControl"

  $previousCommitRaw = (& git rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($previousCommitRaw)) {
    throw "git の HEAD を取得できません: $RepoRoot"
  }
  $previousCommit = $previousCommitRaw.Trim()
  Write-Host "commit:  $previousCommit"

  if (-not $SkipPull) {
    Write-Step "git pull --ff-only origin $Branch"
    $currentBranch = (& git rev-parse --abbrev-ref HEAD).Trim()
    if ($currentBranch -ne $Branch) {
      throw "現在のブランチは '$currentBranch' です。'$Branch' に切り替えてから実行するか -SkipPull を指定してください。"
    }

    $dirty = @(& git status --porcelain --untracked-files=no)
    if ($dirty.Count -gt 0 -and -not $AllowDirty) {
      throw "追跡対象ファイルに未コミットの変更があります。コミットするか -SkipPull / -AllowDirty を指定してください。"
    }
    if ($dirty.Count -gt 0) {
      Write-Warn "未コミットの変更があります（-AllowDirty のため続行）"
    }

    $remote = (& git remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote)) {
      throw "git remote 'origin' が設定されていません。-SkipPull を指定するか remote を追加してください。"
    }

    Invoke-Git -GitArgs @("fetch", "--prune", "origin", $Branch)
    Invoke-Git -GitArgs @("merge", "--ff-only", "origin/$Branch")
    $newCommit = (& git rev-parse --short HEAD).Trim()
    if ($newCommit -eq $previousCommit) {
      Write-Ok "最新です ($newCommit)"
    } else {
      Write-Ok "更新しました: $previousCommit -> $newCommit"
    }
  } else {
    Write-Step "git pull (skipped)"
  }

  if (-not $SkipInstall) {
    Write-Step "pnpm install --frozen-lockfile"
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm install に失敗しました"
    }
    Write-Ok "依存関係を確認しました"
  } else {
    Write-Step "pnpm install (skipped)"
  }

  if ($RunTests) {
    Write-Step "pnpm test"
    & pnpm test
    if ($LASTEXITCODE -ne 0) {
      throw "テストに失敗しました"
    }
    Write-Ok "テスト成功"
  }

  Write-Step "typecheck (@sys4sys/demo-api)"
  & pnpm --filter @sys4sys/demo-api typecheck
  if ($LASTEXITCODE -ne 0) {
    throw "typecheck に失敗しました"
  }
  Write-Ok "typecheck 成功"

  Write-Step "build (@sys4sys/demo-api)"
  & pnpm --filter @sys4sys/demo-api build
  if ($LASTEXITCODE -ne 0) {
    throw "build に失敗しました"
  }
  $serverEntry = Join-Path $RepoRoot "apps\demo-api\dist\server.js"
  if (-not (Test-Path $serverEntry)) {
    throw "ビルド成果物が見つかりません: $serverEntry"
  }
  Write-Ok "build 成功 ($serverEntry)"

  if ($serviceControl -eq "sys4sys") {
    Write-Step "service control (owned by sys4sys)"
    Write-Ok "sys4sys が SCM の停止・起動・health 確認を管理するため、このスクリプトはサービスを操作しません。"
  } elseif ($NoServiceControl -or $NoRestart) {
    Write-Step "sys4sys restart (skipped)"
    Write-Ok "ビルド完了。サービスは再起動していません。"
  } else {
    Write-Step "sys4sys API でサービスを再起動"

    $cookie = $SessionCookie.Trim()
    if ($cookie -match "^sys4sys_session=") {
      $cookie = $cookie.Substring("sys4sys_session=".Length)
    }

    if (-not [string]::IsNullOrWhiteSpace($cookie)) {
      $headers["Cookie"] = "sys4sys_session=$cookie"
      Write-Host "認証: SYS4SYS_SESSION_COOKIE"
    } elseif (-not [string]::IsNullOrWhiteSpace($Email) -and -not [string]::IsNullOrWhiteSpace($Password)) {
      $login = Invoke-RestMethod `
        -Method Post `
        -Uri "$ApiBaseUrl/api/auth/login" `
        -ContentType "application/json" `
        -Body (@{ email = $Email; password = $Password } | ConvertTo-Json -Compress) `
        -TimeoutSec 15 `
        -SessionVariable webSession
      $createdSession = $true
      Write-Host "認証: $($login.email) ($($login.role))"
    } else {
      throw "認証情報がありません。SYS4SYS_EMAIL / SYS4SYS_PASSWORD を設定するか -SessionCookie を指定してください（-NoRestart でビルドのみも可）。"
    }

    $services = @(Invoke-Api -Method "Get" -Path "/api/services" -TimeoutSec 15)

    $service = $services | Where-Object { $_.name -eq $ServiceName } | Select-Object -First 1
    if (-not $service) {
      throw "サービス '$ServiceName' が sys4sys に見つかりません。"
    }
    Write-Host "service id: $($service.id)"
    Write-Host "before:     status=$($service.status) pid=$($service.pid)"

    if ($service.cwd) {
      $expectedCwd = [IO.Path]::GetFullPath((Join-Path $RepoRoot "apps\demo-api"))
      $actualCwd = [IO.Path]::GetFullPath([string]$service.cwd)
      if (-not $actualCwd.Equals($expectedCwd, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Warn "サービスの cwd ($actualCwd) とビルド先 ($expectedCwd) が一致しません。反映先を確認してください。"
      }
    }

    $action = Invoke-Api -Method "Post" -Path "/api/services/$($service.id)/restart" -Body @{} -TimeoutSec 30
    Write-Ok "restart accepted (action=$($action.id), status=$($action.status))"

    Write-Step "health check (最大 $HealthTimeoutSec 秒)"
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $detail = $null
    $healthStatus = "unknown"
    $healthy = $false

    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2

      $detail = Invoke-Api -Method "Get" -Path "/api/services/$($service.id)" -TimeoutSec 10

      try {
        $health = Invoke-Api -Method "Get" -Path "/api/services/$($service.id)/health" -TimeoutSec 10
        $healthStatus = $health.status
      } catch {
        $healthStatus = "unreachable"
      }

      Write-Host "  status=$($detail.status) health=$healthStatus"
      if ($detail.status -eq "running" -and $healthStatus -eq "healthy") {
        $healthy = $true
        break
      }
    }

    if (-not $healthy) {
      Write-Fail "サービスが healthy になりませんでした（status=$($detail.status), health=$healthStatus）"
      try {
        $logs = Invoke-Api -Method "Get" -Path "/api/logs?serviceId=$($service.id)&limit=20" -TimeoutSec 10
        Write-Host "--- recent logs ---" -ForegroundColor DarkGray
        @($logs.items) | Select-Object -Last 20 | ForEach-Object {
          Write-Host $_.message -ForegroundColor DarkGray
        }
      } catch {
        Write-Warn "ログの取得にも失敗しました"
      }
      throw "デプロイ後のヘルスチェックに失敗しました。previous commit: $previousCommit"
    }

    Write-Ok "deploy 完了: status=$($detail.status) health=$healthStatus pid=$($detail.pid)"
  }
} catch {
  Write-Fail (Get-LastErrorText $_)
  $exitCode = 1
} finally {
  if ($createdSession -and $webSession) {
    try {
      Invoke-Api -Method "Post" -Path "/api/auth/logout" -TimeoutSec 10 | Out-Null
    } catch {
      Write-Warn "ログアウトに失敗しました（セッションは期限切れで無効になります）"
    }
  }
  if ($pushedLocation) {
    Pop-Location
  }
}

exit $exitCode

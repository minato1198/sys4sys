/**
 * Windows の待受ポート + プロセス情報を JSON で出力する。
 * - Get-NetTCPConnection / Get-NetUDPEndpoint は CIM インスタンスを返すため、
 *   必要なプロパティだけを射影する（そのまま ConvertTo-Json すると巨大になる）。
 * - PowerShell 7.6 では New-Object List[object] が失敗するため配列を使う。
 * - 進捗ストリームの CLIXML 出力を抑止する。
 */
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }

$rows = @()

foreach ($c in Get-NetTCPConnection -State Listen) {
  $p = $procs[[int]$c.OwningProcess]
  $rows += [pscustomobject]@{
    protocol    = 'tcp'
    address     = $c.LocalAddress
    port        = [int]$c.LocalPort
    pid         = [int]$c.OwningProcess
    process     = $p.Name
    path        = $p.ExecutablePath
    commandLine = $p.CommandLine
  }
}

foreach ($u in Get-NetUDPEndpoint) {
  $p = $procs[[int]$u.OwningProcess]
  $rows += [pscustomobject]@{
    protocol    = 'udp'
    address     = $u.LocalAddress
    port        = [int]$u.LocalPort
    pid         = [int]$u.OwningProcess
    process     = $p.Name
    path        = $p.ExecutablePath
    commandLine = $p.CommandLine
  }
}

ConvertTo-Json -InputObject @($rows) -Compress -Depth 5

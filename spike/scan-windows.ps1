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

# M1 スパイク結果: Windows + WSL ポートスキャン

- 実施日: 2026-10-21
- 実装: `spike/portscan.mjs`, `spike/scan-windows.ps1`
- 環境: Windows 10.0.26300.9711 / Node.js 24.13.1 / PowerShell 7.6.7 & 5.1
- WSL: 3.0.3.0 / kernel 6.18.54.1 / WSLg 1.0.79
- WSL distros: `OpenClaw`（既定）, `docker-desktop`, `mesh_llm`

## 結論（先に要点）

1. **Windows / WSL とも待受ポート + PID + プロセス名を取得できた。** 正規化も可能。
2. **WSL 3.x では distro 間でネットワーク名前空間が共有される。** ポートは「WSL 全体で1つ」として扱うべき。
3. **PID 名前空間は distro ごとに独立。** PID を観測できるのは、そのプロセスを所有する distro 内だけ。
4. **WSL のポートは Windows 側に `wslrelay.exe` として現れる。** 同一ポートが WSL 側にもあればフォワーディングと判定できる。
5. **停止中の distro を `wsl.exe -d` で叩くと起動してしまう。** 監視スキャンは `Running` のみを対象にすべき。
6. `wsl.exe` の出力はパイプ経由で **UTF-16LE + BOM**。デコード処理が必須。

---

## 1. 計測結果

| 対象                                 | 行数 | 所要時間（初回）  | 備考                                                     |
| ------------------------------------ | ---- | ----------------- | -------------------------------------------------------- |
| Windows（TCP listen + UDP endpoint） | 82   | 約 900 ms         | `Get-NetTCPConnection` + `Get-CimInstance Win32_Process` |
| WSL `OpenClaw`                       | 8    | 約 1,590 ms       | DNS(systemd-resolved) + systemd 系のみ                   |
| 合計（Windows + 稼働中 WSL）         | 90   | 約 2.5 秒（直列） | 並列化で約 1.6 秒まで短縮可能                            |

10 秒間隔の監視には十分。ただしスキャン中に WSL を起動しないこと。

### Windows 側の観測例

```
SCOPE    PROTO ADDRESS      PORT   PID     PROCESS
windows  tcp   0.0.0.0      5432   6548    postgres.exe
windows  tcp   0.0.0.0      5900   16212   winvnc.exe
windows  tcp   127.0.0.1    6768   29020   Orca.exe
windows  tcp   127.0.0.1    62460  25492   opencode.exe
```

- 管理者権限でないプロセスの `CommandLine` / `ExecutablePath` は `null` になる場合がある（`services.exe` など）。
- 同じポートが IPv4 (`0.0.0.0`) と IPv6 (`::`) の 2 行で出る。UI ではポート単位にグルーピングする。

### WSL 側の観測例

```
SCOPE  PID_SCOPE  PROTO ADDRESS    PORT   PID   PROCESS
wsl    OpenClaw   tcp   0.0.0.0    34567  285   python3   python3 -m http.server 34567
wsl    OpenClaw   tcp   127.0.0.54 53     -     -
```

- `ss -H -tulpn` で取得。`-p` は自分の PID 名前空間のプロセスしか見えない。
- 別 distro から見ると、同じポートでも `pid=null` になる（下記）。

---

## 2. 発見事項の詳細

### 2.1 WSL のネットワーク名前空間は共有

```
$ wsl -d OpenClaw -- readlink /proc/self/ns/net
net:[4026531833]
$ wsl -d mesh_llm -- readlink /proc/self/ns/net
net:[4026531833]     # 同じ inode

$ wsl -d OpenClaw -- readlink /proc/self/ns/pid
pid:[4026532214]
$ wsl -d mesh_llm -- readlink /proc/self/ns/pid
pid:[4026532255]     # 別 inode
```

`OpenClaw` で `python3 -m http.server 34567` を起動したところ、**`mesh_llm` からも 34567 が見えた**（`pid=null`）。WSL 3.0.3.0 では全 distro が同じネットワーク名前空間を共有する。

**設計への影響**

- ポートの `scope` は `windows` / `wsl` の 2 種類でよい（distro ごとに分けない）。
- `pidScope`（どの distro で PID を観測したか）を別フィールドで持つ。
- 停止・再起動・ログ tail は `pidScope` の distro 内で実行する。
- distro ごとに同じポートが重複して見えるため、`(protocol, address, port)` でマージする。
- UI では「WSL（OpenClaw で実行中）」のように表示する。

### 2.2 Windows 側の WSL フォワーディング

WSL で 34567 を Listen した状態で Windows 側をスキャンすると:

```
scope=windows, address=127.0.0.1, port=34567, pid=15216,
process=wslrelay.exe,
commandLine=" --mode 1 --vm-id {eb28c697-...} --handle 1556",
likelyWslForward=true
```

- `http://127.0.0.1:34567/` は Windows から **HTTP 200** で到達した。
- 判定条件: 「Windows 側のプロセスが `wslrelay.exe` / `System` (PID 4)」かつ「同じポートが WSL 側にも存在」。
- この注記がないと、WSL のポートを Windows の別プロセスと誤認する。

### 2.3 停止中 distro の暗黙起動

`wsl.exe -l -v` で全 distro が `Stopped` の状態から `wsl.exe -d mesh_llm -- ss ...` を実行すると、**mesh_llm が起動した**。スキャンのたびに意図しない distro が起動すると、メモリを消費し、監視対象外のプロセスを動かすことになる。

**対策（実装済み）**

- `wsl.exe -l -v` の `STATE` をパースし、`Running` のみスキャン。
- 停止中は `skipped: not running (Stopped)` として返す。
- 明示的に起動したい場合のみ `--start-stopped` を付ける。

### 2.4 WSL はアイドルで自動停止する

検証用サーバーを `pkill` した後、`OpenClaw` は `Stopped` になった。監視対象としては「停止」ではなく **「WSL が止まっている」という別状態**として扱い、アラートを分ける必要がある。

- サービス停止と混同しない（自動再起動の対象外）
- 必要なら `wsl.exe -d <distro> -e true` で起動する操作を別途提供

### 2.5 出力エンコーディング

`wsl.exe` の stdout をパイプすると UTF-16LE + BOM になる。

```
O p e n C l a w \r \n ...
```

BOM (`FF FE`) または NUL バイトの密度で判定し、`utf16le` でデコードする。`wsl.exe -l -v` の表も同じ。

### 2.6 PowerShell の落とし穴

- `New-Object System.Collections.Generic.List[object]` が PowerShell 7.6.7 で `Argument types do not match` になった。`@()` + `+=` に変更（PS 5.1 でも動作）。
- `Get-NetTCPConnection` の戻り値は CIM インスタンスで、そのまま `ConvertTo-Json` すると巨大なメタデータが出力される。**必要なプロパティを明示的に射影する**。
- `ConvertTo-Json` の既定 `-Depth 2` では警告が出るため `-Depth 5` を指定。
- 進捗ストリームが stderr に CLIXML として出る。`$ProgressPreference='SilentlyContinue'` で抑制。

---

## 3. 実装（スパイク）

```
spike/
├─ portscan.mjs        # 正規化・マージ・フォワーディング判定・表示
├─ scan-windows.ps1    # Windows の TCP/UDP + プロセス情報を JSON で出力
└─ forwarding-test.json
```

使い方:

```powershell
node spike/portscan.mjs                    # Windows + 稼働中 WSL
node spike/portscan.mjs --json             # JSON
node spike/portscan.mjs --host windows
node spike/portscan.mjs --host wsl:OpenClaw
node spike/portscan.mjs --start-stopped    # 停止中 distro も明示的に起動して scan
```

出力モデル:

```ts
type PortRow = {
  scope: "windows" | "wsl";
  pidScope?: string; // WSL のとき、PID を観測した distro
  seenIn?: string[]; // WSL のとき、ポートが見えた distro 一覧
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  pid: number | null;
  process: string | null;
  commandLine: string | null;
  likelyWslForward?: boolean;
};
```

---

## 4. 本実装への反映事項

| 項目             | 反映                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| ポートの scope   | `windows` / `wsl`。distro は `pidScope` で保持                        |
| スキャン対象     | `Running` の distro のみ。停止中は状態として表示                      |
| マージ           | `(protocol, address, port)` で 1 行に。PID は観測できた distro を優先 |
| フォワーディング | `wslrelay.exe` / `System` + WSL 同一ポートで注記                      |
| 操作             | 停止・再起動・tail は `pidScope` の distro で実行                     |
| WSL 停止         | 自動再起動の対象外。別操作として「WSL 起動」を提供                    |
| 性能             | Windows と WSL を並列スキャン。キャッシュで 10 秒間隔に収める         |
| エンコード       | UTF-16LE / UTF-8 の自動判定                                           |
| 権限             | CommandLine が null の場合を許容し、UI で「取得不可」表示             |

## 5. 残課題

- Windows 側のプロセス情報取得を管理者権限なしでどこまで取れるか、サービスごとに検証する。
- WSL 内の複数ユーザーで `ss -p` の見え方が変わるか（`sudo` 時との差分）。
- 監視対象が増えた場合の `wsl.exe` 呼び出しオーバーヘッド（1 distro あたり約 1.5 秒）。
- WSL の `networkingMode=mirrored` が有効な場合の挙動（今回は未検証）。

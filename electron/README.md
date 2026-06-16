# Amazon Price Monitor

Electron デスクトップアプリで、Amazon.co.jp の商品価格を継続的に監視し、フィルタ条件にマッチした商品を Discord に通知します。

クロール中核ロジックは Rust 製のサイドカーバイナリに分離されており、コンパイル済みのため逆解析が困難な構造になっています。

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│   Electron App  (Amazon Price Monitor.exe)          │
│   ├─ Renderer  (JS / HTML / CSS  ─  UI)             │
│   └─ Main      (JS  ─  DB / IPC / scheduler)        │
│                       ↕  stdin/stdout JSON           │
│   ┌──────────────────────────────────────────┐      │
│   │  Rust Sidecar  (crawler.exe)             │      │
│   │  ├─ HTTP fetch (reqwest)                  │      │
│   │  ├─ HTML parse (scraper)                  │      │
│   │  └─ 135→45 coverage loop                  │      │
│   └──────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘
        ↓ Webhook                ↓ HTTP
   [ Discord ]            [ amazon.co.jp ]
```

- **Renderer**: ビューア表、フィルタ／通知設定モーダル、詳細グラフモーダル
- **Main**: SQLite (better-sqlite3) 永続化、Discord 通知、スケジューラ、サイドカー管理
- **Rust サイドカー**: クロール本体。stdio 経由で main プロセスと通信。Cookie は stdin 渡しなので他プロセスから見えない

---

## ディレクトリ構成

```
electron/
├─ src/
│  ├─ main/                       # Electron main プロセス
│  │  ├─ index.js                 # エントリポイント
│  │  ├─ ipc-handlers.js          # Renderer ↔ Main IPC
│  │  ├─ db/
│  │  │  ├─ sqlite.js
│  │  │  ├─ migrations.js
│  │  │  ├─ queries.js
│  │  │  └─ retention.js
│  │  ├─ scraper/
│  │  │  └─ fetcher.js            # 互換シム → crawler-bridge へ委譲
│  │  └─ services/
│  │     ├─ scheduler.js          # 監視サイクルのオーケストレーション
│  │     ├─ crawler-bridge.js     # Rust サイドカーへの IPC
│  │     ├─ notifier.js           # Discord 通知
│  │     ├─ chart-image.js        # 通知用グラフ画像生成
│  │     └─ screenshot.js
│  ├─ renderer/                   # UI
│  │  ├─ index.html
│  │  ├─ renderer.js
│  │  ├─ styles.css
│  │  ├─ chart-render.html        # オフスクリーンチャート描画ページ
│  │  └─ chart-renderer.js        # 時系列・スパークライン描画
│  └─ shared/
│     └─ constants.js
├─ crawler/                       # Rust サイドカー
│  ├─ Cargo.toml
│  └─ src/
│     ├─ main.rs                  # IPC ループ
│     ├─ protocol.rs              # Command / Event 定義
│     ├─ constants.rs
│     ├─ fetcher.rs               # HTTP + ペーシング + ブロック検知
│     ├─ parser.rs                # HTML 9項目抽出
│     └─ coverage.rs              # 135→45 カバレッジループ
├─ assets/                        # アイコン等（任意）
├─ scripts/
│  └─ test-screenshot.js
├─ electron-builder.yml
├─ package.json
└─ README.md   ← このファイル
```

---

## 必要環境

| 項目 | バージョン | 用途 |
|------|----------|------|
| **Node.js** | 18 LTS / 20 LTS | Electron 実行 + ビルドスクリプト |
| **npm** | 10+ | 同梱 |
| **Rust ツールチェイン** | 1.80+ | サイドカーのビルド (`rustup` 推奨) |
| **C++ ビルドツール** | OS に応じて | `better-sqlite3` のネイティブビルド |

### Windows
- Visual Studio Build Tools（"Desktop development with C++"）  
- Rust: <https://rustup.rs/> から `rustup-init.exe`、または `winget install Rustlang.Rustup`

### macOS
- Xcode Command Line Tools: `xcode-select --install`（clang・python3 同梱）
- Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

---

## セットアップ

```bash
git clone <repo>
cd electron
npm install                       # 依存解決 + better-sqlite3 を Electron 向けにリビルド
npm run build:crawler             # Rust サイドカーのリリースビルド（初回必須）
```

`npm install` の `postinstall` フックで `electron-rebuild` が `better-sqlite3` を Electron の Node ABI 向けに再コンパイルします。

---

## 開発モードで起動

```bash
npm start
```

Electron が起動します。**監視スタート**を押すとメインプロセスが `crawler/target/release/crawler.exe`（または `target/debug/crawler.exe`、release がなければそちらにフォールバック）を自動 spawn し、stdio 経由でコマンドを送信します。

DevTools (`Ctrl+Shift+I`) でレンダラ側のログ、ターミナルでメインプロセス + サイドカーのログを確認できます。

### Rust 側のコードを変更したとき

```bash
npm run build:crawler             # リリースビルド再生成
```

`npm start` を再実行するとブリッジが新しいバイナリを spawn します。

---

## ビルド（配布用インストーラ）

### Windows

```bash
npm run build:win
```

→ `dist/Amazon Price Monitor-1.0.0-win.exe`（約 83 MB）

このインストーラ 1 つの中に Electron 本体と Rust サイドカー (`crawler.exe`) の両方が同梱されています。エンドユーザーは exe をダブルクリックするだけで、追加ダウンロードや手動配置は不要です。

### macOS

```bash
npm run build:mac
```

→ `dist/Amazon Price Monitor-1.0.0-mac.dmg`

クロスビルド不可（macOS でのみ実行可能）。Apple 公証は未設定のため初回起動時に「開発元を確認できない」警告が出ます。

---

## ユーザーデータ

すべて Windows の AppData 配下に保存：

```
%APPDATA%\amazon-price-monitor\
├─ amazon-monitor.db              # メインデータ（監視商品・観測履歴・設定）
├─ amazon-monitor.db-wal          # SQLite WAL
├─ amazon-monitor.db-shm
├─ Cookies                        # Amazon ログイン状態
├─ Local Storage / Session Storage
└─ screenshots/                   # 通知用一時画像
```

**アップデート時の引き継ぎ**: 新しい `.exe` を上書きインストールするだけで、上記ファイルは触られず保持されます。スキーマ変更は `migrations.js` の `IF NOT EXISTS / ADD COLUMN` 形式で後方互換を保ちつつ自動適用されます。

---

## サイドカーの IPC プロトコル

`crawler.exe` は stdin / stdout 上で改行区切り JSON を扱います。

### コマンド（Electron → サイドカー）

```json
{ "cmd": "ping" }
{ "cmd": "crawl", "asins": ["B0XXXXXXXX", "..."], "cookies": "..." }
{ "cmd": "abort" }
{ "cmd": "lift_pause" }
{ "cmd": "clear_circuit_breaker" }
{ "cmd": "shutdown" }
```

### イベント（サイドカー → Electron）

```json
{ "type": "ready", "version": "1.0.0" }
{ "type": "state", "paused_until_ms": 0, "circuit_until_ms": 0, "captcha_streak": 0 }
{ "type": "page_result", "results": [...], "page": 1, "total_pages": 6 }
{ "type": "progress", "done": 45, "total": 135, "page": 1, "total_pages": 6, "wave": 1 }
{ "type": "block", "error": "CAPTCHA", ... }
{ "type": "cycle_done", "total": 135, "found": 135, "missed": 0, ... }
```

`crawler-bridge.js` がこの変換層を担い、既存の `scheduler.js` から見た API は JS 版の `runCoverageLoop` とほぼ同一形状です。

---

## トラブルシューティング

| 症状 | 確認 |
|------|------|
| 起動時に `binary not found` | `npm run build:crawler` を実行 |
| `cargo: command not found` | ターミナルを再起動、または `$env:Path += ";$env:USERPROFILE\.cargo\bin"` |
| `better-sqlite3` で読み込みエラー | `npm run rebuild` を実行 |
| 監視スタートしても反応無し | DevTools のコンソール + メインプロセスログ (`[crawler-bridge] spawned ...`) を確認 |
| サイドカー単体テスト | `crawler.exe` に `{"cmd":"ping"}\n{"cmd":"shutdown"}` をパイプし `pong` が返ることを確認 |

---

## ライセンス

社内ツール。外部公開は未定。


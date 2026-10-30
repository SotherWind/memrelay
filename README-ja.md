<h1 align="center">MemRelay</h1>

<p align="center">
  <a href="README-en.md">English</a> ·
  <a href="README-de.md">Deutsch</a> ·
  <a href="README-es.md">Español</a> ·
  <a href="README-fr.md">Français</a> ·
  <strong>日本語</strong> ·
  <a href="README-ko.md">한국어</a> ·
  <a href="README-fa.md">فارسی</a> ·
  <a href="README-pt-BR.md">Português</a> ·
  <a href="README-id.md">Bahasa Indonesia</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README-zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <strong>AI コーディングツールをまたぐタスクリレー。</strong><br>
  Codex で半分まで進んだところで利用枠が尽きた——Claude Code に切り替えて
  「XX タスクを続けて」と普通に言うだけで、要件も進捗も説明し直さずに続きから作業できます。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.16-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.16">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#インストール">インストール</a> ·
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#ハイライト">ハイライト</a> ·
  <a href="#コマンド">コマンド</a> ·
  <a href="#対応ソース">対応ソース</a> ·
  <a href="#既知の制限">既知の制限</a> ·
  <a href="#web-ui">Web UI</a> ·
  <a href="#開発">開発</a>
</p>

## MemRelay が必要な理由

AI ツールの切り替えで進捗を失うべきではありません。

Codex で半分まで書いたところで利用枠が尽きた。Claude Code で続けたいのに、直前の状況が伝わらない。要件をもう一度説明し、進捗をもう一度説明する——あるいは諦める。

MemRelay は各ツールがローカルに残したセッション記録を直接読み、「続けて」と言われた時点で引き継ぎ内容をその場で抽出します。**旧ツール側の協力は不要。引き継ぎ文書もコピペも要りません。**

## ハイライト

- **旧エージェント側の協力は不要** — 旧ツールに何も求めません。ローカルのセッション記録を直接読み、進捗・残タスク・次の一手をその場で抽出します。
- **一度セットアップすれば、あとは普通に話すだけ** — `memrelay setup` 後は memrelay を意識する必要はありません。Skill または起動ヒントがあるツールでは、「XX タスクを続けて」で自動的に起動します。
- **進捗が自動で追いつく** — 同意のうえでツールの hooks に組み込まれ、作業の進捗がほぼリアルタイムでローカルインデックスに書き込まれます。別のツールに切り替えてもすぐ引き継げます。
- **主要ツールを網羅** — Claude Code、Qoder、Codex、Cursor、CodeBuddy、WorkBuddy、OpenCode、ZCode、Trae、DeepSeek Harness のセッションを読めます（Trae・CodeBuddy は CLI と IDE の両形式に対応）。
- **LLM 不要** — 引き継ぎ内容はルールベースでローカル抽出。既定ではオフライン・API キー不要。ベクトル意味検索、セッション要約、設定の整理は任意のオプトイン拡張です（下記）。
- **ローカル優先・取り消し可能** — データは `~/.memrelay/` のみ、テレメトリなし。他ツールへは読み取り専用で、書き込みはすべてマニフェスト化されワンクリックで取り消せます。

## インストール

Node.js ≥ 22.16 が必要です（nvm / fnm / volta / mise など可。ランチャーが利用可能な Node を自分で探します）：

```bash
npm i -g memrelay    # pnpm / yarn / bun でのグローバルインストールも可
memrelay setup
```

`setup` の流れ：インストール済みツールを**検出** → 書き込むファイルを**一覧表示**（起動ヒントとリアルタイムインデックス）→ **一度だけ確認** → 書き込み → 各ターミナルで自己テスト。

> [!NOTE]
> まず痕跡を残さず試したい場合は `memrelay setup --undo` で書き込みを一括取り消し（データは保持）。さらに `--purge` を付けるとデータも削除します。

## クイックスタート

```bash
npm i -g memrelay && memrelay setup
```

次に、「別のツールで半分まで進めた」プロジェクトを開き、Skill または起動ヒントがある連携済みツールでこう言います：

> XX タスクを続けて

エージェントは自動的に `memrelay resume` を実行し、引き継ぎ内容（どのツールで、どこまで進み、次に何をするか）を取得して作業を続けます。

## コマンド

エージェントがセッション内で自動実行（読み取り専用・出力のみ）：

| コマンド | 動作 |
|---|---|
| `memrelay resume "キーワード"` | 中断したタスクを見つけ、引き継ぎ内容を出力。ツールをまたぐリレーチェーンも一緒に含まれます |
| `memrelay resume` | キーワードなし：現在のプロジェクトで最後に中断したタスクを引き継ぐ |
| `memrelay resume <セッション id>` | 候補メニューで選んだセッションを強制的に引き継ぐ。出力にリレーマーカーが付き、新しいセッションがチェーンに繋がる |
| `memrelay search "キーワード"` | 現在のプロジェクトのセッションを検索（中国語の 2 文字語も検索可） |
| `memrelay show <セッション ID> --from N` | セッションの生ログを表示する |

自分で実行する：

| コマンド | 動作 |
|---|---|
| `memrelay doctor` | セルフチェック + セッションインデックスの構築/増分更新（`~/.memrelay/memrelay.db`） |
| `memrelay ui` | ローカル管理画面（下記） |
| `memrelay embed [--status]` | ベクトル埋め込みのバックフィル：本文を埋め込み DB に保存（設定ページでセマンティック検索を有効化済みであること）。`--status` で進捗表示 |
| `memrelay summarize [--status]` | セッション要約：設定ページで入力した要約エンドポイントで 2〜4 文の進捗要約を生成。`--status` で進捗表示 |
| `memrelay tidy [--status\|--apply\|--undo]` | ツール横断の設定整理：各ツールのグローバルメモリ/ルールを取り込み、統合して MemRelay マーカーブロックに書き戻す |
| `memrelay setup --undo` | 連携を取り消す（データは保持）。`--purge` を付けるとデータも削除 |

## 対応ソース

セッション記録を直接読み取ります。ツール側の協力は不要です：

| ツール | セッションの保存場所 |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Qoder | `~/.qoder/projects/<encoded-path>/*.jsonl`（IDE の transcript 形式を含む） |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`（メタデータは読み取り専用の `state_*.sqlite` から） |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb`（平文 KV、読み取り専用） |
| CodeBuddy | CLI：`~/.codebuddy/projects/…/*.jsonl`；IDE：`%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<ワークスペース md5>/<セッション>`（メッセージごとに 1 つの JSON） |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + `workbuddy.db` メタデータ |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | CLI は Codex 互換形式。IDE のセッションストアは暗号化されており、hook イベントからリアルタイムに再構築 |
| DeepSeek Harness | `~/.dsh/sessions/<encoded-project-dir>/session-<id>/session.v4.jsonl.zstd`（マルチフレーム zstd、読み取り専用） |

> [!NOTE]
> パスは各プラットフォームの既定のデータディレクトリに従います：上表の Cursor / CodeBuddy は Windows のパスです。macOS では `~/Library/Application Support/…`、Linux では `~/.config/…` になります。OpenCode はすべてのプラットフォームで `~/.local/share/opencode` を使用し、`~` は現在のユーザーのホームディレクトリです。

連携は 2 層構造で、すべてマニフェスト管理・取り消し可能です：**Skill**（「続けて」で memrelay を呼ぶことをツールに教える）は Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness のスキルディレクトリに書き込みます。**リアルタイムインデックス**（作業進捗を秒単位で取り込む）は Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN（hooks 三点セット。CodeBuddy の CLI と IDE は同じユーザー設定を共有）と OpenCode / DeepSeek Harness（各公式プラグイン機構）に導入します。dsh のリアルタイムインデックスはプロセス内プラグインを使用し（サンドボックスの hook プロセス制限を回避）、さらに公式 hooks 互換ブリッジを入れて起動ヒントと互換性を担います。

## 既知の制限

- **自動起動は Skill または起動ヒントに依存します**：OpenCode は現在リアルタイムインデックスのプラグインのみで、起動ヒントがありません。そのため手動で `memrelay resume` を実行する必要があります。
- **Trae IDE のセッションストアは暗号化されています**：リアルタイムインデックスを有効にした場合にのみ、hook イベントからセッションを再構築できます。Skill のみでリアルタイムインデックスを有効にしていない場合、過去のセッションは読めません。
- **ローカルセッションのみ**：マシン間の同期は行いません。未対応のツール、または暗号化されていてイベントストリームがないセッションは読めません。

## Web UI

```bash
memrelay ui
```

`127.0.0.1` のみで待ち受けるローカル画面を開きます（ワンタイムトークン付き、データはマシン外に出ません）。既定では固定ポート `4823`（使用中ならランダム）。テーマと言語はブラウザの localStorage に保存され、次回起動時に引き継がれます。

- **ダッシュボード**：ステータス概要、引き継ぎ待ちタスク、最近のタスク、直近 14 日間のアクティビティとツール/ディレクトリ分布
- **タスク一覧**：ツールをまたぐリレーチェーンを 1 つのタスクに統合。ディレクトリごとにグループ化し、最近のアクティビティ順に並べ、ステータスをリアルタイム更新
- **タスク詳細**：縦型リレーレール + 引き継ぎプレビュー + 引き継ぎプロンプトのワンクリックコピー
- **3 つのスキン**：ミニマル / コミック / ピクセル × ライト / ダーク / システム連動。テーマと言語の選択は記憶されます
- **11 種類の UI 言語**：簡体字中国語 / English / 繁体字中国語 / 日本語 / 한국어 / Español / Français / Deutsch / فارسی / Português (BR) / Bahasa Indonesia
- **セッション閲覧と検索**：全文検索（中国語対応）。ヒット箇所をハイライトしてジャンプ
- **連携管理 / プライバシー除外 / ゴミ箱 / 手動修正**（名前変更、完了マーク、リレーチェーンの分割・統合）

## オプションの拡張

セマンティック検索、セッション要約、設定の整理は既定でオフです。いずれも `memrelay ui` の設定ページで個別にエンドポイントを設定します（互いに独立し、別の上流を指定可能）。送信前にキーを秘匿化し、セマンティック検索と要約は失敗時に既存のルール抽出へ戻り、整理は失敗時に書き戻しません。

- **セマンティック検索**：セマンティックチャネルを追加し、「ログインページ」で検索しても "auth page" と書かれたセッションにヒットします。埋め込むのは user/assistant の本文のみで、OpenAI 互換のリモート `/embeddings` のみ対応。目安：約 250 セッション ≈ 2M 文字 ≈ $0.03。未変更の内容はハッシュ照合でスキップし、モデル/ホスト変更時はワンクリックで再構築できます。[設計](docs/vector-search.md)
- **セッション要約**：セッションごとに 2〜4 文の進捗要約を生成し、引き継ぎ出力（`## 任务摘要（AI 生成）`）、タスク一覧と詳細、セッション閲覧に表示します。素材はタイトル、ステータス信号、セッション末尾の直近約 20 メッセージ（≤8KB）に限定し、思考内容とツール出力は送信しません。250 セッション全量で約 1M トークン。素材が未変更ならスキップし、モデル/ホスト変更時はワンクリックで再構築できます。[設計](docs/llm-summary.md)
- **設定の整理**：各ツールのグローバルメモリ/ルールを読み取り専用で取り込み、重複と矛盾を統合して MemRelay マーカーブロックに書き戻します。マーカーブロックのみを変更し、書き込み前にバックアップ、取り消し可能、競合は自動裁定せず表示します。`memrelay ui` 実行中はソースの変化を自動確認します。[設計](docs/tidy.md)

メンテナンス：`memrelay embed` / `memrelay summarize` / `memrelay tidy` で全量補完（中断・再開可能）。`memrelay ui` 実行中はバックグラウンドで補完/確認します。

## プライバシーとセキュリティ

- データはローカルの `~/.memrelay/` のみ。テレメトリなし。既定でクラウドサービスに依存しません。
- 他ツールのローカルファイルは読み取り専用。書き込みは Skill / hooks 設定と `~/.memrelay/` のみで、すべてマニフェスト管理・取り消し可能です。
- インデックス作成時と出力前にキー検出・マスクを実施（API キー、トークン、秘密鍵、接続文字列など）。
- セマンティック検索・セッション要約・設定整理を有効にすると、関連本文/メモリ（キー秘匿化済み）が設定で指定したエンドポイントのホストに送信されます（3 機能それぞれ独立したエンドポイント）。既定はオフ。
- 画面サーバーは `127.0.0.1` のみをリッスンし、アクセストークンと Host ヘッダー検証を行います。書き込みリクエストはさらにクロスオリジンの Origin を拒否します。
- Trae IDE の hook は Trae 独自のサンドボックス内で動作し、生イベントをまず Trae の `hooks_env` に書き込むことしかできません。一般的なキー（`sk-`、GitHub トークン、AWS キー、`password/token` フィールド）はサンドボックス内で先にマスクされますが、ルールがカバーしない内容はそのコピーに残る可能性があります。連携を取り消すとこれらのファイルは削除されます。気になる環境では Trae の Skill のみを有効にし、リアルタイムインデックスを無効にできます。

## 開発

リポジトリは pnpm workspace：`packages/cli` は CLI 本体（公開物）、`packages/ui` は管理画面（ビルド成果物は CLI の `dist/ui` に統合）。

```bash
pnpm install
pnpm typecheck     # 両パッケージの tsc --noEmit
pnpm test          # vitest のユニット + 統合テスト（E2E は別途、下記）
pnpm build         # まず tsdown → packages/cli/dist/cli.mjs、次に画面を packages/cli/dist/ui へ
cd packages/cli && npm link   # 任意：memrelay を PATH に入れる（npm i -g memrelay 相当）
node packages/cli/test/e2e/bootstrap.mjs   # ランチャーのエンドツーエンド
```

設計とイテレーション計画：[docs/architecture.md](docs/architecture.md)。

## License

[MIT](LICENSE)

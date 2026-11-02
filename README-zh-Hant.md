<p align="center">
  <a href="https://github.com/SotherWind/memrelay">
    <img src="https://raw.githubusercontent.com/SotherWind/memrelay/main/design/logo/memrelay-mark-minimal-light.png" alt="MemRelay" width="320">
  </a>
</p>

<h1 align="center">MemRelay</h1>

<p align="center">
  <a href="README-en.md">English</a> ·
  <a href="README-de.md">Deutsch</a> ·
  <a href="README-es.md">Español</a> ·
  <a href="README-fr.md">Français</a> ·
  <a href="README-ja.md">日本語</a> ·
  <a href="README-ko.md">한국어</a> ·
  <a href="README-fa.md">فارسی</a> ·
  <a href="README-pt-BR.md">Português</a> ·
  <a href="README-id.md">Bahasa Indonesia</a> ·
  <a href="README.md">简体中文</a> ·
  <strong>繁體中文</strong>
</p>

<p align="center">
  <strong>跨 AI coding 工具的任務接力。</strong><br>
  在 Codex 中做到一半、額度用完了——切到 Claude Code，照常說一句「繼續完成 XX 任務」，
  它就能接著做，不用再描述需求和進度。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/memrelay"><img src="https://img.shields.io/npm/v/memrelay?color=cb3837&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/memrelay"><img src="https://img.shields.io/npm/dm/memrelay?color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/SotherWind/memrelay/actions/workflows/ci.yml"><img src="https://github.com/SotherWind/memrelay/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/SotherWind/memrelay/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.16-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.16">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#安裝">安裝</a> ·
  <a href="#快速開始">快速開始</a> ·
  <a href="#亮點">亮點</a> ·
  <a href="#命令">命令</a> ·
  <a href="#支援的來源">支援的來源</a> ·
  <a href="#已知邊界">已知邊界</a> ·
  <a href="#管理介面">管理介面</a> ·
  <a href="#開發">開發</a>
</p>

## 為什麼需要 MemRelay

切換 AI 工具，不該丟掉進度。

你在 Codex 中寫了一半，額度用完；想換 Claude Code 接著做，它不知道剛才發生了什麼。把需求再講一遍、把進度再描述一遍——或者乾脆放棄。

MemRelay 直接讀取各工具留在本機的工作階段記錄，在你說「繼續」時現場提煉出續接內容。**舊工具零配合，不用寫交接文件，不用複製貼上。**

## 亮點

- **舊 agent 零配合** — 不要求舊工具做任何事；續接時直接讀它留在本機的工作階段記錄，現場提煉進度、待辦與下一步。
- **一次接入，照常說話** — `memrelay setup` 之後不用特別提 memrelay；在帶 Skill 或啟動提示的工具裡，說「繼續完成 XX 任務」就會自動觸發。
- **進度自動跟上** — 經你同意後裝在工具的 hooks 裡，工作進度即時寫入本機索引，切到別的立即就能接上。
- **主流工具全覆蓋** — Claude Code、Qoder、Codex、Cursor、CodeBuddy、WorkBuddy、OpenCode、ZCode、Trae、DeepSeek Harness 的工作階段都能讀（Trae、CodeBuddy 支援 CLI 與 IDE 兩種格式）。
- **不依賴大型語言模型** — 續接內容依規則在本機提煉，預設不連網、不需要 API Key；向量語意搜尋、工作階段摘要與偏好整理都是可選的 opt-in 增強（見下）。
- **本機優先，可復原** — 資料只存在本機 `~/.memrelay/`，不做遙測；對其他工具唯讀，所有寫入都有清單、可一鍵復原。

## 安裝

需要 Node.js ≥ 22.16（nvm / fnm / volta / mise 等版本管理器都可以，入口程式會自己找可用的 Node）：

```bash
npm i -g memrelay    # pnpm / yarn / bun 全域安裝同樣可用
memrelay setup
```

`setup` 會：**偵測**本機裝了哪些工具 → **列出**將寫入的檔案（含啟動提示與即時索引）→ **確認一次** → 寫入 → 各終端機自測。

> [!NOTE]
> 想先試試不想留痕跡？`memrelay setup --undo` 一鍵復原寫入（保留資料）；再加 `--purge` 連資料一起刪。

## 快速開始

```bash
npm i -g memrelay && memrelay setup
```

然後打開一個「用別的工具做過一半」的專案，在帶 Skill 或啟動提示的已接入工具裡說：

> 繼續完成 XX 任務

Agent 會自動執行 `memrelay resume`，拿到續接內容（之前在哪個工具、進度到哪、接下來做什麼），然後接著做。

## 命令

Agent 在工作階段裡自動執行（唯讀、只列印）：

| 命令 | 作用 |
|---|---|
| `memrelay resume "關鍵詞"` | 找到中斷的任務，列印續接內容；跨工具接力鏈會一併帶上 |
| `memrelay resume` | 不帶關鍵詞：接目前專案裡最近中斷的任務 |
| `memrelay resume <工作階段 id>` | 從候選選單選定後強制續接該工作階段；輸出帶接力標記，新工作階段會落鏈 |
| `memrelay search "關鍵詞"` | 在目前專案的工作階段裡搜尋（中文兩字詞可搜） |
| `memrelay show <工作階段 id> --from N` | 翻看某個工作階段的原始記錄 |

你自己執行的：

| 命令 | 作用 |
|---|---|
| `memrelay doctor` | 自檢 + 建立/增量更新工作階段索引（`~/.memrelay/memrelay.db`） |
| `memrelay ui` | 本機管理介面（見下） |
| `memrelay embed [--status]` | 向量回填：把正文嵌入並寫入資料庫（需先在設定頁開啟語意檢索）；`--status` 看進度 |
| `memrelay summarize [--status]` | 工作階段摘要生成：用設定頁填寫的摘要介面壓縮成 2~4 句進度摘要；`--status` 看進度 |
| `memrelay tidy [--status\|--apply\|--undo]` | 跨工具偏好整理：匯入各工具全域記憶/規則，合併後寫回 MemRelay 標記區塊 |
| `memrelay setup --undo` | 復原接入（保留資料）；加 `--purge` 連資料一起刪 |

## 支援的來源

直接讀取工作階段記錄，不需要該工具做任何配合：

| 工具 | 工作階段在本機的位置 |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Qoder | `~/.qoder/projects/<encoded-path>/*.jsonl`（含 IDE transcript 格式） |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`（中繼資料唯讀 `state_*.sqlite`） |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb`（本機明文 KV，唯讀） |
| CodeBuddy | CLI：`~/.codebuddy/projects/…/*.jsonl`；IDE：`%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<工作區 md5>/<工作階段>`（逐則訊息 JSON） |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + `workbuddy.db` 中繼資料 |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | CLI 是 Codex 相容格式；IDE 工作階段庫加密，由 hook 事件即時重建 |
| DeepSeek Harness | `~/.dsh/sessions/<encoded-project-dir>/session-<id>/session.v4.jsonl.zstd`（多幀 zstd，唯讀） |

> [!NOTE]
> 路徑依各平台預設資料目錄解析：Cursor / CodeBuddy 上表為 Windows 路徑，macOS 為 `~/Library/Application Support/…`，Linux 為 `~/.config/…`；OpenCode 在各平台都使用 `~/.local/share/opencode`，`~` 指目前使用者的家目錄。

接入分兩層，全部走清單、可復原：**Skill**（工具知道說「繼續」時要呼叫 memrelay）寫入 Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness 的技能目錄；**即時索引**（工作進度秒級入庫）裝在 Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN（hooks 三件套；CodeBuddy 的 CLI 與 IDE 共用同一份使用者設定）與 OpenCode / DeepSeek Harness（各自的官方外掛機制）——dsh 的即時索引用行程內外掛（繞開它沙箱對 hook 行程的限制），另裝官方 hooks 相容橋負責啟動提示與相容。

## 已知邊界

- **自動觸發依賴 Skill 或啟動提示**：OpenCode 目前只有即時索引外掛，不會在工作階段開始自動提示，需要手動執行 `memrelay resume`。
- **Trae IDE 的工作階段庫加密**：只有開啟即時索引後才會用 hook 事件重建工作階段；只啟用 Skill、不啟用即時索引時，讀不到它的歷史工作階段。
- **只處理本機工作階段**：不做跨機同步；未支援的工具，或加密且沒有事件流的工作階段，無法讀取。

## 管理介面

```bash
memrelay ui
```

開啟一個只監聽 `127.0.0.1` 的本機介面（帶一次性權杖，資料不出本機）。預設使用固定連接埠 `4823`（被占用時隨機）；主題與語言儲存在瀏覽器 localStorage，下次啟動沿用。

- **儀表板**：狀態總覽、待接力任務、最近任務、近 14 天活動與工具/目錄分布
- **任務列表**：跨工具的接力鏈合成一個任務，按目錄分組、最近活動排序，狀態即時更新
- **任務詳情**：縱向接力軌 + 續接預覽 + 一鍵複製續接提示詞
- **三套面板外觀**：簡潔 / 漫畫 / 像素 × 淺色 / 深色 / 跟隨系統，主題與語言選擇會記住
- **11 種介面語言**：簡體中文 / English / 繁體中文 / 日本語 / 한국어 / Español / Français / Deutsch / فارسی / Português (BR) / Bahasa Indonesia
- **工作階段瀏覽與搜尋**：全文檢索（中文可搜），從命中處醒目提示跳入
- **接入管理 / 隱私排除 / 回收站 / 手動修正**（改名、標記完成、拆分合併接力鏈）

## 選用增強

語意檢索、工作階段摘要與偏好整理預設關閉，都在 `memrelay ui` 設定頁單獨填寫介面（三者互不影響，可指向不同上游）；送出前會做金鑰遮蔽；語意檢索與摘要失敗時自動回退到現有規則提煉，偏好整理失敗時不寫回。

- **語意檢索**：多一條語意通道，搜「登入頁」也能命中寫 "auth page" 的工作階段；只嵌 user/assistant 正文，只接 OpenAI 相容的遠端 `/embeddings`，參考量級約 250 個工作階段 ≈ 200 萬字元 ≈ $0.03。未變化的內容用雜湊對帳跳過，換模型/主機可一鍵重建向量。[設計](docs/vector-search.md)
- **工作階段摘要**：為每個工作階段產生 2~4 句進度摘要，顯示在接力輸出（`## 任务摘要（AI 生成）`）、任務列表與詳情、工作階段瀏覽；素材只取標題、狀態信號和工作階段尾部約 20 則正文（≤8KB），思考與工具輸出不傳送，250 個工作階段全量約 100 萬 token。素材未變則跳過，換模型/主機可一鍵重建摘要。[設計](docs/llm-summary.md)
- **偏好整理**：唯讀匯入各工具的全域記憶/規則，合併重複與矛盾後寫回 MemRelay 標記區塊；只寫標記區塊、寫前備份、可復原，衝突不自動裁決；`memrelay ui` 執行期間自動檢查來源變化。[設計](docs/tidy.md)

維護：`memrelay embed` / `memrelay summarize` / `memrelay tidy` 可全量補齊（可中斷續跑）；`memrelay ui` 執行期間背景自動補。

## 隱私與安全

- 資料只存在本機的 `~/.memrelay/`，不做遙測；預設不依賴任何雲端服務。
- 對其他工具的本機檔案唯讀；寫入僅限 Skill / hooks 設定與 `~/.memrelay/`，且都有清單可復原。
- 入庫與輸出前都做金鑰偵測與遮蔽（API Key、權杖、私鑰、連線字串等）。
- 語意檢索、工作階段摘要與偏好整理開啟後，相關正文/記憶（已做金鑰遮蔽）會傳送到你在設定裡指定的介面主機（三者各自獨立的介面）；預設關。
- 介面服務只監聽 `127.0.0.1`，帶存取權杖並校驗 Host 標頭；寫入請求另外拒絕跨來源 Origin。
- Trae IDE 的 hook 執行在它自己的沙箱裡，只能把原始事件先寫到 Trae 的 `hooks_env`；常見金鑰（`sk-`、GitHub token、AWS key、`password/token` 欄位）會在沙箱內先遮蔽，但規則未覆蓋的內容仍可能留在該副本裡，復原接入時會刪除這些檔案。介意這一點的環境可以只啟用 Trae 的 Skill、不啟用即時索引。

## 開發

儲存庫是 pnpm workspace：`packages/cli` 是命令列主套件（發佈物），`packages/ui` 是管理介面（建置產物併入 CLI 的 `dist/ui`）。

```bash
pnpm install
pnpm typecheck     # 兩個套件的 tsc --noEmit
pnpm test          # vitest 單元 + 整合測試（端到端案例單獨執行，見下）
pnpm build         # 先 tsdown → packages/cli/dist/cli.mjs，再建置介面到 packages/cli/dist/ui
cd packages/cli && npm link   # 選用：把 memrelay 命令裝進 PATH（等效 npm i -g memrelay）
node packages/cli/test/e2e/bootstrap.mjs   # 入口程式端到端
```

設計與迭代計畫見 [docs/architecture.md](docs/architecture.md)。

## License

[MIT](LICENSE)

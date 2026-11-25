# stockscan-tw

台股（臺灣證券交易所**上市**公司）財報瀏覽：Node.js server + Vue 網頁，從**公開資訊觀測站（MOPS）**抓每家上市公司的
Inline XBRL 財報，輸出資產負債表、綜合損益表、現金流量表、權益變動表的原始數據，並計算五大財務比率、評分、股價估值，
可以依產業瀏覽、依指標尋找股票、組自製 ETF 畫 K 線。也能編成**純前端版**，由 GitHub Actions 排程更新資料後放上 GitHub Pages。

- **公司範圍 = 目前的上市公司**：清單直接取自臺灣證券交易所 OpenAPI 的「上市公司基本資料」（`t187ap03_L`，約 1,100 家）。
  每次更新（伺服器每天、CI 每次排程）都重抓這張表：**新上市的公司當天就進來**，爬蟲下一輪就抓它的財報；
  **已下市的公司不在表上了，它的財報與評分會從資料庫移除**（只在表完整下載、筆數合理時才清，避免下載不全誤刪）。上櫃、興櫃公司不在範圍內。
- **財報來源**：公開資訊觀測站的 XBRL 財報頁（`mopsov.twse.com.tw/server-java/t164sb01`）。台灣的財報頁本身就是 Inline XBRL，
  四大報表各是一張表（代號、中英文會計項目、`ix:nonFraction`），所以列的順序、中英文科目名稱與階層直接取自表格，數值與期間取自 XBRL 事實與 context，
  不需要另外下載 taxonomy。先抓合併報表（`REPORT_ID=C`），沒有就抓個體報表（`A`；沒有子公司的公司只有這種）。
  一般業、銀行、金控、保險、證券、異業與 KY 公司的格式都能解析；存託憑證（910xxx）沒有台灣 IFRS 的 XBRL 財報，只有股價。
- **哪些季度有財報**：TWSE OpenAPI 的各產業綜合損益表（`t187ap06_L_ci`、`_basi`、`_bd`、`_fh`、`_ins`、`_mim`）列出每家公司最新公布的年度 / 季別，
  爬蟲由此往前抓；MOPS 回答「檔案不存在」的季度會記下來（`data/store/kv/mops/missing.json`），過了期限很久的不再問、最近的隔兩天再問。
- **換股成立的投資控股公司**：原公司下市、新代號同一天上市，新代號底下沒有換股前的財報——公開資訊觀測站把它們留在舊代號。
  換股屬組織重組，帳是接著的（新公司第一份財報的期初就是舊公司的期末，前三季 = 舊公司上半年 + 自己的第三季），
  所以換股前的季度抓**前身**的財報、歸到新代號下，財報頁會標明。換股比例不是 1:1 的（中化 2 股換 1 股），每股金額與股數換算成新股的基礎。
  證交所的表沒有前身欄位，對照表是手動維護的 [predecessors.js](server/lib/predecessors.js)；有公司成立當天就上市而不在表上，`npm run fetch:new` 會警告（Actions 上是 annotation）。
  前身下市時，已存的財報會轉給承接的公司而不是刪掉。
- **公告日**：取財報附註「通過財務報告之日期及程序」裡董事會通過的日期（`115年8月11日`、`民國一一五年七月三十日` 都認得），沒有才用法定期限
  （Q1 5/15、Q2 8/14、Q3 11/14、年報 3/31）。
- 財報一旦公布就不會變，解析結果存在 `data/store/`（一份財報一個 zstd 壓縮的 JSON 小檔，見「資料存放」），重啟不用重抓。
- 財報之外：財務指標與評分、股價估值、產業分類瀏覽、尋找股票、觀察名單，以及把篩選結果或觀察名單組成**自製 ETF** 畫日 K
  （股價一律 TradingView → IBKR TWS → Yahoo；K 線圖畫的就是這份日線）。

> MOPS 有流量限制：抓太快（GitHub runner 一分鐘可抓約 70 份）不到一分鐘就會被防火牆擋下，之後每個請求都回 307。
> 所以爬蟲**每 4 秒才開始抓一份**（`STOCKSCAN_MOPS_INTERVAL`，一分鐘 15 份）；被擋時整批暫停（2 分鐘起、持續被擋就加倍，最多 15 分鐘）並放慢 1.5 倍，
> 被擋的財報排到後面重試、不算失敗，連續被擋太多次就結束這一批、下一批再接著抓。
> 全部上市公司 × 最近 12 季約 13,000 份，從零開始要累積十幾個小時——CI 每個交易日收盤後一批、每批抓 60 分鐘（約 900 份），先抓每家最新一季、再往前補：
> 新 repo 跑一兩批後每家公司都有最新一季，約兩週補齊歷史；要快一點就手動執行並把 `fetch_budget` 調大（上限約 5 小時）。

## 安裝與啟動

需要 Node.js 22.13+（用到 `node:sqlite` 與 `zlib` 的 zstd；Docker 映像是 Node 24）。

```bash
npm install                # 同時安裝 web/ 的依賴
npm run build:web          # 編譯 Vue 前端到 web/dist
npm start                  # http://localhost:3000
```

開發模式（後端自動重啟、前端 HMR）：

```bash
npm run dev                         # 後端 :3000
npm --prefix web run dev            # 前端 :5173，/api 代理到 :3000
```

環境變數：

| 變數 | 說明 |
|---|---|
| `PORT` | 預設 3000 |
| `BASE_URL` | 路徑前綴（見下） |
| `STOCKSCAN_STORE` / `STOCKSCAN_CACHE` / `STOCKSCAN_BARS` | 財報與評分目錄（預設 repo 的 `data/store`）、快取 SQLite（`data/cache.sqlite`）、日線目錄（`data/bars`）；預設都相對於 repo |
| `STOCKSCAN_CRAWL=0` | 關閉背景財報爬蟲 |
| `STOCKSCAN_DEPTH` | 每家公司保留最近幾季財報（預設 12 = 三年） |
| `STOCKSCAN_FROM_YEAR` | 財報選單最早列到哪一年（預設六年前；伺服器版點到沒存的季度會即時去 MOPS 抓） |
| `STOCKSCAN_MOPS_PARALLEL` | 同時向 MOPS 開幾條連線（預設 6；MOPS 每條連線在台灣約 30 KB/s，慢的時候靠並行補） |
| `STOCKSCAN_MOPS_INTERVAL` | 兩份財報開始下載的最小間隔（毫秒，預設 4000；太快會被 MOPS 擋） |
| `STOCKSCAN_FETCH_BUDGET` | `npm run fetch:new` 的時間預算（分鐘，預設 40；`--budget` 參數優先） |
| `STOCKSCAN_BARS_CRAWL=0` | 關閉每日收盤後全市場日線的背景抓取 |
| `TV_ENABLED=0` | 不用 TradingView websocket |
| `IB_ENABLED=0`、`IB_HOST`、`IB_PORT`、`IB_CLIENT_ID` | IBKR TWS / IB Gateway（台股合約 `TWSE` / `TWD`）；沒開就走 Yahoo（`2330.TW`） |

### 純前端版（沒有伺服器也能跑）

同一份程式碼可以編成兩種部署：

| | 前後端版（`npm start` / Docker） | 純前端版（`npm run build:static`） |
|---|---|---|
| 財報頁：四大報表、只看本期、Q4 推算、財務指標、評分 | ✅ | ✅ 在瀏覽器裡算（同一套 `server/lib` 模組） |
| 尋找股票、產業分類瀏覽、搜尋 | ✅ 即時 | ✅ build 當時的快照 |
| 觀察名單、自製 ETF 的 TradingView widget 模式 | ✅ | ✅（嵌入圖由 tradingview.com 載入——純前端版唯一會連的外部服務） |
| K 線圖分頁、自製 ETF 自己算的指數與成分股報酬、股價估值 | ✅ 伺服器抓日線 | ✅ 日線隨網站發布（`data/bars`），瀏覽器自己算 |
| 沒存檔的季度即時去 MOPS 抓 | ✅ | ✗ 只有 build 時已存的財報；資料由排程重新建置 |

```bash
npm run build:static        # -> web/dist-static/（網頁 + data/store + data/bars + index/）
# 慢的部分（複製 store、解開每個財報 / 評分檔取表頭、索引 zstd -19）交給 Rust 寫的 tools/stockscan-static 平行處理：
# Linux x86_64 的 binary 已 commit 在 tools/stockscan-static/bin/（Pages 的 workflow 直接跑它）；其他平台有 cargo 時
# 第一次會自己 build；都沒有就走純 Node（結果相同、慢約 3 倍）。STOCKSCAN_STATIC_NATIVE=0 強制純 Node；--link 用 hard link 代替複製（CI 用）。
```

- 輸出：Vue app（`VITE_STATIC=1` 編譯，資料層換成 Web Worker 裡的 [api.static.worker.js](web/src/api.static.worker.js)）、`data/store` 原樣複製、`data/zdict` 字典、
  `index/*.json.zst`（靜態主機列不出目錄，所以先產好：上市公司表與每家已存的財報清單、最新評分、尋找股票的整張表（欄式）、產業分類與家數、TradingView 代號）。
  索引檔名帶內容 hash，`index/meta.json`（明文、每次重新驗證）說這次 build 用哪些檔；財報 / 評分 `.zst` 永不變，抓過一次就放進 Cache Storage。
- 用相對路徑，放在子路徑（`https://user.github.io/stockscan-tw/`）也不用改設定。
- 瀏覽器端的 localStorage 鍵與 Cache Storage 名稱用 `stockscan-tw.` / `sstw-` 前綴，跟同一個網域下的美股版 stockscan 互不干擾。

### GitHub Actions 自動更新與部署

[.github/workflows/pages.yml](.github/workflows/pages.yml)：push 到 `main` 就 build 並發佈到 GitHub Pages（repo 的 Settings → Pages → Source 選 **GitHub Actions**）。
另外**每個交易日收盤後**跑一批（台北時間週一到週五 15:10，當天日線 15:00 已定案；GitHub 排程只會晚、不會早）。
傍晚董事會之後才上傳的財報，隔一個交易日那批抓。每批：

1. `npm run fetch:new`：
   - 重抓 TWSE 上市公司表 → **新上市的公司自動納入、已下市的公司自動移除**；
   - 讀 TWSE 各產業最新一季的表，得知哪些公司已公布哪一季；
   - 計畫要抓的財報（每家最近 `STOCKSCAN_DEPTH` 季、還沒存、MOPS 沒說不存在的），**先抓每家公司最新一季、再一輪輪往前**，大公司優先；
   - 在時間預算內（每批 60 分鐘、8 條連線，約 900 份；手動執行時可填 `fetch_budget`）抓、解析、計分，沒抓完的下一批接著抓。
     補齊之後每批只剩新公布的財報，幾分鐘就結束。
2. `npm run fetch:bars`：從 TradingView 把今年的日線補到最新（`actions/cache` 在兩次 run 之間留住）。
3. 把 `data/store`、`data/bars`（已結束的年份）在 `refs/data/main` 上**多 commit 一個並 push**——repo 還沒有這個 ref 時第一次會自己建立。
   push 到 `main` 觸發的 run 不抓財報，但日線與上市公司表照樣更新、照樣 commit。
4. `npm run rescore`、`build-static`、部署。

Runner 上 `data/cache.sqlite` 用 `actions/cache` 保留；上市公司表（`listed.json`）與「MOPS 沒有的財報」清單在 data ref 裡，TWSE 暫時連不上也能 build。

### 資料存放（`refs/data/main`）

資料不在 `main`：`data/store` 與 `data/bars` 放在同一個 repo 的 ref **`refs/data/main`**（獨立的歷史，跟 `main` 沒有共同祖先）。
放在 `refs/heads/` 之外是為了 `git clone` 不會抓它；`main` 的 `.gitignore` 忽略最上層的 `data/`。本機要用 workflow 抓好的資料：

```bash
npm run data:pull      # = scripts/pull-data.sh：只抓 data ref 的 tip（--depth=1），git restore 到工作目錄
```

第一次補齊資料不想等排程慢慢累積：在 Actions 手動執行 workflow，`fetch_budget` 填 300（分鐘，job 上限 340）。
本機也能自己抓（伺服器版用，不會推上 data ref）：

```bash
npm run fetch:new -- --budget 0          # 抓到全部補齊為止（數小時；可中斷，下次接著抓）
npm run fetch:new -- --budget 10 --depth 4   # 只抓每家最近 4 季，最多 10 分鐘
```

```
data/store/listed.json                                                       TWSE 上市公司表（twse.js）：公司範圍
data/store/filings/<代號>/<代號>-<年>Q<季>__<期末>__<QR|AR>__v<解析版本>.json.zst   一份財報一檔（zstd JSON + 字典）
data/store/scores/<代號>/<代號>-<年>Q<季>__<期末>__v<評分版本>.json.zst              一份財報一個評分
data/store/kv/mops/missing.json                                              MOPS 回答「檔案不存在」的財報與時間
data/bars/<來源>/<代號>/<年>.zst、meta.json、head.zst                          日線（已結束年份進 git，今年的 head.zst 不進）
data/cache.sqlite                                                            快取：市場快照、TWSE 最新季別、爬蟲紀錄（.gitignore）
```

- 程式裡沿用的欄位名 `cik` 就是公司代號（數字，例如 2330），`accession` 是 `2330-2026Q2` 這種「代號-年Q季」；`form` 是 `QR`（季報，Q1–Q3）或 `AR`（年報，Q4）。
- 財報一旦公布就不會變，每個檔寫一次就不動；解析或評分版本升級時舊檔刪掉重建。檔名就是索引（啟動時掃目錄），沒有另外的索引檔會不同步。
- 壓縮用 **zstd + 字典**（`server/data/zdict/`，以台股財報 / 評分訓練）。字典用過就不能改；要重訓請用新的檔名：
  先以 `STOCKSCAN_ZDICT=off` 收集一個不用字典的樣本 store，再 `node server/tools/train-zdict.mjs <那個 store>`。

### 路徑前綴（BASE_URL）

放在反向代理的子路徑下（例如 `https://host/stockscan-tw/`）時設 `BASE_URL=/stockscan-tw`，前後端一起生效：
API 變成 `/stockscan-tw/api/...`、TradingView 函式庫 `/stockscan-tw/tradingview/...`、網頁在 `/stockscan-tw/`。
前端 build 用相對路徑，伺服器送出 `index.html` 時注入前綴，所以**同一份 build 換 `BASE_URL` 不用重編**。

### Docker

```bash
cp .env.example .env         # BASE_URL、PORT、STOCKSCAN_DEPTH…
docker compose up -d --build # http://localhost:3000（或 BASE_URL 下）
```

`./data` 掛進容器的 `/app/data`，重建映像後財報、評分與快取都還在；映像本身不含資料。

## 網頁

打開 http://localhost:3000 ，輸入公司代號或名稱（`2330`、`台積電`、`TSMC`），左側列出每年的 Q1 / Q2 / Q3 / FY（年報）財報，點選後右側顯示四張報表。

- **欄位**：預設「只看本期」——資產負債表只有本期末、損益表只有本季三個月（年報為全年）、現金流量表與權益變動表為期初 / 本期 / 期末。
  台灣季報的現金流量表只有年初至今，本季 = 年初至今 − 上一季的年初至今，期初現金 = 上一季期末（欄位標「推算」）；切到「財報全部欄位」可看原本的比較期間。
- **科目**：中文介面顯示財報上的中文會計項目、英文介面顯示財報上的英文項目；滑鼠移到科目上可看另一種語言與 XBRL concept。代號（1100、4000、AAAA…）就是 MOPS 標準會計科目代號。
- **權益變動表**：MOPS 把本期與去年同期分成兩張表，這裡合併成一張；各權益組成（普通股股本、資本公積、保留盈餘…）是維度欄，欄名用財報上的中英文；「簡化」只留權益總額欄。
- **Q4 推算**：左側每年多一欄「Q4*」，該年 Q1–Q3 季報與年報齊全時可按「推算」，顯示 Q1 / Q2 / Q3 / Q4* / FY 五欄的季度損益表與現金流量表（Q4 = FY − Q1 − Q2 − Q3），
  以及四個季末的資產負債表。每股金額相減只是近似（標 ≈）。
- **配色、語言**：淺色 / 深色（預設跟隨系統），中文 / 英文。
- 網址帶 `?company=2330&accession=2330-2026Q2&tab=cash_flow`，可直接分享。

### 財務指標

「財務指標」分頁以所選財報為最後一期，左舊右新，依五大財務比率排版：資產負債結構（佔總資產%）、財務結構、償債能力、經營能力、獲利能力、現金流量。
三種檢視：**逐季**（往前 8 / 12 / 20 / 40 季，季度流量先年化：單季 ×4 或近四季合計）、**逐年**（每欄 = 連續四季合計）、**同季比較**（歷年同一季）。

| 類別 | 指標 | 公式 |
|---|---|---|
| 資產負債結構 | 現金、應收帳款、存貨、流動資產、應付帳款、流動負債、長期負債、股東權益 | 各科目 ÷ 總資產 |
| 財務結構 | 負債佔資產比率 | 總負債 ÷ 總資產 |
| | 長期資金佔不動產、廠房及設備比率 | （權益總額 + 非流動負債）÷ 不動產、廠房及設備 |
| 償債能力 | 流動比率 / 速動比率 | 流動資產 ÷ 流動負債 / （流動資產 − 存貨 − 預付款項）÷ 流動負債 |
| 經營能力 | 應收款項週轉率、存貨週轉率、不動產廠房設備週轉率、總資產週轉率 | 年化流量 ÷ 平均餘額；收現 / 銷貨日數 = 365 ÷ 週轉率 |
| | 應付款項週轉率、缺現金的天數、做生意的完整週期 | 年化營業成本 ÷ 平均應付；銷貨 + 收現 − 付款天數；銷貨 + 收現天數 |
| 獲利能力 | ROA / ROE | 年化稅後淨利 ÷ 平均總資產 / 平均歸屬母公司權益 |
| | 稅前純益佔實收資本比率 | 年化稅前淨利 ÷ 股本 |
| | 毛利率、營業利益率、經營安全邊際率、純益率、每股盈餘 | 同期流量相除；EPS 用財報的基本每股盈餘 |
| 現金流量 | 現金流量比率 / 允當比率 / 再投資比率 | 年化營業現金流 ÷ 流動負債；最近 20 季營業現金流 ÷（資本支出 + 存貨增加 + 現金股利）；（營業現金流 − 股利）÷（PP&E 毛額 + 長期投資 + 其他資產 + 營運資金） |

科目對照（[indicators.js](server/lib/indicators.js) 的 `C`）：台灣財報大多用 `ifrs-full` 標準科目（`Revenue`、`GrossProfit`、`ProfitLossFromOperatingActivities`、
`CashFlowsFromUsedInOperatingActivities`…），台灣擴充科目（`tifrs-bsci-ci:OperatingCosts` 營業成本、`tifrs-SCF:NetCashFlowsFromUsedInInvestingActivities`…）
另外對到同一個指標（[quarters.js](server/lib/quarters.js) 的 `TW_ALIASES`）；應收 / 應付款項依台灣慣例把票據、帳款、關係人合計（`TW_SUMS`）。
銀行、保險、證券、金控沒有流動資產與營業成本的概念，償債、經營能力多半算不出來。

指標名稱旁有標準值的列（例如 流動比率 ≥ 250%），滑鼠移到該列時每一格依標準著色；標準在 `indicators.js` 的 `benchmark`。

### 評分、尋找股票、觀察名單

- **評分（0–100）**：對一份財報依財務指標的標準計分，五大類各 20 分（財務結構、償債能力、經營能力、獲利能力、現金流量），達標得滿分、
  差 20% 以內得一半，無法計算的項目不計、按剩餘項目換算成 100；可計算的不到 50 分（金融業）就不給分。數字就是財務指標表「單季 ×4」那一欄。
- **尋找股票**：依最新一份已下載財報的指標篩選——產業大類 / 產業、評分、任何指標的上下限，以及 TradingView 市場快照的股價、市值、本益比、殖利率等；
  每個條件可選「目前」「較上期」「較去年同期」。條件寫在網址裡。
- **產業分類**：依 TWSE 的產業別（水泥、食品、半導體、電子零組件、金融保險…，歸成九個大類）列出上市公司，市值大的在前。
- **觀察名單**：☆ 加入，存在瀏覽器的 localStorage，可自訂分類。

### 股價估值與 K 線圖

- **股價**：日線走 TradingView（`TWSE:2330`）→ IBKR TWS（`TWSE` / `TWD`）→ Yahoo（`2330.TW`）。台股收盤 13:30、盤後定價到 14:30，
  14:30 之後抓的日線一直有效到下一個交易日開盤。
- **股數**：台灣財報沒有 SEC 那種封面股數，用資產負債表的普通股股本 ÷ 每股面額（面額取自上市公司表，絕大多數為 10 元）。
- **相對估值**（本益比、股價淨值比、股價營收比、EV/EBITDA、殖利率…，各期以期末收盤計算並與歷史比較）與**絕對估值模型**（DCF、DDM、RIM、EPV、Graham…）。
- **K 線圖**分頁畫這檔股票的日線（同一份日線，含成交量與 5 / 20 / 60 日均線）；**自製 ETF** 可把尋找股票的結果、觀察名單分類或自己搜尋的股票組成指數（起點 = 100），疊上 0050 / 006208 / 0056 比較。

## API

| 路徑 | 說明 |
|---|---|
| `GET /api/search?q=台積` | 代號 / 公司名稱建議（附最新財報評分） |
| `GET /api/status` | 本機存檔數量、預抓佇列、背景爬蟲進度 |
| `GET /api/company/2330` | 公司資料 + 財報清單（新到舊），每筆有 `fiscalYear` / `fiscalPeriod`（Q1–Q3、FY）、`form`（QR / AR）、是否已存 |
| `GET /api/company/2330/statements?year=2026&period=Q2` | 指定年度 / 季度的四大報表（不帶參數 = 最新一份） |
| `GET /api/filing/2330/2330-2026Q2[?view=current]` | 指定一份財報（`view=current` 只留本期欄位） |
| `GET /api/company/2330/quarters?year=2025` | 該年的季度拆分：Q1–Q3 來自季報，FY 來自年報，Q4 推算 |
| `GET /api/company/2330/indicators?year=2026&period=Q2&n=20&basis=x4[&mode=year\|same]` | 財務指標 |
| `GET /api/company/2330/valuation?year=2026&period=Q2&n=20` | 股價估值 |
| `GET /api/browse/industry` | 產業大類與產業代碼（含家數） |
| `GET /api/browse/companies?industry=24` | 某產業的上市公司 |
| `GET /api/screen?industry=24&score_min=60&roe_min=15&sort=marketCap` / `GET /api/screen/fields` | 尋找股票 / 欄位清單 |
| `GET /api/score?ciks=2330,2317` / `GET /api/score/2330/2330-2026Q2` | 最新評分 / 一份財報的評分明細 |
| `GET /api/bars/2330` | 十年日 K |
| `POST /api/basket`、`POST /api/basket/stream` | 自製 ETF 指數 |
| `GET /api/quotes/tv-symbol/2330` | TradingView 商品代號（`TWSE:2330`） |

## 輸出格式

```jsonc
{
  "filing": {
    "cik": 2330, "companyName": "台灣積體電路製造股份有限公司", "companyNameEn": "Taiwan Semiconductor Manufacturing Co., Ltd.",
    "form": "QR", "fiscalYear": "2026", "fiscalPeriod": "Q2", "periodEnd": "2026-06-30",
    "filingDate": "2026-08-11",                     // 董事會通過日（附註二），沒有則為法定期限
    "accession": "2330-2026Q2", "reportId": "C", "consolidated": true, "unit": "單位：新臺幣仟元",
    "documentUrl": "https://mopsov.twse.com.tw/server-java/t164sb01?step=1&CO_ID=2330&SYEAR=2026&SSEASON=2&REPORT_ID=C"
  },
  "coverShares": [{ "end": "2026-06-30", "value": 25932370100, "basis": "capital", "par": 10 }],
  "statements": { "balance_sheet": {…}, "income_statement": {…}, "cash_flow": {…}, "equity": {…} },
  "allStatements": [ … ],
  "stats": { "facts": 1450, "contexts": 300, "statementRoles": 4 }
}
```

每張報表：

```jsonc
{
  "type": "balance_sheet", "title": "Balance Sheet", "titleZh": "資產負債表", "role": "tw:BalanceSheet",
  "columns": [{ "id": "AsOf20260630", "period": { "instant": "2026-06-30" }, "dimensions": {} }, …],
  "lineItems": [
    { "concept": "tw:Heading", "label": "Current assets", "labelZh": "流動資產", "depth": 1, "abstract": true, "values": {} },
    { "concept": "ifrs-full:CashAndCashEquivalents", "code": "1100", "label": "Cash and cash equivalents", "labelZh": "現金及約當現金", "depth": 2,
      "values": { "AsOf20260630": { "value": 3134218213000, "raw": "3,134,218,213", "unit": "TWD", "scale": "3", "decimals": "-3" } } }
  ]
}
```

`value` 已套用 `scale`（台灣財報多為仟元：×1000）與 `sign`。現金流量表的期初現金、權益變動表的期初餘額移到期間開始的前一天（`preferredLabel: periodStartLabel`）。

## 專案結構

| 檔案 | 內容 |
|---|---|
| `server/index.js` | Express 路由、靜態檔案 |
| `server/lib/twClient.js` | MOPS / TWSE HTTP client：並行上限、間隔、重試、高 / 低優先權（背景工作讓路） |
| `server/lib/twse.js` | TWSE OpenAPI：上市公司表（公司範圍、新上市 / 下市）、各公司最新公布季別 |
| `server/lib/mopsFiling.js` | 解析 MOPS 的 Inline XBRL 財報頁 → 四大報表 JSON |
| `server/lib/ixbrl.js` | iXBRL 基本元件：context、unit、ixt 數值轉換 |
| `server/lib/scrape.js` | 一份財報：讀存檔或向 MOPS 抓（合併 → 個體） |
| `server/lib/companies.js` | 公司查詢、財報清單（已存 + 可能已公布的季度 − MOPS 沒有的） |
| `server/lib/crawler.js` | 背景爬蟲 / CI 一輪：計畫要抓的財報、時間預算、計分 |
| `server/lib/filings.js`、`statementTypes.js`、`storeFormat.js`、`industry.js`、`companySearch.js`、`scoreModel.js`、`screen.js`、`marketFields.js` | 純計算 / 純資料模組，伺服器與純前端版共用 |
| `server/lib/current.js`、`quarters.js`、`indicators.js`、`valuation.js`、`shared/` | 只看本期、季度拆分與 Q4 推算、財務指標、估值 |
| `server/lib/store.js`、`barStore.js`、`barFormat.js` | 財報 / 評分存檔、kv 快取、日線存檔 |
| `server/lib/universe.js`、`market.js` | 產業瀏覽的公司宇宙、TradingView 台股市場快照 |
| `server/lib/bars.js`、`barCrawler.js`、`tvws.js`、`ib.js`、`prices.js`、`priceSeries.js`、`basket.js` | 日線來源、每日收盤後抓取、自製 ETF 指數 |
| `server/tools/fetch-new.mjs`、`fetch-bars.mjs`、`rescore.mjs`、`build-static.mjs`、`train-zdict.mjs` | 排程 / 手動工具 |
| `tools/stockscan-static/` | Rust：靜態版 build 的重活（平行複製、解開表頭、zstd） |
| `web/` | Vue 3 + Vite 前端 |

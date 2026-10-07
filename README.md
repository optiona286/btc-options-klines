# BTC Options K 線系統：獨立 1h 精簡專案

## 啟動
需要 Node.js 20.3 或以上，無第三方套件或安裝步驟。
執行 `npm start`，預設網址 http://127.0.0.1:5080。
Windows 可雙擊「啟動_K線系統.vbs」。原系統若已占用5080，請先停止原服務，或使用不同 PORT。
PowerShell 另用連接埠：`$env:PORT='5083'; npm start`。

## 上傳 Git 與部署
將整個本專案資料夾的檔案上傳，包含 `data/manifest.json` 與 `data/*.json.gz`。
這些資料已整理完成，不需要 G 槽、原始月份 ZIP、原系統快取或任何外部本機資料庫。
不要上傳原始 ZIP 或另外幾套模型、真實成交系統。本專案 `.gitignore` 已排除ZIP、快取、備份、環境檔。
Git 只保存原始碼與資料。部署需使用支援 Node.js 的主機；純 GitHub Pages 不能執行此後端。
啟動命令 `npm start`，使用主機提供的 `PORT`，並設定 `HOST=0.0.0.0`。
BTC/USD 現貨分析使用 Coinbase 公開 API，主機需允許對外 HTTPS 連線，不需要 API 金鑰。

## 精簡資料
資料是期權標記價格 OHLC，不是逐筆真實成交。
每個到期日一個gzip JSON，來源為原始每日ZIP中該到期日前兩天至當天的同到期合約。
每日檔名採原始 UTC 日期：例如 04-03到期使用04-01～04-03來源；畫面時間轉成台北時間，可能延伸到次日清晨。
每個合約按UTC整點聚合1h：首筆開盤、最高價最大值、最低價最小值、末筆收盤；4h由1h聚合。
目前只提供1h與4h，無法從1h還原15m。價格保留原始精度，前端期權價格顯示四捨五入整數。
保留時間、真正來源末筆結束時間、合約名稱與OHLC，移除未使用的Greeks及重複欄位。
來源無成交量或成交筆數，後端回傳null，不填造數值。
每檔內容 fields 指定資料陣列順序。`symbols` 為合約名称對應K棒陣列。
manifest記錄每個到期日的來源天數、缺失來源日期、K棒數與壓縮大小。缺少來源檔的日期不補假K棒。
檔案數與整體容量以 data/manifest.json 實際結果為準。

## 更新
本專案的資料是固定歷史快照。重讀只重讀專案data，不會下載或掃描原始ZIP。
將來需新增到期日資料時，另行轉換生成新的精簡資料，再更新Git專案。
## GitHub Pages測試版
GitHub Pages會使用static-api.js，由瀏覽器讀取data精簡資料並聚合K線，不需Node服務。使用支援DecompressionStream、AbortSignal.any的新版Edge／Chrome。BTC/USD由瀏覽器直接取得Coinbase公開行情。Node模式仍保留，登入及任何API金鑰皆不需要。

## 後續新增資料

參考 [資料轉換工具說明](資料轉換工具/README.md)。將 ZIP 放入工具的「新資料」資料夾，使用手動轉換或自動監看，更新 1h 精簡資料後自行提交上傳。原始 ZIP 不會進 Git。

# 幣安 BTC OP 成交資料 data1 雲端流程

每天台灣時間 **15:55**，GitHub Actions 執行 `update-binance-data1.yml`。

1. 從 Binance 官方 `/eapi/v1/exchangeInfo` 選出當天到期、BTCUSDT、TRADING 的所有 Call/Put，不限制履約價。
2. 使用 `/eapi/v1/klines` 抓取 **15m 真實成交 K 線**，範圍為台灣時間到期日前兩天 00:00 至抓取當下，最多到合約到期前。這與原轉換器最後保留的三日範圍一致。
3. 在雲端暫存產生相容的原始 CSV，呼叫既有 `convert-binance-data1.cjs`。
4. 在獨立暫存目錄完成合併與比對，保留成交量、成交額與成交筆數；相同合約與時間以新 K 棒取代，不累加兩次。
5. 僅更新 `data1/binance-到期日.json.gz` 與 `data1/manifest.json`，自動 commit／正常 push 至 main。Bybit 的 `data` 不在允許上傳路徑內。

這是一套獨立工作流程，與晚上 20:00 的 Bybit data 排程分開，使用不同執行群組，避免到期前的抓取被 Bybit 手動補檔阻擋。推送前重新取得遠端、rebase，再正常推送；無法整合時失敗，不強制覆寫。
使用標準 Ubuntu runner 與儲存庫的 GITHUB_TOKEN，不需要 Binance 帳戶金鑰、Cloudflare、R2 或本機電腦開機。

## 時間與來源限制

- GitHub 排程可能延後，**15:55 不保證準點啟動**。若延後至到期後，當天合約可能已從列表移除，程式會失敗並保留 Actions 紀錄；無法保證補抓已下架合約。
- 沿用接近到期前的抓取方式：最後一根 15 分鐘棒可能尚未結束，這是抓取當時的快照，並非到期結算後的完整日資料。manifest 記錄 capturedAt 與 formingBarsAtCapture。
- 一個合約 HTTP／API 請求失敗，整次不會發布部分抓取結果。空陣列與錯誤不同；完全沒有 K 線會失敗，個別合約無 K 線則列入 emptySymbols，不補假資料。
- GitHub runner 所在地可能被 Binance 拒絕（例如 HTTP 451）；程式會明確失敗，不替換交易所或偷偷使用本機來源。遇到此限制需要改用 Binance 允許地區的執行環境。
- 原始 CSV 只在雲端執行期間暫存，結束後刪除，不存 Git、R2 或 artifact。**不會自動傳回本機「原始資料／幣安成交」**；已到期合約也不保證能日後重抓原始 CSV。
- 這套流程從啟用後往前執行，不會自動修補之前漏抓的歷史到期日。可用已有的本機 CSV 另行匯入。
- 本機舊的 Windows 抓取排程未修改、未停用；此新流程不會啟動本機程式。

GitHub Actions 頁面可手動 Run workflow，expiry_date 留空使用 Binance 伺服器當下的台北日期；指定日期僅能抓取當時仍在 exchangeInfo 的合約。

本機只產生資料、不推送：`npm run data1:cloud`。正式雲端命令：`node cloud-automation/data1/run.mjs --publish`。需要 Node.js 22 與 Git。

官方 API：https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data

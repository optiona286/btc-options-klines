# BTC OP 每日雲端更新

正式排程為 GitHub Actions，每天台灣時間 **20:00**（UTC 12:00）。GitHub 排程可能因平台繁忙延後啟動。
工作流程：下載 Bybit 官方每日 BTC 選擇權 ZIP → CRC 驗證 → 沿用既有工具精簡為 1h → 更新 `data/manifest.json` → 自動提交與正常推送 `main`。
不處理 `data1`，不使用 R2，原始 ZIP 不上傳 Git。

## 雲端執行

工作流程：`.github/workflows/update-op-data.yml`。上傳到預設分支後，由 GitHub 排程執行；也可在 Actions 的 **Update BTC OP mark-price data** 頁面按 Run workflow。
自動使用此儲存庫提供的 `GITHUB_TOKEN`，只有更新工作取得 Contents write 權限。若儲存庫政策禁止寫入或 main 有分支保護，執行會失敗並保留紀錄，不會強制推送。

排程執行會從 2026-10-01 起檢查未處理的 UTC 原始日期，最多補 7 天，當天未結束的資料不下載。使用 manifest 的來源日期判斷進度，重跑沒有新資料就不產生提交。
若 404 尚未發布，保留待補日期，下次排程重試；403、網路重試失敗、ZIP 損壞或資料格式錯誤都不會上傳部分結果。執行摘要會列出已處理與待補日期。

每個到期日仍保留到期當天及前兩天的合約資料，1 分鐘聚合為 1h，Greeks 依現有專案格式移除，沒有成交量就不補造。

手動補檔可填 start_date（含）、end_date（不含）；已處理日期預設略過。官方修正舊檔時，可勾 refresh 重新處理指定範圍。超過 7 天的範圍分次執行。

原始 ZIP 僅在執行機器暫存；執行結束清除，不建立 ZIP artifact。日後本機直接從同一個 Bybit 官方網址補抓相同檔案，無須依賴執行機器在線。

## 本機同步 ZIP

需要 Node.js 22.2 以上與 PATH 中可用的 Git。
執行 `cloud-automation/同步雲端資料與原始ZIP.ps1` 或 `npm run op:sync`。
它先以 fast-forward 更新本機 main，再依 manifest 已處理的日期補抓官方 ZIP，存到轉換工具 config 設定的原始資料路徑。
2026 年沿用 `10月` 等月份資料夾，往後年份使用 `2027年/1月` 等目錄。既有 ZIP 先核對 CRC，不覆寫。
本機有未提交修改或無法 fast-forward 時會停止；不重設、不丟棄本機工作。此同步程式目前由使用者啟動，尚未安裝 Windows 開機排程。

## 選配：改用 Cloudflare 排程

目前正式排程不依賴 Cloudflare。`cloudflare/` 的 Worker 可作為外部觸發器，無 R2 綁定，也不提供公開 HTTP 觸發接口。
若日後改用 Cloudflare，先移除 GitHub workflow 的 schedule，避免兩個排程重複觸發，再配置僅限本儲存庫、Actions write 權限的 GitHub fine-grained token，存為 Worker 的 `GITHUB_TOKEN` secret。不要把權杖寫在 Git 檔案。

```powershell
cd cloud-automation/cloudflare
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

Worker cron 同樣為 `0 12 * * *`，即台灣時間 20:00。初次部署前，GitHub 預設分支必須已包含可手動觸發的 workflow。

## 本機命令

`npm run op:cloud`：只下載／精簡，不推送。`node cloud-automation/run.mjs --publish`：雲端使用；要求乾淨且與 origin/main 一致的 checkout，不會順便上傳其他本機提交。
`npm run test:op-cloud`：開發時可手動執行的離線測試；正式排程沒有測試步驟。

注意：這個流程只更新 Git 資料。使用 `GITHUB_TOKEN` 推送通常不會觸發另一個 push workflow 或 GitHub Pages 的分支來源建置；需要網站自動重新部署時，應另外設置明確的 Pages 部署工作。公開儲存庫長期無活動時，GitHub 也可能停用排程，可從 Actions 重新啟用。

官方參考：
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- https://docs.github.com/en/actions/tutorials/authenticate-with-github_token
- https://developers.cloudflare.com/workers/configuration/cron-triggers/

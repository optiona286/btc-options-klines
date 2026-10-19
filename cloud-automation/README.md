# BTC OP 網頁觸發更新

已移除 GitHub 20:00 定時排程，改由 GitHub Pages 前端觸發 update-op-data.yml 的 workflow_dispatch。Cloudflare 選配設定也已移除 cron，沒有部署或重新授權 Cloudflare。

## 使用

1. 開啟 GitHub Pages，按「手動更新 data」。
2. 在 GitHub 建立專用 Fine-grained Token，僅選 btc-options-klines，Repository permissions 設定 Actions: Read and write，設定短效期。
3. 在網頁輸入 Token。它保存在目前分頁的 sessionStorage，重新整理仍保留，不存入 localStorage、Cookie、Git、日誌或網址。關閉分頁或按清除授權時清除。請勿把 Token 貼到聊天。
4. 按一次更新，只檢查一次缺少的 UTC 來源日；有缺日才觸發雲端下載、CRC 驗證、既有 1h 精簡、資料驗證、自動提交及正常推送 main。

工作中的執行會顯示進度及紀錄連結，不再重複觸發。GitHub concurrency 仍保留，避免交錯推送。工作結束後讀回 main 的 manifest 核對，再重新載入圖表。若仍缺日期、官方 ZIP 尚未發布、或執行失敗，顯示結果，不自動重試；可按「手動更新」手動再執行。

當日尚未結束的 UTC 資料不下載，每次最多補 7 天。只處理 Bybit data，不處理幣安 data1。相同來源日已涵蓋就略過。官方修正舊檔時，可在 Actions 手動指定日期並勾選 refresh。

原始 ZIP 僅放 runner 暫存目錄，結束即刪除，不上傳 Git、不放 R2、不建立 artifact。網頁只負責觸發和監看；關閉分頁停止檢查，已啟動的雲端工作繼續執行。GitHub 工作仍可能排隊。

GitHub Pages 直接讀取遠端 main 的公開 data/data1 原始內容，避免 Actions bot 提交未觸發 Pages 重新建置而讀到舊資料。網頁與程式仍由 Pages 部署。

## 本機與手動工具

- npm run op:cloud：下載／精簡，不推送。
- node cloud-automation/run.mjs --publish：要求乾淨且與 origin/main 一致的 checkout，驗證後僅推送 data。
- npm run op:sync 或 cloud-automation/同步雲端資料與原始ZIP.ps1：fast-forward 更新本機，再依 manifest 補抓官方 ZIP 到既有原始資料路徑，不覆寫既有 ZIP。
- npm run test:op-cloud：既有離線驗證。

官方 API：https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event

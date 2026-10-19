# Bybit data 手動更新後台

網頁按一次「手動更新 data」，輸入更新密碼，由 Cloudflare Worker 觸發既有 GitHub Actions：下載官方 ZIP、CRC 驗證、精簡 1h、核對資料、自動提交 main。沒有 cron、不循環執行、不使用 R2，幣安 data1 本機工作維持原設定。

GitHub 專用 Token 僅存 Cloudflare Secret GITHUB_TOKEN，前端不取得也不保存。更新密碼的 SHA-256 雜湊存 UPDATE_PASSWORD_HASH，使用固定長度、constant-time 比對。公開介面僅允許指定專案與 main 的固定工作流程；限制 Origin、嘗試次數與更新頻率，遇到執行中的工作不再觸發第二次。GitHub concurrency 仍保留。

## 一次性設定

完成 Wrangler login 及 deploy 後，執行 cloud-automation/cloudflare/setup-local.mjs。工具只綁定 127.0.0.1 隨機連接埠，產生一次性設定網址。使用者在本機頁面輸入專用 Fine-grained Token（僅本儲存庫、Actions: Read and write）與至少 12 字元更新密碼；工具驗證後將 Token 與密碼雜湊寫入 Worker Secret，不把秘密寫入原始碼、檔案、聊天或日誌。成功後自動關閉本機設定服務。重設秘密可再次執行此工具。

前端只在本分頁記憶體保留更新密碼，GitHub Token 不會送到瀏覽器。各裝置均可用同一個更新密碼操作，不必重填 GitHub Token。請勿共用 GitHub 帳號登入密碼作為更新密碼。

## 資料行為

檢查缺少的 UTC 來源日，有缺才執行。當天未結束的來源不下載，每次最多 7 天。原始 ZIP 暫存於 runner，轉換結束即清除，不上傳 Git。工作結束後讀回 main manifest 並重新載入圖表；官方尚未發布時顯示待補，不自動重試。

程式修改後以 Wrangler deploy 部署 Worker，以 git push 部署 GitHub Pages。不要使用公開前端保存 GitHub Token。

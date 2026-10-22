# 本機 data1 自動轉換與上傳

將 15m 原始 CSV 放進 `原始資料/幣安成交`，背景程式每 10 秒檢查一次，檔案大小與修改時間穩定、且至少 10 秒未寫入後，自動沿用 convert-binance-data1.cjs 精簡、更新 data1/manifest.json、驗證 OHLC／成交量／日期／計數，再提交並上傳 Git。網路或 Git 失敗時保留 CSV，稍後重試，狀態與錯誤記錄在 資料轉換工具/.state/data1-auto/status.json 及 activity.log。

原始 CSV 不上傳。上傳在獨立的暫存 checkout 執行，只允許 data1/manifest.json 與 binance-日期.json.gz，保留遠端既有資料，不混入其他修改。相同合約、時間以新資料取代，成交量不累加；內容相同不產生重複提交。Git 成功上傳後，本機乾淨 main 以 fast-forward 同步；本機有未提交修改時保留它，狀態檔顯示同步警告。

已安裝登入工作 BTCData1AutoConvertAndPublish，登入 Windows 後隱藏啟動，不必開本機網頁。需要電腦開機、登入及連網；不是雲端監看。已有 15:50／15:55 幣安下載工作仍照常將 CSV 放入同一來源資料夾。

手動啟動：雙擊 cloud-automation/data1/start-local-watch.vbs。
手動執行一次：node cloud-automation/data1/local-watch.mjs --once。
重新安裝登入工作：powershell.exe -NoProfile -ExecutionPolicy Bypass -File cloud-automation/data1/install-local-watch.ps1。

檔名沿用 BTCUSDT_Options_all-available_15m_YYYY-MM-DD_all_klines.csv，symbols 清單、failed 清單與 1h CSV 不送入此流程。請先寫入 .partial 檔，完成後再改成最終 CSV 檔名，避免複製中的檔案被提前讀取。

線上版由遠端 main 直接讀取精簡資料，載入索引或重讀時重新取得 manifest，清除已變更資料的記憶體快取，避免資料更新後仍顯示舊索引。

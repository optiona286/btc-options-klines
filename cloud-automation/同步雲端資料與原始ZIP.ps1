$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'sync-local.mjs') --pull
if ($LASTEXITCODE -ne 0) { throw '同步尚未完成，請查看上方訊息。' }

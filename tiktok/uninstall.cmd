@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName 'Otrok Batrakan - TikTok' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -LiteralPath (Join-Path $env:APPDATA 'streak_saver\cookies.json') -ErrorAction SilentlyContinue; Write-Host 'Robot removed: scheduled task deleted, saved TikTok login deleted.'; Write-Host 'To free disk space you can also delete the folder tiktok\.venv'"
pause

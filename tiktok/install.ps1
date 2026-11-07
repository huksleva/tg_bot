#Requires -Version 5.1
<#
  Установка робота «огонёк в TikTok» для бота Отрок Батракан.
  Запуск: двойной щелчок по tiktok\install.cmd (можно запускать повторно — ничего не сломает).

  Что делает:
    1. Находит Python 3.12–3.14 (если нет — ставит 3.13 через winget).
    2. Создаёт окружение tiktok\.venv и ставит streak-saver (версии закреплены в requirements.txt).
    3. Скачивает браузер Chromium для робота.
    4. Спрашивает ник друга и текст сообщения.
    5. Открывает TikTok, чтобы ты вошёл в свой аккаунт.
    6. По желанию сразу отправляет сообщение для проверки.
    7. Создаёт задание в Планировщике: каждый день с 10:00, раз в час до успеха, и при входе в Windows.
#>
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Here     = $PSScriptRoot
$Root     = Split-Path -Parent $Here
$Venv     = Join-Path $Here ".venv"
$VPy      = Join-Path $Venv "Scripts\python.exe"
$VPyw     = Join-Path $Venv "Scripts\pythonw.exe"
$Robot    = Join-Path $Here "robot.py"
$TaskName = "Otrok Batrakan - TikTok"

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Good($text) { Write-Host $text -ForegroundColor Green }
function Abort($text) {
    Write-Host ""
    Write-Host $text -ForegroundColor Red
    Read-Host "Нажми Enter, чтобы закрыть" | Out-Null
    exit 1
}

# --- 0. Пароль для отчётов боту ---
$EnvFile = Join-Path $Root ".env"
if (-not (Test-Path $EnvFile) -or -not (Select-String -Path $EnvFile -Pattern '^RELAY_SECRET=.+' -Quiet)) {
    Abort "В файле $EnvFile нет RELAY_SECRET. Без него робот не сможет сообщать боту, отправил ли он сообщение."
}

# --- 1. Python ---
function Test-PythonExe($exe) {
    try {
        $out = & $exe -c "import sys; v = sys.version_info; print(sys.executable if (3, 12) <= v[:2] < (3, 15) else '')" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) {
            $path = ("$out").Trim()
            if ($path) { return $path }
        }
    } catch {}
    return $null
}

function Find-Python {
    foreach ($v in "3.13", "3.12", "3.14") {
        try {
            $out = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) { return ("$out").Trim() }
        } catch {}
    }
    $candidates = @("python")
    $candidates += @(Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python31*\python.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | ForEach-Object { $_.FullName })
    foreach ($c in $candidates) {
        $path = Test-PythonExe $c
        if ($path) { return $path }
    }
    return $null
}

Step "Python"
$Py = Find-Python
if (-not $Py) {
    Write-Host "Python 3.12–3.14 не найден, ставлю Python 3.13 через winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Abort "Нет winget. Установи Python 3.13 с https://www.python.org/downloads/ и запусти tiktok\install.cmd снова."
    }
    winget install --id Python.Python.3.13 -e --scope user --accept-package-agreements --accept-source-agreements
    $Py = Find-Python
    if (-not $Py) { Abort "Python установился, но я его не нахожу. Закрой окно и запусти tiktok\install.cmd ещё раз." }
}
Good "Python: $Py"

# --- 2. Окружение и streak-saver ---
Step "Окружение для робота (tiktok\.venv) и streak-saver"
if (-not (Test-Path $VPy)) {
    & $Py -m venv $Venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VPy)) { Abort "Не удалось создать окружение Python." }
}
& $VPy -m pip install --disable-pip-version-check --quiet --upgrade pip
& $VPy -m pip install --disable-pip-version-check -r (Join-Path $Here "requirements.txt")
if ($LASTEXITCODE -ne 0) { Abort "Не удалось установить streak-saver. Проверь интернет и запусти установку снова." }
Good "streak-saver установлен"

# --- 3. Браузер ---
Step "Браузер для робота (Chromium, около 150 МБ)"
& $VPy -m playwright install chromium
if ($LASTEXITCODE -ne 0) { Abort "Не удалось скачать Chromium. Проверь интернет и запусти установку снова." }
Good "Chromium готов"

# --- 4. Друг и сообщение ---
Step "Кому отправлять"
do {
    $Friend = (Read-Host "Ник друга в TikTok (username из профиля, без @)").Trim().TrimStart("@")
    if ($Friend -notmatch '^[A-Za-z0-9._]{2,24}$') { Write-Host "Нужен username: латиница, цифры, точка, подчёркивание." -ForegroundColor Yellow }
} until ($Friend -match '^[A-Za-z0-9._]{2,24}$')
$Message = (Read-Host "Что отправлять каждый день (Enter — сердечко)").Trim()
$CfgArgs = @($Robot, "configure", "--friend", $Friend)
if ($Message) { $CfgArgs += @("--message", $Message) }
& $VPy @CfgArgs
if ($LASTEXITCODE -ne 0) { Abort "Не удалось сохранить настройки робота." }

# --- 5. Вход в TikTok ---
Step "Вход в TikTok"
Write-Host "Откроется окно браузера. Войди в аккаунт, с которого будет уходить сообщение."
$Logged = $false
for ($i = 1; $i -le 3 -and -not $Logged; $i++) {
    & $VPy $Robot login
    if ($LASTEXITCODE -eq 0) { $Logged = $true }
    elseif ($i -lt 3) { Read-Host "Не вышло. Нажми Enter, чтобы попробовать ещё раз" | Out-Null }
}
if (-not $Logged) { Abort "Вход не сохранился. Запусти tiktok\install.cmd ещё раз, когда будет время." }

# --- 6. Проверка ---
Step "Проверка"
$Answer = Read-Host "Отправить сообщение @$Friend прямо сейчас, чтобы проверить? [Y/n]"
if ($Answer -notmatch '^(n|no|н|нет)$') {
    & $VPy $Robot run --force
    if ($LASTEXITCODE -eq 0) { Good "Отправлено, бот получил отчёт." }
    else { Write-Host "Не получилось — бот пришлёт напоминание. Подробности: tiktok\robot.log" -ForegroundColor Yellow }
}

# --- 7. Планировщик заданий ---
Step "Задание в Планировщике"
$Action   = New-ScheduledTaskAction -Execute $VPyw -Argument "`"$Robot`" run" -WorkingDirectory $Here
$Daily    = New-ScheduledTaskTrigger -Daily -At "10:00"
$Daily.Repetition = (New-ScheduledTaskTrigger -Once -At "10:00" -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 13)).Repetition
$User     = "$env:USERDOMAIN\$env:USERNAME"
$Logon    = New-ScheduledTaskTrigger -AtLogOn -User $User
$Logon.Delay = "PT3M"
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$Desc     = "Огонёк в TikTok: раз в день отправляет сообщение другу и сообщает боту Отрок Батракан."
try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($Daily, $Logon) -Settings $Settings -Principal $Principal -Description $Desc -Force -ErrorAction Stop | Out-Null
    Good "Задание создано: каждый день с 10:00 (повтор раз в час до успеха) и при входе в Windows."
} catch {
    try {
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($Daily) -Settings $Settings -Principal $Principal -Description $Desc -Force -ErrorAction Stop | Out-Null
        Good "Задание создано: каждый день с 10:00, повтор раз в час до успеха."
    } catch {
        Abort "Не удалось создать задание в Планировщике: $($_.Exception.Message)"
    }
}

Write-Host ""
Good "Готово. Робот будет каждый день отправлять сообщение @$Friend."
Write-Host "Если он не справится или компьютер будет выключен до 20:00, бот напишет тебе в Telegram (кнопка «Огонёк»)."
Write-Host "Обновить вход в TikTok: tiktok\login.cmd. Отправить сейчас: tiktok\run-now.cmd. Удалить робота: tiktok\uninstall.cmd."
Read-Host "Нажми Enter, чтобы закрыть" | Out-Null

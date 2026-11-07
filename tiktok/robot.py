"""Робот «огонёк в TikTok» для бота Отрок Батракан.

Работает на компьютере пользователя (Windows): раз в день отправляет другу сообщение в TikTok
и сообщает боту, получилось или нет. Если не получилось, бот напомнит отправить видео вручную.

Отправку делает streak-saver 0.1.15 (https://pypi.org/project/streak-saver/), его код проверен:
вход в TikTok (cookies) хранится только в %APPDATA%\\streak_saver, в сеть он ходит только на tiktok.com.
Робот запускает его, проверяет результат по записи last_send в его настройках и шлёт отчёт боту:
POST <BOT_URL>/tiktok/report с заголовком X-Report-Secret = RELAY_SECRET из .env в корне проекта.

Команды (Python из tiktok\\.venv):
    robot.py configure --friend USERNAME [--message ТЕКСТ]   кому и что отправлять
    robot.py login                                          войти в TikTok (откроется браузер)
    robot.py run [--force]                                  отправить, если сегодня ещё не отправлено
    robot.py status                                         что сейчас настроено
"""
from __future__ import annotations

import argparse
import configparser
import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LOG_FILE = HERE / "robot.log"
STATE_FILE = HERE / "state.json"
DEFAULT_BOT_URL = "https://my-tg-bot.leonid005xc.workers.dev"
ROBOT_NAME = "streak-saver 0.1.15"
SESSION_COOKIES = {"sessionid", "sessionid_ss", "sid_tt"}
# Тот же браузер, что использует streak-saver
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
SEND_TIMEOUT = 600  # секунд на одну попытку отправки
RETRY_PAUSE = 120  # пауза перед второй попыткой в том же запуске
MAX_FAILED_RUNS_PER_DAY = 3  # после стольких неудачных запусков за день робот ждёт завтра
NO_RETRY = {"login_required", "not_configured", "no_friends"}  # повтор не поможет
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # не мелькать окном консоли (Windows)


# ---------------- Журнал и вывод ----------------

def log(text: str) -> None:
    """Пишет строку в tiktok\\robot.log (файл обрезается, чтобы не разрастался)."""
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 300_000:
            tail = LOG_FILE.read_text(encoding="utf-8", errors="replace")[-150_000:]
            LOG_FILE.write_text(tail, encoding="utf-8")
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {text}\n")
    except OSError:
        pass


def say(text: str, to_log: bool = True) -> None:
    """Печать в консоль (под pythonw её нет) и в журнал."""
    if to_log:
        log(text)
    if sys.stdout is not None:
        try:
            print(text, flush=True)
        except Exception:
            pass


# ---------------- Настройки ----------------

def load_env() -> dict[str, str]:
    """Читает .env из корня проекта (BOT_URL, RELAY_SECRET). Переменные окружения важнее."""
    values: dict[str, str] = {}
    env_file = ROOT / ".env"
    if env_file.exists():
        for raw in env_file.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    for key in ("BOT_URL", "RELAY_SECRET"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def app_dir() -> Path:
    """Папка настроек streak-saver. typer — из того же окружения, поэтому путь совпадёт."""
    import typer

    return Path(typer.get_app_dir("streak_saver"))


def config_path() -> Path:
    return app_dir() / "config.ini"


def cookies_path() -> Path:
    return app_dir() / "cookies.json"


def read_config() -> configparser.ConfigParser | None:
    path = config_path()
    if not path.exists():
        return None
    cfg = configparser.ConfigParser()
    try:
        cfg.read(path, encoding="utf-8")
    except configparser.Error:
        return None
    if "users" not in cfg or "SETTINGS" not in cfg:
        return None
    return cfg


def write_config(cfg: configparser.ConfigParser) -> None:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        cfg.write(f)


def friends_of(cfg: configparser.ConfigParser | None) -> list[str]:
    return list(cfg["users"].keys()) if cfg else []


def last_send(cfg: configparser.ConfigParser | None) -> str:
    return cfg["SETTINGS"].get("last_send", "").strip() if cfg else ""


def cookies_info() -> tuple[bool, float | None]:
    """(есть ли вход, сколько дней назад он сохранён)."""
    path = cookies_path()
    if not path.exists():
        return False, None
    age = max(0.0, (time.time() - path.stat().st_mtime) / 86400)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False, age
    ok = isinstance(data, list) and any(isinstance(c, dict) and c.get("name") in SESSION_COOKIES for c in data)
    return ok, age


def cookies_mtime() -> float:
    try:
        return cookies_path().stat().st_mtime
    except OSError:
        return 0.0


def load_state() -> dict:
    """Состояние робота на сегодня: сколько неудачных запусков, что сообщили боту."""
    try:
        st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        st = {}
    today = date.today().isoformat()
    if st.get("date") != today:
        # Новый день: счётчики с нуля, но «ждём нового входа» переносим
        st = {"date": today, "failed_runs": 0, "reported": "", "login_block_mtime": st.get("login_block_mtime")}
    return st


def save_state(st: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    except OSError as exc:
        log(f"не удалось сохранить состояние: {exc}")


# ---------------- streak-saver ----------------

def console_python() -> str:
    """python.exe рядом с pythonw.exe — чтобы получить вывод streak-saver."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        candidate = exe.with_name("python.exe")
        if candidate.exists():
            return str(candidate)
    return str(exe)


def streak_saver(*args: str) -> list[str]:
    # -I: не подхватывать посторонние модули из текущей папки, -X utf8: вывод в UTF-8
    return [console_python(), "-I", "-X", "utf8", "-m", "streak_saver.main", *args]


def classify(output: str) -> str:
    """Причина неудачи по выводу streak-saver (он всегда завершается кодом 0)."""
    text = " ".join(output.split())
    if any(s in text for s in ("Cookies not found", "Can't find cookies", "JSONDecodeError", "Expecting value")):
        return "login_required"
    if "Config not found" in text or "Can't find config" in text:
        return "not_configured"
    if "There is no one to send messages" in text:
        return "no_friends"
    if "Failed to send messages" in text:
        return "browser_error"
    if "No messages were sent" in text or "Something happened while trying" in text:
        return "send_failed"
    if "Traceback" in text:
        return "crash"
    return "unknown"


def short_detail(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return " | ".join(lines[-3:])[-300:]


def send_once() -> tuple[bool, str, str]:
    """Одна попытка отправки. Успех — streak-saver записал last_send = сегодня."""
    env = dict(os.environ, NO_COLOR="1", COLUMNS="300")
    try:
        proc = subprocess.run(
            streak_saver("send_messages"),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SEND_TIMEOUT,
            env=env,
            cwd=str(HERE),
            creationflags=NO_WINDOW,
        )
        output = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        return False, "timeout", f"streak-saver не завершился за {SEND_TIMEOUT // 60} мин"
    except OSError as exc:
        return False, "crash", f"не удалось запустить streak-saver: {exc}"
    log("streak-saver: " + " | ".join(line.strip() for line in output.splitlines() if line.strip())[-1000:])
    if last_send(read_config()) == date.today().isoformat():
        return True, "", ""
    return False, classify(output), short_detail(output)


def check_login_online() -> bool | None:
    """Пускает ли TikTok по сохранённому входу: True — да, False — просит войти, None — не понять."""
    try:
        from playwright.sync_api import sync_playwright

        cookies = json.loads(cookies_path().read_text(encoding="utf-8"))
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
            try:
                context = browser.new_context(user_agent=USER_AGENT)
                context.add_cookies(cookies)
                page = context.new_page()
                page.goto("https://www.tiktok.com/messages", timeout=60_000)
                try:
                    page.wait_for_selector('[data-e2e="dm-new-conversation-item"]', timeout=20_000)
                    return True
                except Exception:
                    return False if "login" in page.url.lower() else None
            finally:
                browser.close()
    except Exception as exc:
        log(f"проверка входа не удалась: {exc}")
        return None


# ---------------- Отчёт боту ----------------

def report(status: str, reason: str = "", detail: str = "") -> bool:
    env = load_env()
    secret = env.get("RELAY_SECRET", "")
    url = env.get("BOT_URL", DEFAULT_BOT_URL).rstrip("/") + "/tiktok/report"
    if not secret:
        say("В .env нет RELAY_SECRET, отчёт боту не отправлен.")
        return False
    _, age = cookies_info()
    payload: dict = {"status": status, "friends": friends_of(read_config()), "robot": ROBOT_NAME}
    if reason:
        payload["reason"] = reason
    if detail:
        payload["detail"] = detail
    if age is not None:
        payload["cookiesAgeDays"] = round(age, 1)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    for attempt in range(1, 4):
        request = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Report-Secret": secret,
                "User-Agent": "OtrokBatrakanRobot/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status == 200:
                    log(f"отчёт боту: {status} {reason}".strip())
                    return True
        except urllib.error.HTTPError as exc:
            log(f"отчёт боту: HTTP {exc.code}")
            if exc.code in (400, 403):
                return False  # повтор не поможет
        except (urllib.error.URLError, OSError) as exc:
            log(f"отчёт боту: нет связи ({exc})")
        time.sleep(5 * attempt)
    return False


# ---------------- Команды ----------------

def cmd_configure(friends: list[str], message: str | None) -> int:
    names = []
    for raw in friends:
        name = raw.strip().lstrip("@").lower()
        if not re.fullmatch(r"[a-z0-9._]{2,24}", name):
            say(f"Странный ник: «{raw}». Нужен username из профиля TikTok: латиница, цифры, точка, подчёркивание.")
            return 2
        names.append(name)

    cfg = read_config()
    if cfg is None:
        cfg = configparser.ConfigParser()
        cfg["users"] = {}
        cfg["SETTINGS"] = {"last_send": "", "default_message": "❤️"}
    old = {k: cfg.get("users", k, raw=True) for k in cfg["users"]}
    cfg["users"] = {}
    for name in names:
        # % в значениях configparser считает подстановкой — экранируем, streak-saver прочитает как %
        cfg["users"][name] = old.get(name, "")
    if message and message.strip():
        cfg["SETTINGS"]["default_message"] = " ".join(message.split()).replace("%", "%%")
    elif not cfg["SETTINGS"].get("default_message", raw=True):
        cfg["SETTINGS"]["default_message"] = "❤️"
    if "last_send" not in cfg["SETTINGS"]:
        cfg["SETTINGS"]["last_send"] = ""
    write_config(cfg)
    say(f"Друг: {', '.join('@' + n for n in names)}. Сообщение: {cfg['SETTINGS']['default_message']}")
    return 0


def cmd_login() -> int:
    say("Сейчас откроется браузер с TikTok. Войди в свой аккаунт, у тебя 5 минут. Окно закроется само.", to_log=False)
    subprocess.run(streak_saver("login"), cwd=str(HERE))
    ok, _ = cookies_info()
    if ok:
        st = load_state()
        st["login_block_mtime"] = None
        st["failed_runs"] = 0
        save_state(st)
        say("Вход в TikTok сохранён.")
        return 0
    say("Вход не сохранился. Попробуй ещё раз и дождись, пока TikTok покажет ленту.")
    return 1


def cmd_run(force: bool) -> int:
    today = date.today().isoformat()
    st = load_state()
    cfg = read_config()

    if cfg is not None and force and last_send(cfg) == today:
        cfg["SETTINGS"]["last_send"] = ""  # streak-saver иначе решит, что сегодня уже отправлял
        write_config(cfg)

    if cfg is not None and last_send(cfg) == today:
        if st.get("reported") != "ok" and report("ok"):
            st["reported"] = "ok"
            save_state(st)
        say("Сегодня сообщение уже отправлено.")
        return 0

    # Не мучаем TikTok: после нескольких неудачных запусков ждём следующего дня
    if not force and st.get("failed_runs", 0) >= MAX_FAILED_RUNS_PER_DAY:
        log("сегодня уже было несколько неудачных попыток, следующая — завтра")
        return 1

    has_login, _ = cookies_info()
    if cfg is None:
        ok, reason, detail = False, "not_configured", "нет настроек streak-saver"
    elif not friends_of(cfg):
        ok, reason, detail = False, "no_friends", "не указан друг"
    elif not has_login:
        ok, reason, detail = False, "login_required", "нет сохранённого входа в TikTok"
    elif not force and st.get("login_block_mtime") and st["login_block_mtime"] == cookies_mtime():
        # TikTok уже просил войти заново, а вход с тех пор не обновлялся
        ok, reason, detail = False, "login_required", "TikTok просит войти заново"
    else:
        say("Отправляю сообщение...")
        ok, reason, detail = send_once()
        if not ok and reason not in NO_RETRY:
            online = check_login_online()
            if online is False:
                reason, detail = "login_required", "TikTok просит войти заново"
            else:
                say(f"Не получилось ({reason}), повтор через {RETRY_PAUSE // 60} мин...")
                time.sleep(RETRY_PAUSE)
                ok, reason, detail = send_once()

    if ok:
        say("Сообщение отправлено.")
        st["reported"] = "ok" if report("ok") else ""
        st["login_block_mtime"] = None
        save_state(st)
        return 0

    say(f"Не получилось: {reason}. {detail}".strip())
    st["failed_runs"] = st.get("failed_runs", 0) + 1
    if reason == "login_required":
        st["login_block_mtime"] = cookies_mtime()
    # Об одной и той же причине сообщаем боту один раз в день
    if st.get("reported") != f"fail:{reason}" and report("fail", reason, detail):
        st["reported"] = f"fail:{reason}"
    save_state(st)
    return 1


def cmd_status() -> int:
    cfg = read_config()
    has_login, age = cookies_info()
    st = load_state()
    friends = friends_of(cfg)
    say(f"Друг: {', '.join('@' + f for f in friends) if friends else 'не указан'}", to_log=False)
    if cfg:
        say(f"Сообщение: {cfg['SETTINGS'].get('default_message', '❤️')}", to_log=False)
    say(f"Последняя отправка: {last_send(cfg) or 'ещё не было'}", to_log=False)
    login = "есть" if has_login else "нет"
    if age is not None:
        login += f", сохранён {age:.0f} дн. назад"
    say(f"Вход в TikTok: {login}", to_log=False)
    say(f"Неудачных запусков сегодня: {st.get('failed_runs', 0)}", to_log=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Робот «огонёк в TikTok»")
    sub = parser.add_subparsers(dest="command", required=True)
    p_cfg = sub.add_parser("configure", help="кому и что отправлять")
    p_cfg.add_argument("--friend", action="append", required=True, help="username друга (можно несколько)")
    p_cfg.add_argument("--message", help="текст сообщения (по умолчанию сердечко)")
    sub.add_parser("login", help="войти в TikTok")
    p_run = sub.add_parser("run", help="отправить, если сегодня ещё не отправлено")
    p_run.add_argument("--force", action="store_true", help="отправить ещё раз, даже если сегодня уже отправлено")
    sub.add_parser("status", help="что настроено")
    args = parser.parse_args(argv)

    try:
        if args.command == "configure":
            return cmd_configure(args.friend, args.message)
        if args.command == "login":
            return cmd_login()
        if args.command == "run":
            return cmd_run(args.force)
        return cmd_status()
    except Exception as exc:  # непредвиденная ошибка: в журнал и, для run, боту
        log("ошибка робота:\n" + traceback.format_exc())
        if args.command == "run":
            report("fail", "crash", f"{type(exc).__name__}: {exc}"[:300])
        say(f"Ошибка: {exc}", to_log=False)
        return 3


if __name__ == "__main__":
    sys.exit(main())

from __future__ import annotations

import atexit
import http.client
import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path


APP_NAME = "雪球财经助手"
DEFAULT_PORT = 8787


def bundle_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent


def data_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    root = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return root / APP_NAME


def log_line(log_file: Path, message: str) -> None:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with log_file.open("a", encoding="utf-8") as handle:
        handle.write(f"[{stamp}] {message}\n")
    print(message, flush=True)


def port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def choose_port(log_file: Path) -> int:
    requested = int(os.environ.get("XUEQIU_PORT", str(DEFAULT_PORT)))
    for port in range(requested, requested + 20):
        if port_available(port):
            if port != requested:
                log_line(log_file, f"端口 {requested} 已占用，改用端口 {port}")
            return port
    raise RuntimeError(f"端口 {requested}-{requested + 19} 均被占用")


def wait_for_http(port: int, log_file: Path, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            connection.request("GET", "/")
            response = connection.getresponse()
            response.read()
            connection.close()
            if response.status < 500:
                log_line(log_file, f"本地网页已启动：http://127.0.0.1:{port}/")
                return
            last_error = f"HTTP {response.status}"
        except OSError as error:
            last_error = str(error)
        time.sleep(0.5)
    raise RuntimeError(f"本地网页启动超时：{last_error}")


def main() -> int:
    root = bundle_root()
    data = data_root()
    data.mkdir(parents=True, exist_ok=True)
    (data / "state").mkdir(exist_ok=True)
    log_file = data / "logs" / "launcher.log"

    node = root / "runtime" / "node.exe"
    wrangler = root / "node_modules" / "wrangler" / "bin" / "wrangler.js"
    config = root / "dist" / "server" / "wrangler.json"
    if not node.exists() or not wrangler.exists() or not config.exists():
        log_line(log_file, "打包文件不完整：缺少 Node、Wrangler 或 dist/server/wrangler.json")
        return 2

    vars_file = data / ".dev.vars"
    if not vars_file.exists():
        vars_file.write_text(
            'SIMULATION_MODE="true"\n'
            'FEISHU_VERIFICATION_TOKEN="local-test-token"\n'
            'FEISHU_ALLOWED_CHAT_IDS="simulated-finance-group"\n'
            'FEISHU_ALLOWED_CHAT_NAMES="模拟财经群"\n',
            encoding="utf-8",
        )

    try:
        port = choose_port(log_file)
    except ValueError:
        log_line(log_file, "XUEQIU_PORT 不是有效端口号")
        return 2
    except RuntimeError as error:
        log_line(log_file, str(error))
        return 2

    server_log = data / "logs" / "server.log"
    server_handle = server_log.open("a", encoding="utf-8")
    env = os.environ.copy()
    env.setdefault("WRANGLER_SEND_METRICS", "false")
    env.setdefault("NO_COLOR", "1")
    command = [
        str(node),
        str(wrangler),
        "dev",
        "--local",
        "--config",
        str(config),
        "--persist-to",
        str(data / "state"),
        "--port",
        str(port),
        "--var",
        "SIMULATION_MODE:true",
        "--var",
        "FEISHU_VERIFICATION_TOKEN:local-test-token",
        "--var",
        "FEISHU_ALLOWED_CHAT_IDS:simulated-finance-group",
        "--var",
        "FEISHU_ALLOWED_CHAT_NAMES:模拟财经群",
        "--show-interactive-dev-session",
        "false",
    ]
    log_line(log_file, f"启动服务：端口 {port}")
    process = subprocess.Popen(
        command,
        cwd=str(data),
        env=env,
        stdout=server_handle,
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    atexit.register(lambda: server_handle.close())
    atexit.register(lambda: process.poll() is None and process.terminate())

    try:
        wait_for_http(port, log_file)
        url = f"http://127.0.0.1:{port}/"
        log_line(log_file, f"请在浏览器打开：{url}")
        if os.environ.get("XUEQIU_NO_BROWSER") != "1":
            webbrowser.open(url)
        process.wait()
    except KeyboardInterrupt:
        log_line(log_file, "收到退出信号，正在关闭服务")
        process.terminate()
    except Exception as error:
        log_line(log_file, f"启动失败：{error}")
        if process.poll() is None:
            process.terminate()
        return 1
    finally:
        server_handle.close()
    return process.returncode or 0


if __name__ == "__main__":
    raise SystemExit(main())

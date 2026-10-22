from __future__ import annotations

import atexit
import http.client
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

from feishu_ui import FeishuUiCollector

APP_NAME = "雪球财经助手"
DEFAULT_PORT = 8787
BUILD_ID = os.environ.get("XUEQIU_BUILD_ID", "dev-local")
BUILD_TIME = os.environ.get("XUEQIU_BUILD_TIME", "local")


def bundle_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def data_root() -> Path:
    root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    return root / APP_NAME


def log_line(log_file: Path, message: str) -> None:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("a", encoding="utf-8") as handle:
        handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    try:
        print(message, flush=True)
    except UnicodeEncodeError:
        print(message.encode("ascii", errors="replace").decode("ascii"), flush=True)


def read_vars(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def choose_port(log_file: Path) -> int:
    try:
        requested = int(os.environ.get("XUEQIU_PORT", str(DEFAULT_PORT)))
    except ValueError as error:
        raise RuntimeError("XUEQIU_PORT 不是有效端口号") from error
    for port in range(requested, requested + 20):
        if port_available(port):
            if port != requested:
                log_line(log_file, f"端口 {requested} 已占用，改用端口 {port}")
            return port
    raise RuntimeError(f"端口 {requested}-{requested + 19} 均被占用")


def wait_for_http(port: int, log_file: Path, process: subprocess.Popen, server_log: Path) -> None:
    deadline = time.monotonic() + 60
    last_error = ""
    while time.monotonic() < deadline:
        if process.poll() is not None:
            tail = server_log.read_text(encoding="utf-8", errors="replace")[-4000:] if server_log.exists() else ""
            raise RuntimeError(f"服务进程提前退出（exit={process.returncode}）：{tail}")
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


def acquire_app_lock(data: Path, log_file: Path):
    lock_path = data / "state" / "app.lock"
    pid_path = data / "state" / "app.pid"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handle = lock_path.open("x", encoding="ascii")
    except FileExistsError:
        owner_pid = 0
        try:
            owner_pid = int(lock_path.read_text(encoding="ascii", errors="ignore").strip())
        except (OSError, ValueError):
            pass
        if owner_pid:
            try:
                os.kill(owner_pid, 0)
            except OSError:
                try:
                    lock_path.unlink()
                except OSError:
                    pass
                handle = lock_path.open("x", encoding="ascii")
            else:
                raise RuntimeError(f"雪球财经助手已有实例运行（pid={owner_pid}）")
        else:
            raise RuntimeError("雪球财经助手单实例锁已被占用")
    handle.write(str(os.getpid()))
    handle.flush()
    pid_path.write_text(str(os.getpid()), encoding="ascii")

    def release():
        try:
            handle.close()
        except OSError:
            pass
        try:
            if lock_path.exists() and lock_path.read_text(encoding="ascii", errors="ignore").strip() == str(os.getpid()):
                lock_path.unlink()
        except OSError:
            pass
        try:
            if pid_path.exists() and pid_path.read_text(encoding="ascii", errors="ignore").strip() == str(os.getpid()):
                pid_path.unlink()
        except OSError:
            pass

    atexit.register(release)
    log_line(log_file, f"单实例锁已取得 pid={os.getpid()}")
    return release


def cleanup_stale_ws(data: Path, log_file: Path) -> None:
    pid_path = data / "state" / "feishu-ws.pid"
    if not pid_path.exists():
        return
    try:
        pid = int(pid_path.read_text(encoding="ascii", errors="ignore").strip())
    except (OSError, ValueError):
        pid = 0
    if not pid:
        try:
            pid_path.unlink()
        except OSError:
            pass
        return
    command_line = ""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             f'(Get-CimInstance Win32_Process -Filter "ProcessId = {pid}").CommandLine'],
            capture_output=True, text=True, timeout=5, check=False,
        )
        command_line = result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        command_line = ""
    if "feishu-ws.mjs" not in command_line or APP_NAME not in command_line:
        log_line(log_file, f"保留非本程序 PID={pid}，未执行清理")
        return
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True, timeout=10, check=False)
        log_line(log_file, f"已清理旧飞书 WS 子进程 pid={pid}")
    except (OSError, subprocess.SubprocessError) as error:
        log_line(log_file, f"清理旧飞书 WS 子进程失败：{error}")
    try:
        pid_path.unlink()
    except OSError:
        pass



def main() -> int:
    global BUILD_ID, BUILD_TIME
    root = bundle_root()
    build_info = root / "build-info.json"
    if build_info.exists():
        try:
            metadata = json.loads(build_info.read_text(encoding="utf-8"))
            BUILD_ID = str(metadata.get("commit", BUILD_ID))
            BUILD_TIME = str(metadata.get("build_time", BUILD_TIME))
        except (OSError, ValueError, TypeError):
            pass
    data = data_root()
    data.mkdir(parents=True, exist_ok=True)
    (data / "state").mkdir(exist_ok=True)
    log_file = data / "logs" / "launcher.log"
    if not log_file.exists() or log_file.stat().st_size == 0:
        log_line(log_file, f"BUILD_ID={BUILD_ID} BUILD_TIME={BUILD_TIME}")
    cleanup_stale_ws(data, log_file)
    try:
        acquire_app_lock(data, log_file)
    except RuntimeError as error:
        log_line(log_file, str(error))
        return 3
    vars_file = data / ".dev.vars"
    if not vars_file.exists():
        vars_file.write_text(
            "SIMULATION_MODE=\"false\"\n"
            "FEISHU_APP_ID=\"\"\n"
            "FEISHU_APP_SECRET=\"\"\n"
            "FEISHU_ALLOWED_CHAT_IDS=\"\"\n"
            "FEISHU_ALLOWED_CHAT_NAMES=\"\"\n",
            encoding="utf-8",
        )
        log_line(log_file, f"已创建配置文件：{vars_file}；请填写飞书 App ID 和 App Secret，首次启动后在审核页绑定财经采集群")
    local_vars = read_vars(vars_file)
    # CI can inject non-persistent smoke-test credentials without changing the
    # user's on-disk .dev.vars.  A real .dev.vars value always wins.
    for key in ("FEISHU_APP_ID", "FEISHU_APP_SECRET"):
        if not local_vars.get(key):
            local_vars[key] = os.environ.get(key, "")
    node = root / "runtime" / "node.exe"
    wrangler = root / "node_modules" / "wrangler" / "bin" / "wrangler.js"
    config = root / "dist" / "server" / "wrangler.json"
    ws_script = root / "feishu-ws.mjs"
    if not node.exists() or not wrangler.exists() or not config.exists() or not ws_script.exists():
        log_line(log_file, "打包文件不完整：缺少 Node、Wrangler、dist 或飞书长连接脚本")
        return 2
    try:
        port = choose_port(log_file)
    except RuntimeError as error:
        log_line(log_file, str(error))
        return 2
    bridge_token = secrets.token_urlsafe(32)
    allowed_ids = local_vars.get("FEISHU_ALLOWED_CHAT_IDS", "")
    allowed_names = local_vars.get("FEISHU_ALLOWED_CHAT_NAMES", "")
    # Treat the template placeholder as an empty allowlist.  This preserves the
    # user's .dev.vars file while enabling first-message binding on a fresh PC.
    if allowed_ids.startswith("这里填") or allowed_ids.lower() in {"your-chat-id", "changeme", "todo"}:
        allowed_ids = ""
        allowed_names = ""
    simulation = local_vars.get("SIMULATION_MODE", "false").lower() == "true" or os.environ.get("XUEQIU_TEST_MODE") == "1"
    force_ws = os.environ.get("XUEQIU_TEST_FORCE_WS") == "1"
    if simulation:
        allowed_ids = allowed_ids or "simulated-finance-group"
        allowed_names = allowed_names or "模拟财经群"
    # The legacy webhook token is only needed by the CI simulation checks. In a
    # real WebSocket run it stays empty and no public callback is used.
    verification_token = local_vars.get("FEISHU_VERIFICATION_TOKEN", "")
    if simulation and not verification_token:
        verification_token = "local-test-token"
    server_log = data / "logs" / "server.log"
    server_log.parent.mkdir(parents=True, exist_ok=True)
    server_handle = server_log.open("a", encoding="utf-8")
    env = os.environ.copy()
    env.update({"WRANGLER_SEND_METRICS": "false", "NO_COLOR": "1"})
    ws_enabled = local_vars.get("FEISHU_WS_ENABLED", "false").lower() == "true" or force_ws
    ui_enabled = local_vars.get("FEISHU_UI_ENABLED", "true").lower() != "false"
    command = [str(node), str(wrangler), "dev", "--local", "--config", str(config), "--persist-to", str(data / "state"), "--port", str(port), "--var", f"SIMULATION_MODE:{str(simulation).lower()}", "--var", f"LOCAL_DESKTOP_MODE:true", "--var", f"FEISHU_VERIFICATION_TOKEN:{verification_token}", "--var", f"FEISHU_WS_ENABLED:{str(ws_enabled).lower()}", "--var", f"FEISHU_WS_BRIDGE_TOKEN:{bridge_token}", "--var", f"FEISHU_UI_BRIDGE_TOKEN:{bridge_token}", "--var", "FEISHU_LOCAL_OWNER_ID:windows-owner", "--var", f"FEISHU_ALLOWED_CHAT_IDS:{allowed_ids}", "--var", f"FEISHU_ALLOWED_CHAT_NAMES:{allowed_names}", "--show-interactive-dev-session", "false"]
    log_line(log_file, f"启动本地审核服务：端口 {port}")
    server = subprocess.Popen(command, cwd=str(root), env=env, stdout=server_handle, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
    ws_log = (data / "logs" / "feishu-ws.log").open("a", encoding="utf-8")
    ws_env = env.copy()
    ws_env.update(local_vars)
    # Pass normalized runtime values so a template placeholder never activates an allowlist.
    ws_env.update({"FEISHU_ALLOWED_CHAT_IDS": allowed_ids, "FEISHU_ALLOWED_CHAT_NAMES": allowed_names, "SIMULATION_MODE": str(simulation).lower()})
    ws_env.update({"FEISHU_WS_BRIDGE_URL": f"http://127.0.0.1:{port}/api/local/feishu", "FEISHU_WS_BRIDGE_TOKEN": bridge_token, "FEISHU_WS_LOG_FILE": str(data / 'logs' / 'feishu-ws.log'), "FEISHU_WS_LOCK_FILE": str(data / 'state' / 'feishu-ws.lock'), "FEISHU_WS_PID_FILE": str(data / 'state' / 'feishu-ws.pid')})
    ws = None
    ui_collector = None
    atexit.register(lambda: server.poll() is None and server.terminate())
    try:
        wait_for_http(port, log_file, server, server_log)
        # Start the Feishu client only after the local bridge is serving.  This
        # avoids losing the initial connection-state POST during Wrangler's
        # startup race, which otherwise leaves the UI stuck at "启动中".
        if ws_enabled:
            ws = subprocess.Popen([str(node), str(ws_script)], cwd=str(root), env=ws_env, stdout=ws_log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
            atexit.register(lambda: ws is not None and ws.poll() is None and ws.terminate())
        if ui_enabled:
            ui_log = data / "logs" / "feishu-ui.log"
            ui_collector = FeishuUiCollector(
                bridge_url=f"http://127.0.0.1:{port}/api/local/ui",
                token=bridge_token,
                data_root=data,
                log_file=ui_log,
                interval=float(local_vars.get("FEISHU_UI_POLL_SECONDS", "3") or "3"),
            )
            ui_collector.start()
            atexit.register(lambda: ui_collector is not None and ui_collector.stop())
            log_line(log_file, "飞书 UI Automation 本地采集已启动（只读取当前可见窗口）")
        url = f"http://127.0.0.1:{port}/"
        log_line(log_file, f"请在浏览器打开：{url}")
        if os.environ.get("XUEQIU_NO_BROWSER") != "1":
            webbrowser.open(url)
        server.wait()
    except KeyboardInterrupt:
        log_line(log_file, "收到退出信号，正在关闭服务")
    except Exception as error:
        log_line(log_file, f"启动失败：{error}")
        return 1
    finally:
        if ui_collector is not None:
            ui_collector.stop()
        for process in (ws, server):
            if process is not None and process.poll() is None:
                process.terminate()
        server_handle.close()
        ws_log.close()
    return server.returncode or 0


if __name__ == "__main__":
    raise SystemExit(main())


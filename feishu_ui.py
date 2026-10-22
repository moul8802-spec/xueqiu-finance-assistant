from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


class FeishuUiCollector:
    """Read Feishu's visible UI and optionally巡检 unread group rows.

    Silent mode never sends input to Feishu. Auto mode is opt-in from the
    owner-only dashboard and clicks only a visible group row, then reads the
    resulting accessibility tree. It never uses Feishu APIs, storage, cache,
    cookies, OCR, or hidden endpoints.
    """

    MODES = {"silent", "auto"}

    def __init__(self, bridge_url: str, token: str, data_root: Path, log_file: Path, interval: float = 3.0):
        self.bridge_url = bridge_url
        self.token = token
        self.data_root = data_root
        self.log_file = log_file
        self.interval = max(2.0, min(interval, 5.0))
        self.stop_event = threading.Event()
        self.skip_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.seen_file = data_root / "state" / "feishu-ui-seen.json"
        self.checkpoint_file = data_root / "state" / "feishu-ui-checkpoints.json"
        self.config_file = data_root / "state" / "feishu-ui-config.json"
        self.seen: dict[str, int] = self._load_json(self.seen_file, {})
        self.checkpoints: dict[str, dict[str, Any]] = self._load_json(self.checkpoint_file, {})
        config = self._load_json(self.config_file, {})
        self.mode = str(config.get("mode", "silent")) if config.get("mode") in self.MODES else "silent"
        self.monitoring = bool(config.get("monitoring", True))
        self.auto_running = bool(config.get("autoRunning", False))
        self.max_messages = self._clamp_max(config.get("maxMessages", 100))
        self.whitelist: list[str] = [str(item) for item in config.get("whitelist", []) if str(item).strip()]
        self.baselined = False
        self.last_control_check = 0.0
        self.last_skip_requested = 0
        self.discovered_groups: list[dict[str, Any]] = []
        self.current_scanning = ""
        self.next_group = ""
        self.cycle = {"scanned": 0, "captured": 0, "duplicates": 0, "valid": 0, "startedAt": None}

    @staticmethod
    def _clamp_max(value: Any) -> int:
        try:
            return max(1, min(int(value), 200))
        except (TypeError, ValueError):
            return 100

    @staticmethod
    def _load_json(path: Path, default: Any) -> Any:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, type(default)) else default
        except (OSError, ValueError, TypeError):
            return default

    def _save_json(self, path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    def _save_seen(self) -> None:
        self._save_json(self.seen_file, dict(list(self.seen.items())[-10000:]))

    def _save_checkpoints(self) -> None:
        self._save_json(self.checkpoint_file, self.checkpoints)

    def _save_config(self) -> None:
        self._save_json(self.config_file, {"mode": self.mode, "monitoring": self.monitoring, "autoRunning": self.auto_running, "maxMessages": self.max_messages, "whitelist": self.whitelist})

    def _log(self, message: str) -> None:
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        with self.log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")

    def _post(self, payload: dict[str, Any]) -> tuple[int, str]:
        request = urllib.request.Request(self.bridge_url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"content-type": "application/json", "x-feishu-ui-token": self.token}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return int(response.status), response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            return int(error.code), error.read().decode("utf-8", errors="replace")
        except Exception as error:
            return 0, type(error).__name__

    def _get_control(self) -> None:
        now = time.monotonic()
        if now - self.last_control_check < 2:
            return
        self.last_control_check = now
        request = urllib.request.Request(self.bridge_url, headers={"x-feishu-ui-token": self.token}, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                data = json.loads(response.read().decode("utf-8", errors="replace"))
                state = data.get("ui") if isinstance(data, dict) else None
                if not isinstance(state, dict):
                    return
                self.monitoring = bool(state.get("monitoring", self.monitoring))
                requested_mode = str(state.get("mode", self.mode))
                self.mode = requested_mode if requested_mode in self.MODES else self.mode
                self.auto_running = bool(state.get("autoRunning", self.auto_running))
                self.max_messages = self._clamp_max(state.get("maxMessages", self.max_messages))
                incoming = state.get("whitelist")
                if isinstance(incoming, list):
                    self.whitelist = [str(item) for item in incoming if str(item).strip()]
                skip_requested = int(state.get("skipRequested", 0) or 0)
                if skip_requested > self.last_skip_requested:
                    self.skip_event.set()
                self.last_skip_requested = skip_requested
        except Exception:
            pass

    @staticmethod
    def _text(element: Any) -> str:
        try:
            return str(element.window_text() or "").strip()
        except Exception:
            return ""

    @staticmethod
    def _info(element: Any, key: str) -> str:
        try:
            return str(getattr(element.element_info, key, "") or "")
        except Exception:
            return ""

    @staticmethod
    def _process_id(element: Any) -> int | None:
        try:
            value = element.process_id()
            return int(value) if value else None
        except Exception:
            return None

    def _find_chat_root(self, window: Any) -> Any:
        try:
            for element in window.descendants():
                automation_id = self._info(element, "automation_id").lower()
                name = self._text(element).lower()
                control_type = self._info(element, "control_type").lower()
                if "messenger-chat" in automation_id or ("messenger-chat" in name and control_type in {"document", "pane", "window"}):
                    return element
        except Exception:
            return None
        return None

    def _text_elements(self, root: Any) -> list[tuple[Any, str]]:
        values: list[tuple[Any, str]] = []
        try:
            for element in (root.descendants() if root is not None else []):
                if self._info(element, "control_type") != "Text":
                    continue
                value = self._text(element)
                if value:
                    values.append((element, value))
        except Exception:
            return values
        return values

    @staticmethod
    def _is_time(value: str) -> bool:
        return bool(re.fullmatch(r"(?:[01]?\d|2[0-3]):[0-5]\d", value) or re.fullmatch(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", value) or value in {"昨天", "前天"} or value.startswith("星期"))

    @staticmethod
    def _is_count(value: str) -> bool:
        return bool(re.fullmatch(r"\d{1,5}", value)) and int(value) > 0

    @staticmethod
    def _looks_group_name(value: str) -> bool:
        if not value or len(value) > 80 or value in {"消息", "群组", "单聊", "云文档", "话题", "已完成", "标签", "豆包工作"}:
            return False
        if value in {"自定义机器人", "财经消息采集", "用户135159"} or value.startswith("组 ID"):
            return False
        return not value.isdigit() and "：" not in value and ":" not in value

    def _discover_unread_groups(self, window: Any) -> list[dict[str, Any]]:
        pairs = self._text_elements(window)
        values = [value for _, value in pairs]
        stop = next((index for index, value in enumerate(values) if value == "欢迎加入群组"), len(values))
        groups: list[dict[str, Any]] = []
        for index in range(1, max(1, stop - 1)):
            count_text, name = values[index - 1], values[index]
            time_text = values[index + 1] if index + 1 < stop else ""
            if not self._is_count(count_text) or not self._looks_group_name(name) or not self._is_time(time_text):
                continue
            if any(item["name"] == name for item in groups):
                continue
            groups.append({"name": name, "unreadCount": int(count_text), "lastTime": time_text, "element": pairs[index][0]})
        return groups

    def _visible_texts(self, root: Any) -> list[str]:
        return [value for _, value in self._text_elements(root)]

    def _parse_messages(self, group_name: str, texts: list[str]) -> list[dict[str, Any]]:
        ignored = {group_name, "欢迎加入群组", "你可以尝试以下操作，快速开始协作", "置顶重要链接", "完善群信息", "完善群公告", "撤销邀请", "发送给 " + group_name, "Shift + Enter 换行", "图片"}
        cleaned = [item for item in texts if item not in ignored and not item.startswith("你可以尝试")]
        messages: list[dict[str, Any]] = []
        sender = "未知发送者"
        index = 0
        while index < len(cleaned):
            value = cleaned[index]
            if not value or value.startswith("组 ID") or re.fullmatch(r"\d{5,}", value):
                index += 1
                continue
            if value in {"自定义机器人", "财经消息采集"} or re.match(r"^(用户|成员|机器人)", value) or (len(value) <= 40 and not re.search(r"[。！？:：,，]", value)):
                sender = value
                index += 1
                continue
            if value in {"@", ":"}:
                index += 1
                continue
            message_type = "image" if "[图片]" in value or value == "[图片]" else ("link" if re.search(r"https?://", value) else "text")
            messages.append({"sender": sender, "text": value[:12000], "messageTime": int(time.time() * 1000), "messageType": message_type})
            index += 1
        return messages[-200:]

    @staticmethod
    def _fingerprint(group_name: str, message: dict[str, Any]) -> str:
        return hashlib.sha256(f"{group_name}\n{message.get('sender', '')}\n{message.get('text', '')}".encode("utf-8")).hexdigest()

    def _post_diagnostic(self, window: Any, title: str, group_name: str, messages: list[dict[str, Any]], error: str = "") -> None:
        self._post({"type": "diagnostic", "state": "monitoring" if self.monitoring else "paused", "pid": self._process_id(window), "windowTitle": title, "currentChat": group_name, "messageCount": len(messages), "lastSummary": messages[-1]["text"][:100] if messages else "", "error": error, "mode": self.mode, "autoRunning": self.auto_running, "maxMessages": self.max_messages, "whitelist": self.whitelist, "discoveredGroups": [{k: v for k, v in item.items() if k != "element"} for item in self.discovered_groups], "currentScanning": self.current_scanning, "nextGroup": self.next_group, "cycle": self.cycle})

    def _scan_current_chat(self, window: Any, auto: bool = False) -> tuple[int, int, str]:
        root = self._find_chat_root(window)
        texts = self._visible_texts(root if root is not None else window)
        welcome_index = next((index for index, item in enumerate(texts) if item == "欢迎加入群组"), -1)
        if welcome_index >= 0:
            prefix = texts[max(0, welcome_index - 20):welcome_index]
            group_name = next((item for item in prefix if self._looks_group_name(item)), "")
            texts = texts[welcome_index + 1:]
        else:
            group_name = next((item for item in texts[:20] if self._looks_group_name(item)), "")
        messages = self._parse_messages(group_name, texts) if group_name else []
        self._post_diagnostic(window, self._text(window) or "飞书", group_name, messages)
        if not group_name:
            return 0, 0, ""
        if not auto:
            if not self.baselined:
                for message in messages:
                    self.seen.setdefault(self._fingerprint(group_name, message), int(time.time() * 1000))
                self._save_seen()
                self.baselined = True
                self._log(f"UIA 基线建立 chat={group_name} visible={len(messages)}")
                return 0, 0, group_name
            candidates = messages
        else:
            checkpoint = self.checkpoints.get(group_name, {})
            last_fp = str(checkpoint.get("lastMessageFingerprint", ""))
            start = next((index + 1 for index, message in enumerate(messages) if self._fingerprint(group_name, message) == last_fp), 0)
            candidates = messages[start:][-self.max_messages:]
        captured = duplicates = 0
        last_fingerprint = str(self.checkpoints.get(group_name, {}).get("lastMessageFingerprint", ""))
        last_time = int(self.checkpoints.get(group_name, {}).get("lastMessageTime", 0) or 0)
        for message in candidates:
            fingerprint = self._fingerprint(group_name, message)
            last_fingerprint, last_time = fingerprint, int(message["messageTime"])
            if fingerprint in self.seen:
                duplicates += 1
                continue
            self.seen[fingerprint] = int(time.time() * 1000)
            payload = {"type": "message", "chatName": group_name, "chatId": "ui:" + hashlib.sha256(group_name.encode("utf-8")).hexdigest()[:24], "senderName": message["sender"], "text": message["text"], "messageTime": message["messageTime"], "messageType": message["messageType"], "fingerprint": fingerprint, "eventTimestamp": int(time.time() * 1000)}
            status, detail = self._post(payload)
            if 200 <= status < 300:
                captured += 1
            self._log(f"新消息 bridge HTTP {status} chat={group_name} sender={message['sender'][:40]} fingerprint={fingerprint[:12]} detail={detail[:160]}")
        self._save_seen()
        if auto:
            self.checkpoints[group_name] = {"lastMessageFingerprint": last_fingerprint, "lastMessageTime": last_time, "lastScanAt": int(time.time() * 1000)}
            self._save_checkpoints()
        return captured, duplicates, group_name

    def _click_group(self, item: dict[str, Any]) -> bool:
        element = item.get("element")
        if element is None:
            return False
        try:
            element.click_input()
            self._log(f"自动巡检打开群：{item['name']} unread={item['unreadCount']}")
            return True
        except Exception as error:
            self._log(f"自动巡检打开群失败 chat={item['name']} error={type(error).__name__}")
            return False

    def _auto_cycle(self, window: Any) -> None:
        self.discovered_groups = self._discover_unread_groups(window)
        allowed = set(self.whitelist)
        groups = [item for item in self.discovered_groups if item["name"] in allowed]
        self.cycle = {"scanned": 0, "captured": 0, "duplicates": 0, "valid": 0, "startedAt": int(time.time() * 1000)}
        self.next_group = groups[0]["name"] if groups else ""
        self._post_diagnostic(window, self._text(window) or "飞书", "", [], "")
        for index, item in enumerate(groups):
            if self.stop_event.is_set() or not self.auto_running or not self.monitoring:
                break
            self.current_scanning = item["name"]
            self.next_group = groups[index + 1]["name"] if index + 1 < len(groups) else ""
            self._post_diagnostic(window, self._text(window) or "飞书", self.current_scanning, [], "")
            if not self._click_group(item):
                continue
            time.sleep(0.8)
            captured, duplicates, _ = self._scan_current_chat(window, auto=True)
            self.cycle["scanned"] += 1
            self.cycle["captured"] += captured
            self.cycle["duplicates"] += duplicates
            self.cycle["valid"] += captured
            if self.skip_event.is_set():
                self.skip_event.clear()
            time.sleep(0.2)
        self.current_scanning = ""
        self._post_diagnostic(window, self._text(window) or "飞书", "", [], "")

    def _scan(self) -> None:
        from pywinauto import Desktop
        windows = [item for item in Desktop(backend="uia").windows() if self._text(item) == "飞书"]
        if len(windows) != 1:
            self._post({"type": "diagnostic", "state": "not_detected", "windowTitle": "飞书" if windows else "", "error": f"找到飞书窗口 {len(windows)} 个", "mode": self.mode})
            self._log(f"UIA 状态：未唯一识别飞书窗口 count={len(windows)}")
            return
        window = windows[0]
        if self.mode == "auto":
            self.discovered_groups = self._discover_unread_groups(window)
            if self.auto_running and self.monitoring:
                self._auto_cycle(window)
            else:
                self._post_diagnostic(window, self._text(window) or "飞书", "", [], "")
            return
        self._scan_current_chat(window, auto=False)

    def run(self) -> None:
        self._log("飞书 UIA 采集器启动：支持静默监听与自动巡检未读群；不读取缓存/API")
        self._post({"type": "diagnostic", "state": "starting", "windowTitle": "", "error": "", "mode": self.mode, "maxMessages": self.max_messages, "whitelist": self.whitelist})
        try:
            import pywinauto  # noqa: F401
        except Exception as error:
            self._log(f"UIA_UNAVAILABLE error={type(error).__name__}")
            self._post({"type": "diagnostic", "state": "unavailable", "error": "pywinauto 未打包"})
            return
        while not self.stop_event.is_set():
            try:
                self._get_control()
                self._save_config()
                self._scan()
            except Exception as error:
                self._log(f"UIA 扫描失败 code={type(error).__name__}")
                self._post({"type": "diagnostic", "state": "error", "error": type(error).__name__, "mode": self.mode})
            self.stop_event.wait(self.interval)

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self.run, name="feishu-ui-collector", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=3)


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
    """Read only the currently visible Feishu desktop UI through UI Automation.

    This collector never opens chats, clicks controls, reads Feishu storage, or
    uses cookies/tokens. It only inspects the accessibility tree exposed by the
    foreground Feishu window.
    """

    def __init__(self, bridge_url: str, token: str, data_root: Path, log_file: Path, interval: float = 3.0):
        self.bridge_url = bridge_url
        self.token = token
        self.data_root = data_root
        self.log_file = log_file
        self.interval = max(2.0, min(interval, 5.0))
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.seen_file = data_root / "state" / "feishu-ui-seen.json"
        self.seen: dict[str, int] = self._load_seen()
        self.baselined = False
        self.monitoring = True
        self.last_control_check = 0.0

    def _log(self, message: str) -> None:
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        with self.log_file.open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")

    def _load_seen(self) -> dict[str, int]:
        try:
            raw = json.loads(self.seen_file.read_text(encoding="utf-8"))
            return {str(k): int(v) for k, v in raw.items()} if isinstance(raw, dict) else {}
        except (OSError, ValueError, TypeError):
            return {}

    def _save_seen(self) -> None:
        self.seen_file.parent.mkdir(parents=True, exist_ok=True)
        self.seen_file.write_text(json.dumps(dict(list(self.seen.items())[-5000:]), ensure_ascii=False), encoding="utf-8")

    def _post(self, payload: dict[str, Any]) -> tuple[int, str]:
        request = urllib.request.Request(
            self.bridge_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"content-type": "application/json", "x-feishu-ui-token": self.token},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return int(response.status), response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            return int(error.code), error.read().decode("utf-8", errors="replace")
        except Exception as error:
            return 0, type(error).__name__

    def _get_control(self) -> None:
        now = time.monotonic()
        if now - self.last_control_check < 5:
            return
        self.last_control_check = now
        request = urllib.request.Request(self.bridge_url, headers={"x-feishu-ui-token": self.token}, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                data = json.loads(response.read().decode("utf-8", errors="replace"))
                state = data.get("ui") if isinstance(data, dict) else None
                if isinstance(state, dict) and "monitoring" in state:
                    self.monitoring = bool(state.get("monitoring"))
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

    def _find_chat_root(self, window: Any) -> Any:
        try:
            for element in window.descendants():
                if self._info(element, "automation_id") == "messenger-chat":
                    return element
        except Exception:
            return None
        return None

    def _visible_texts(self, root: Any) -> list[str]:
        values: list[str] = []
        try:
            elements = root.descendants() if root is not None else []
            for element in elements:
                if self._info(element, "control_type") != "Text":
                    continue
                value = self._text(element)
                if value and value not in values:
                    values.append(value)
        except Exception:
            return values
        return values

    def _parse_messages(self, group_name: str, texts: list[str]) -> list[dict[str, Any]]:
        ignored = {
            group_name, "欢迎加入群组", "你可以尝试以下操作，快速开始协作",
            "置顶重要链接", "完善群信息", "完善群公告", "撤销邀请",
            "发送给 " + group_name, "Shift + Enter 换行", "图片",
        }
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
            text = value
            message_type = "image" if "[图片]" in text or text == "[图片]" else ("link" if re.search(r"https?://", text) else "text")
            message_time = int(time.time() * 1000)
            messages.append({
                "sender": sender,
                "text": text[:12000],
                "messageTime": message_time,
                "messageType": message_type,
            })
            index += 1
        return messages[-80:]

    def _scan(self) -> None:
        from pywinauto import Desktop

        windows = [item for item in Desktop(backend="uia").windows() if self._text(item) == "飞书"]
        if len(windows) != 1:
            self._post({"type": "diagnostic", "state": "not_detected", "windowTitle": "飞书" if windows else "", "error": f"找到飞书窗口 {len(windows)} 个"})
            self._log(f"UIA 状态：未唯一识别飞书窗口 count={len(windows)}")
            return
        window = windows[0]
        title = self._text(window) or "飞书"
        root = self._find_chat_root(window)
        if root is None:
            self._post({"type": "diagnostic", "state": "detected", "windowTitle": title, "error": "未找到 messenger-chat 可访问性节点"})
            self._log("UIA 状态：找到飞书窗口，但未找到 messenger-chat 节点")
            return
        texts = self._visible_texts(root)
        group_name = next((item for item in texts[:12] if item and len(item) <= 80), "")
        messages = self._parse_messages(group_name, texts)
        summary = messages[-1]["text"][:100] if messages else ""
        self._post({
            "type": "diagnostic", "state": "monitoring" if self.monitoring else "paused",
            "pid": self._info(window, "process_id"), "windowTitle": title,
            "currentChat": group_name, "messageCount": len(messages),
            "lastSummary": summary, "error": "",
        })
        if not self.monitoring:
            return
        if not self.baselined:
            for message in messages:
                fingerprint = hashlib.sha256((group_name + "\n" + message["sender"] + "\n" + message["text"]).encode("utf-8")).hexdigest()
                self.seen.setdefault(fingerprint, int(time.time() * 1000))
            self._save_seen()
            self.baselined = True
            self._log(f"UIA 基线建立 chat={group_name or '未命名'} visible={len(messages)}")
            return
        for message in messages:
            fingerprint = hashlib.sha256((group_name + "\n" + message["sender"] + "\n" + message["text"]).encode("utf-8")).hexdigest()
            if fingerprint in self.seen:
                continue
            self.seen[fingerprint] = int(time.time() * 1000)
            payload = {
                "type": "message", "chatName": group_name or "当前飞书群",
                "chatId": "ui:" + hashlib.sha256((group_name or "当前飞书群").encode("utf-8")).hexdigest()[:24],
                "senderName": message["sender"], "text": message["text"],
                "messageTime": message["messageTime"], "messageType": message["messageType"],
                "fingerprint": fingerprint, "eventTimestamp": int(time.time() * 1000),
            }
            status, detail = self._post(payload)
            self._log(f"新消息 bridge HTTP {status} chat={group_name or '未命名'} sender={message['sender'][:40]} fingerprint={fingerprint[:12]} detail={detail[:160]}")
        self._save_seen()

    def run(self) -> None:
        self._log("飞书 UIA 采集器启动：仅读取当前可见窗口，不操作鼠标键盘，不读取缓存/API")
        self._post({"type": "diagnostic", "state": "starting", "windowTitle": "", "error": ""})
        try:
            import pywinauto  # noqa: F401
        except Exception as error:
            self._log(f"UIA_UNAVAILABLE error={type(error).__name__}")
            self._post({"type": "diagnostic", "state": "unavailable", "error": "pywinauto 未打包"})
            return
        while not self.stop_event.is_set():
            try:
                self._get_control()
                self._scan()
            except Exception as error:
                self._log(f"UIA 扫描失败 code={type(error).__name__}")
                self._post({"type": "diagnostic", "state": "error", "error": type(error).__name__})
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

# iPhone 快捷指令配置

在网站“设备消息上传”中配对 iPhone，令牌只显示一次。快捷指令只使用 HTTPS POST，正文不放在 URL 中。

1. 新建快捷指令并打开“在共享表单中显示”，接收类型选择“文本”。如果不使用分享菜单，可先添加“获取剪贴板”动作。
2. 添加“询问是否继续”或“显示提醒”确认动作；选择取消时直接结束。
3. 添加“获取 URL 内容”：URL 填网站显示的 `/api/device/import` 地址，方法 `POST`，请求头添加 `Authorization: Bearer 你的设备令牌` 与 `Content-Type: application/json`。
4. 请求体选择 JSON，字段为：`sourceLabel`（例如“iPhone 分享菜单”）、`text`（快捷指令输入或剪贴板）、`confirmed`（布尔值 true）、`clientMessageId`（生成 UUID）。
5. 运行一次，看到“已提交”后回到网站审核队列。错误时保留服务端返回的错误码，不要重试已撤销的令牌。

令牌只允许写入待审核队列，不能读取草稿、来源或历史；不再使用时在网站撤销即可。

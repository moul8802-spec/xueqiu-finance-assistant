# Windows 主动剪贴板上传

这个脚本只读取你主动复制到 Windows 剪贴板的文本，不扫描飞书窗口、进程、缓存或隐藏接口。按 `Ctrl+Alt+F` 后会先弹窗显示预览，只有点击“是”才会通过 HTTPS POST 上传到待审核队列。

1. 在网站“设备消息上传”中配对 Windows，复制一次性设备令牌。
2. 在 PowerShell 当前窗口设置环境变量（不要把令牌写入脚本或 URL）：

```powershell
$env:FEISHU_XUEQIU_ENDPOINT = "https://你的站点域名/api/device/import"
$env:FEISHU_XUEQIU_DEVICE_TOKEN = "粘贴设备令牌"
.\feishu-xueqiu-clipboard.ps1
```

3. 在飞书中主动选中并复制消息，按 `Ctrl+Alt+F`，确认后等待成功提示。
4. 使用结束后，在网站撤销令牌；撤销后的请求会被服务端拒绝。令牌只允许写入，不允许读取或修改任何草稿和历史。

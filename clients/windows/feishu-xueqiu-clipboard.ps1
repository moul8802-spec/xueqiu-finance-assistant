param(
  [string]$Endpoint = $env:FEISHU_XUEQIU_ENDPOINT,
  [string]$DeviceToken = $env:FEISHU_XUEQIU_DEVICE_TOKEN
)

# This helper only reads text the user has explicitly placed on the clipboard.
# It never inspects Feishu windows, processes, caches, or hidden endpoints.
if ([string]::IsNullOrWhiteSpace($Endpoint) -or [string]::IsNullOrWhiteSpace($DeviceToken)) {
  throw '请先设置 FEISHU_XUEQIU_ENDPOINT 和 FEISHU_XUEQIU_DEVICE_TOKEN 环境变量。令牌不会写入脚本。'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class ClipboardHotkeyWindow : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  public event EventHandler HotkeyPressed;
  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }
  protected override void WndProc(ref Message m) { if (m.Msg == 0x0312) HotkeyPressed?.Invoke(this, EventArgs.Empty); base.WndProc(ref m); }
  public bool Register() { return RegisterHotKey(this.Handle, 1, 0x0002 | 0x0004, (uint)Keys.F); } // Ctrl+Alt+F
  protected override void Dispose(bool disposing) { UnregisterHotKey(this.Handle, 1); base.Dispose(disposing); }
}
'@

$window = New-Object ClipboardHotkeyWindow
if (-not $window.Register()) { throw 'Ctrl+Alt+F 注册失败，可能与其他快捷键冲突。' }
$window.Add_HotkeyPressed({
  try {
    $text = [System.Windows.Forms.Clipboard]::GetText()
    if ([string]::IsNullOrWhiteSpace($text)) { [System.Windows.Forms.MessageBox]::Show('剪贴板没有文本。请先在飞书中主动复制消息。', '雪球发布助手') | Out-Null; return }
    $preview = $text.Substring(0, [Math]::Min(280, $text.Length))
    $answer = [System.Windows.Forms.MessageBox]::Show("即将把以下剪贴板文本上传到待审核队列：`n`n$preview", '确认导入', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    $payload = @{ sourceLabel = 'Windows 主动剪贴板'; text = $text; confirmed = $true; clientMessageId = [guid]::NewGuid().ToString() } | ConvertTo-Json -Compress
    $headers = @{ Authorization = "Bearer $DeviceToken" }
    $result = Invoke-RestMethod -Uri $Endpoint -Method Post -Headers $headers -ContentType 'application/json' -Body $payload
    [System.Windows.Forms.MessageBox]::Show("已提交：$($result.result.selectedCount ?? 0) 条进入审核队列。", '雪球发布助手') | Out-Null
  } catch { [System.Windows.Forms.MessageBox]::Show("上传失败：$($_.Exception.Message)", '雪球发布助手') | Out-Null }
})
[System.Windows.Forms.Application]::Run($window)

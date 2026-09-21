<#
  PDFRev Tauri 版 —— 给界面截图（验证 UI / 留档用）

  用法：
      powershell -ExecutionPolicy Bypass -File tools\screenshot.ps1
      powershell -ExecutionPolicy Bypass -File tools\screenshot.ps1 -Delay 3 -Out test\ui.png

  截图靠 tools\WinShot.cs（PrintWindow + PW_RENDERFULLCONTENT）：
  WebView2 是 DirectComposition 渲染，普通 BitBlt 会抓到空白；
  而 WebView2 自带的截图能力要额外开 Tauri 特性，不想为测试改生产代码。
#>
[CmdletBinding()]
param(
  [string]$Exe,
  [int]$Delay = 4,
  [string]$Out,
  [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $Root 'test\tauri-ui.png' }
if (-not $Exe) {
  $cand = @(
    (Join-Path $Root 'dist\PDFRev.exe'),
    (Join-Path $Root 'src-tauri\target\release\pdfrev.exe')
  )
  $Exe = $cand | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Exe) { Write-Host '找不到 exe，请先构建' -ForegroundColor Red; exit 1 }
$Exe = (Resolve-Path $Exe).Path

Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'WinShot.cs') -ReferencedAssemblies 'System.Drawing' -ErrorAction SilentlyContinue

Get-Process -Name 'pdfrev','PDFRev' -ErrorAction SilentlyContinue |
  ForEach-Object { try { $_.Kill() } catch { } }
Start-Sleep -Milliseconds 300

# 必须在取窗口坐标之前调用：不做 DPI 感知的话，GetWindowRect 给的是被
# 虚拟化过的逻辑坐标，截出来的图会只有真实内容的一角（见 WinShot.cs 注释）。
[WinShot]::MakeDpiAware()

$proc = Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe) -PassThru
Write-Host "==> 等待窗口出现（$Delay 秒）…" -ForegroundColor Cyan
Start-Sleep -Seconds $Delay
if ($proc.HasExited) { Write-Host '进程已退出，截不到窗口' -ForegroundColor Red; exit 1 }

$h = $proc.MainWindowHandle
for ($i = 0; $i -lt 30 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 500
  $proc.Refresh()
  $h = $proc.MainWindowHandle
}
if ($h -eq [IntPtr]::Zero) { Write-Host '没拿到主窗口句柄' -ForegroundColor Red; exit 1 }

[void][WinShot]::ShowWindow($h, 5)
[void][WinShot]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1000

$bmp = [WinShot]::Capture($h)
$w = $bmp.Width; $ht = $bmp.Height

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

# 统计颜色数与深色占比，用来判断是截到了界面还是白屏/黑屏
$cols = @{}; $dark = 0; $tot = 0
for ($y = 0; $y -lt $ht; $y += 3) {
  for ($x = 0; $x -lt $w; $x += 3) {
    $c = $bmp.GetPixel($x, $y); $tot++
    $cols[$c.ToArgb()] = 1
    if (($c.R + $c.G + $c.B) / 3 -lt 110) { $dark++ }
  }
}
$bmp.Dispose()

if (-not $KeepOpen) {
  Get-Process -Name 'pdfrev','PDFRev' -ErrorAction SilentlyContinue |
    ForEach-Object { try { $_.Kill() } catch { } }
}

Write-Host ("截图已保存: {0}" -f $Out) -ForegroundColor Green
Write-Host ("    {0}x{1}，{2} 种颜色，深色占比 {3}%" -f $w, $ht, $cols.Count, [math]::Round($dark / $tot * 100))


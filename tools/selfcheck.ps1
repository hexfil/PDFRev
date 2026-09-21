<#
  PDFRev Tauri 版 —— 界面端到端自检

  用法（PowerShell）：
      cd F:\PDFRev_Tauri
      powershell -ExecutionPolicy Bypass -File tools\selfcheck.ps1

  为什么是「启动进程 + 轮询文件」而不是直接读 stdout：
  WebView2 是 GUI 子系统，从终端启动时拿不到控制台输出，所以自检结果
  由前端通过 IPC 写进 %TEMP%\pdfrev-tauri-selfcheck.txt，这里轮询该文件。
#>
[CmdletBinding()]
param(
  [string]$Exe,
  [switch]$KeepOpen,
  [int]$TimeoutSec = 420
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

<#
  以共享方式读文本文件。

  .NET 的 [System.IO.File]::ReadAllText 默认用 FileShare.Read 打开，
  相当于短暂独占；自检那个 exe 同时也在写这个报告，两边会撞上并报
  os error 32。这里显式用 FileShare.ReadWrite，允许读写同时进行。
#>
function Read-Shared([string]$Path) {
  $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
  } finally { $fs.Dispose() }
}
function Fail($m) { Write-Host "错误: $m" -ForegroundColor Red; exit 1 }

if (-not $Exe) {
  $cand = @(
    (Join-Path $Root 'dist\PDFRev.exe'),
    (Join-Path $Root 'src-tauri\target\release\pdfrev.exe'),
    (Join-Path $Root 'src-tauri\target\debug\pdfrev.exe')
  )
  $Exe = $cand | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $Exe) { Fail '找不到 pdfrev.exe，请先构建（cargo build 或 tools\build.ps1）' }
}
$Exe = (Resolve-Path $Exe).Path
Write-Host "==> 使用 $Exe" -ForegroundColor Cyan

$Report = Join-Path ([System.IO.Path]::GetTempPath()) 'pdfrev-tauri-selfcheck.txt'
if (Test-Path $Report) { [System.IO.File]::Delete($Report) }

# 上次可能有残留进程占着窗口
Get-Process -Name 'pdfrev','PDFRev' -ErrorAction SilentlyContinue |
  ForEach-Object { try { $_.Kill() } catch { } }

$proc = Start-Process -FilePath $Exe -ArgumentList '--selfcheck' -WorkingDirectory (Split-Path $Exe) -PassThru
Write-Host '==> 自检运行中（真实 WebView2 窗口）…' -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$text = ''
while ((Get-Date) -lt $deadline) {
  if (Test-Path $Report) {
    # 必须用 FileShare.ReadWrite 打开：ReadAllText 默认独占，会把正在
    # 写报告的那个 exe 挡在门外（os error 32），报告里就会多出
    # 一条「写自检报告失败」的假错误。
    try { $text = Read-Shared $Report } catch { $text = '' }
    if ($text -match '自检完成') { break }
  }
  Start-Sleep -Milliseconds 700
}
Start-Sleep -Milliseconds 500

if (-not $KeepOpen) {
  Get-Process -Name 'pdfrev','PDFRev' -ErrorAction SilentlyContinue |
    ForEach-Object { try { $_.Kill() } catch { } }
}

if (-not (Test-Path $Report)) { Fail '自检没有产出报告（程序可能启动失败）' }
if ($text -notmatch '自检完成') { Fail "自检没有跑完。报告: $Report" }

$lines = $text -split "`r?`n"
$lines | Where-Object { $_ -match '^(PASS|FAIL) ' } | ForEach-Object {
  if ($_ -like 'FAIL*') { Write-Host "  $_" -ForegroundColor Red }
  else { Write-Host "  $_" -ForegroundColor DarkGray }
}
$bad = @($lines | Where-Object { $_ -like 'FAIL*' }).Count
$total = @($lines | Where-Object { $_ -match '^(PASS|FAIL) ' }).Count

Write-Host ''
if ($bad -gt 0) {
  Write-Host "自检失败：$total 项中 $bad 项未通过。报告: $Report" -ForegroundColor Red
  exit 1
}
Write-Host "自检全部通过（$total 项）。报告: $Report" -ForegroundColor Green
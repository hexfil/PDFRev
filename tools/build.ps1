<#
  PDFRev Tauri 版 —— 构建发布版

  用法（PowerShell）：
      cd F:\PDFRev_Tauri
      powershell -ExecutionPolicy Bypass -File tools\build.ps1

  做三件事：
      1. cargo build --release（前端资源编译期嵌进 exe）
      2. 跑界面自检（40 项），有失败就中止、不产出发布物
      3. 把产物收集到 dist\ 并打印体积
#>
[CmdletBinding()]
param(
  [switch]$SkipSelfCheck,
  [switch]$NoStrip
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Tauri = Join-Path $Root 'src-tauri'
$Dist = Join-Path $Root 'dist'

function Fail($m) { Write-Host "错误: $m" -ForegroundColor Red; exit 1 }
function Mb($b) { [math]::Round($b / 1MB, 2) }

# cargo 可能不在 PATH（本机 rustup 装在用户目录，且没改 PATH）
$Cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $Cargo) {
  $Cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}
if (-not (Test-Path $Cargo)) { Fail "找不到 cargo。请先安装 Rust（https://rustup.rs）。" }
Write-Host "==> cargo: $Cargo" -ForegroundColor Cyan

Write-Host '==> Rust 单元测试' -ForegroundColor Cyan
& $Cargo test --manifest-path (Join-Path $Tauri 'Cargo.toml') --quiet
if ($LASTEXITCODE -ne 0) { Fail 'Rust 单元测试未通过' }

Write-Host '==> 构建 release' -ForegroundColor Cyan
& $Cargo build --release --manifest-path (Join-Path $Tauri 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { Fail '构建失败' }

$exe = Join-Path $Tauri 'target\release\pdfrev.exe'
if (-not (Test-Path $exe)) { Fail "没有产出 $exe" }

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$out = Join-Path $Dist 'PDFRev.exe'
Copy-Item $exe $out -Force

if (-not $SkipSelfCheck) {
  Write-Host '==> 界面自检（对着发布目录里的 exe 跑）' -ForegroundColor Cyan
  & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'selfcheck.ps1') -Exe $out
  if ($LASTEXITCODE -ne 0) { Fail '界面自检未通过，不发布' }
}

# 版权声明随包放一份（界面上也能看，但文件形式更正式）
Copy-Item (Join-Path $Root 'LICENSE-PDFRev.txt') $Dist -Force

$size = (Get-Item $out).Length
Write-Host ''
Write-Host ("打包完成: {0}" -f $out) -ForegroundColor Green
Write-Host ("    单文件 {0} MB（免安装，直接双击运行）" -f (Mb $size))
Write-Host ("    对比：Electron 便携版 7z 61.44 MB / 解压 233 MB —— 约为其 {0}%" -f
  [math]::Round($size / (233MB) * 100, 2))
Write-Host '    dist\PDFRev.exe 拷到任意目录（U 盘也行）即可独立运行。'
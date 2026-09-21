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

Write-Host '==> 生成物一致性（界面许可全文 / 命令行帮助是否与工具同源）' -ForegroundColor Cyan
# 这两份文本都是「工具生成进 app.js」的，漂移了界面上显示的就不是真的 MIT 条款 /
# 不是真的 CLI 参数，所以构建前先校验。
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($py) {
  & $py (Join-Path $PSScriptRoot 'check-license.py')
  if ($LASTEXITCODE -ne 0) { Fail '界面 MIT 全文与 LICENSE 不一致' }
} else {
  Write-Host '    跳过 check-license.py（找不到 python）' -ForegroundColor DarkYellow
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
  & $node (Join-Path $PSScriptRoot 'cli-help.js') --check
  if ($LASTEXITCODE -ne 0) { Fail '命令行帮助与 tools\cli-help.js 不同步' }
} else {
  Write-Host '    跳过 cli-help.js --check（找不到 node）' -ForegroundColor DarkYellow
}

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

# MIT 许可随包放一份（界面上也能看，但文件形式更正式）
Copy-Item (Join-Path $Root 'LICENSE') $Dist -Force

$size = (Get-Item $out).Length
Write-Host ''
Write-Host ("打包完成: {0}" -f $out) -ForegroundColor Green
Write-Host ("    单文件 {0} MB（免安装，直接双击运行）" -f (Mb $size))
Write-Host ("    对比：Electron 便携版 7z 61.44 MB / 解压 233 MB —— 约为其 {0}%" -f
  [math]::Round($size / (233MB) * 100, 2))
Write-Host '    dist\PDFRev.exe 拷到任意目录（U 盘也行）即可独立运行。'
# PDFRev_Tauri — PDFRev 的 Tauri 2 重写版

用 **Tauri 2（Rust + WebView2）** 重写已完成的 PDFRev 桌面版，功能一一对应。
前端界面逻辑直接复用原版（`src/app.js` 一行未改），后端换成 Rust。

## 为什么/和原版的关系

| 项 | 原版（Electron） | 本版（Tauri 2） |
|---|---|---|
| 运行时 | 自带 Chromium + Node | 用系统 WebView2（Win10+ 自带） |
| PDF 处理 | `pdf-lib`（JS） | `lopdf`（Rust） |
| 产物 | 便携版 7z 61.44 MB / 解压 233 MB | **单个 exe 4.48 MB** |
| 界面代码 | `src/renderer/app.js` | 同一个文件，复制过来未改 |

体积差 50 倍，是因为 Tauri 不打包浏览器引擎。
代价：依赖系统 WebView2（Win10 1803+ 通常已预装；本机版本 153.0.4234.48）。

## 功能对照（与原版完全一致）

| 功能 | 实现位置 |
|---|---|
| 打开 PDF（按钮 / 拖入窗口） | `open_pdf` / 拖入走内存打开 |
| 缩略图渲染、勾选 | 前端（PDF.js），与原版相同 |
| 删除单页 / 多页 / 范围表达式 | `pdf_op { op: "delete" }` |
| 拖动缩略图排序 / 输入顺序 | `pdf_op { op: "reorder" }` |
| 提取为新 PDF | `pdf_op { op: "extract" }` |
| 旋转 90 / 180 / 270 | `pdf_op { op: "rotate" }` |
| 插入另一个 PDF（首页/尾页/第 N 页前后） | `pdf_op { op: "insert" }` |
| 反转全部页序、撤销 | 前端 + `pdf_op` |
| 双击预览、预览内 Delete 删页 | 前端（与原版相同） |
| 预览滚轮缩放（以光标为中心） | 前端 |
| 顶栏完整路径 + 创建/修改时间 | `file:stat` → `stat` |
| 只读文件保存前询问 | `save` 返回 `READONLY`，确认后 `unlock` |
| 原子保存（临时文件 + 改名） | `write_file_safe` |
| 另存为 / 选择保存位置 | `save_as` / `pick_save_path` |
| 等价命令行 / JSON 展示与复制 | 前端 + `copy_text` |
| 版权与许可页（首次自动弹） | 前端，与原版同源 |
| 多语言界面（简中 / 英文）+ 顶栏语言选择框 | src/i18n.js，界面全部菜单/按钮/提示随语言切换 |
| 英文标题 | PDF Revisor（窗口标题随语言切换） |

## 启动

```powershell
cd F:\PDFRev_Tauri\src-tauri
cargo run              # 开发运行
cargo run --release    # 优化运行
```

首次运行会自动下载并编译依赖（本机实测约 3 分钟；之后增量约 20 秒）。

## 构建发布版

```powershell
cd F:\PDFRev_Tauri
powershell -ExecutionPolicy Bypass -File tools\build.ps1
```

产物：

```
dist\PDFRev.exe                     4.48 MB（单文件，直接双击运行）
dist\LICENSE                        MIT 许可原文，随包分发
```

**单文件即可独立运行**：拷到任意目录（U 盘也行）双击即可，不需要额外的 dll。
（已实测：把 exe 单独放进空目录，85 项自检全部通过。）

## 测试

### 1. Rust 单元测试（14 项，不需要 GUI）

```powershell
cd F:\PDFRev_Tauri\src-tauri
cargo test
```

覆盖页码表达式解析（含中文 `至`/`，`）、插入位置解析、删除/排序/提取/旋转/插入、
元数据保留（含 UTF-16 中文标题）、多次重建的稳定性。

### 2. 真实文档端到端（`test/VPEg.pdf`，62 页 / 10.3 MB）

```powershell
cd F:\PDFRev_Tauri\src-tauri
cargo run --example vpeg_check
```

会校验页数、删/抽/转/插/排序的结果，最后比对源文件 sha256 **未被改写**，
并把产物写到 `test/VPEg-tauri-out.pdf` 供人工用阅读器确认。

### 3. 界面端到端自检（85 项，真实 WebView2）

```powershell
cd F:\PDFRev_Tauri
powershell -ExecutionPolicy Bypass -File tools\selfcheck.ps1
```

在真实窗口里跑完整链路：版权页 → 打开 PDF → 缩略图 → 顶栏信息 → 双击预览
→ 滚轮缩放 → 预览内 Delete 删页 → 排序 → 撤销 → 旋转 → 保存落盘 → stat
→ 剪贴板 → 真实文档 62 页渲染 → 国际化（切语言 / 文案 / 后端错误本地化）→ 无未捕获错误。

报告写到 `%TEMP%\pdfrev-tauri-selfcheck.txt`（WebView2 是 GUI 进程，
从终端拿不到 stdout，所以只能落盘）。

## 目录结构

```
src/                        前端（与原版共享界面逻辑）
  index.html                界面骨架（含版权页块）
  app.js                    业务逻辑 —— 复用原版，另含版权页与命令行帮助生成块
  i18n.js                   ★ 多语言词典与切换逻辑（界面文案唯一来源）
  style.css                 样式
  bridge-tauri.js           ★ 把 Rust 命令包成和 Electron 版一致的 window.api
  selfcheck.js              界面端到端自检（--selfcheck 时跑，85 项）
  vendor/pdf.js             PDF.js（渲染缩略图/预览）
  vendor/pdf.worker.js
  fixtures/p5.pdf, p2.pdf   自检用的合成 PDF（pdf-lib 生成的真 PDF）
  assets/pdfrev_logo.png    版权页 logo（由 tools/make-assets.py 生成）
  assets/pdfrev_icon.png    界面用图标（同上）
src-tauri/
  src/lib.rs                全部 IPC 命令（对应原版 main.js + preload.js）
  src/pdfops.rs             PDF 页面操作核心（对应原版 pdfops.js）+ 14 项单元测试
  examples/vpeg_check.rs    真实文档端到端验收
  tauri.conf.json           窗口、CSP、打包配置
  icons/icon.ico            应用图标（多尺寸，由 tools/make-assets.py 生成）
  icons/icon.png            512x512 图标
tools/
  build.ps1                 构建 + 自检 + 组装 dist\
  selfcheck.ps1             跑界面自检并把报告打印出来
  screenshot.ps1            给界面截图（配合 WinShot.cs）
  WinShot.cs                PrintWindow + PW_RENDERFULLCONTENT + DPI 感知
  make-assets.py            从设计原图生成图标与版权页 logo
  cli-help.js               生成「命令行帮助」内容（与 CLI 参数同源）
  check-license.py          校验界面 MIT 全文与 LICENSE 逐字一致
test/
  tauri-ui.png              界面截图
  copyright.png             版权页截图
  cli-help.png              命令行帮助面板截图
LICENSE                     MIT 许可（界面版权页的全文来源）
pdfrev_icon.png             设计原图（应用图标，1024x1024）
pdfrev_logo.png             设计原图（logo，1536x1024）
```

## 实现要点

### 1. 前端零改动复用

原版 `src/renderer/app.js` 的全部业务逻辑只依赖 `window.api` 这一个接口。
`src/bridge-tauri.js` 把 Rust 命令包装成同样的 11 个方法，形状完全一致，
所以界面代码复制过来就能跑。

两处必然差异在这一层吸收掉：

- **二进制过 IPC**：Tauri 传 base64 最稳，桥接层在两端做 base64 ↔ Uint8Array 转换；
- **拖入文件的磁盘路径**：Tauri 的 webview 拿不到（Electron 靠 `webUtils`），
  返回空串，于是走 `app.js` 里已有的「内存打开、保存时再选位置」分支 ——
  这正好就是需求要的「拖入不另存，直接打开」。

### 2. 错误必须归一化成 `{ok:false}`

Rust 侧用 `Err(ErrPayload)` 表达失败，Tauri 会把它变成 **Promise reject**；
而 Electron 版一律 resolve 成 `{ok:false, code, error}`，界面里的 `fail(res)`
只认后者。不包一层的话：「页码超范围」这类错误既不会有 toast、
还会变成未捕获异常。

桥接层的 `call()` 就是干这个的 —— 所有 `invoke` 都走它。

### 3. Tauri 命令参数名要和 Rust 形参名一致

`fn pdf_op(args: OpArgs)` 的调用方必须写 `invoke('pdf_op', { args: {...} })`。
一开始写成 `{ op, data, args }` 三个平铺字段，报
`invalid args 'args' for command 'pdf_op': missing field 'op'`，
表现为所有页面操作静默失败。

### 4. lopdf 的页面树必须自己重建

`rebuild()` 的关键两点：

1. **`Root` 必须是「引用」**：`dictionary!{...}` 内联进去的话，
   lopdf 的 `catalog()` 沿 `Reference` 找不到，`get_pages()` 返回空，
   表现成「所有操作后页数都是 0」；
2. 页面对象要**重新编号并统一挂到新 Pages 节点**，
   否则和旧文档的对象编号体系冲突。

### 5. PDF 字符串要认 UTF-16

`VPEg.pdf` 的中文标题是 UTF-16BE 无 BOM 写的。只按 UTF-8 解会得到
`EMMS~…` 这样的乱码。`decode_pdf_string()` 三种形态都处理：
BOM 标记的 UTF-16、无 BOM 但「偶数长度 + 奇数位大量 0」的 UTF-16BE、
以及单字节 PDFDocEncoding。写回时统一用 UTF-16BE + BOM。

## 踩过的坑（改代码前看）

1. **自检开关不能用 `window.eval` 注入**：前端为了还原「首次启动」状态会
   `location.reload()`，reload 后新 document 里注入的全局变量就没了，
   自检静默不跑（第一次现象是「没有产出报告」）。
   改成前端每次加载都 `invoke('selfcheck_enabled')` 问一次。
2. **`localStorage` 会跨运行残留**：版权页「已看过」标记留着的话，
   第二次跑自检就变成 FAIL。自检要先清标记再 reload（用 sessionStorage
   打标记避免无限重载）。
3. **不要手写极简 PDF 当测试固件**：xref 偏移和 `/Length` 稍不对，
   PDF.js 就读成 0 页，表现成「缩略图一个都没有」，很容易误判成前端 bug。
   改用 pdf-lib 预生成真 PDF 放 `src/fixtures/`。
4. **CSP 不含 `unsafe-eval`**：自检里用 `new Function` 拼脚本会被拦
   （`Evaluating a string as JavaScript violates CSP`）。改成直接
   `dispatchEvent(new WheelEvent(...))`。
5. **异步操作途中 `state.bytes` 会短暂是 undefined**：轮询断言里直接解析
   会炸成 `bytes.slice is not a function`。统一用 `curBytes()` 判空。
6. **改前端后必须重新 `cargo build`**：前端资源是编译期嵌入 exe 的，
   只改 `src/*.js` 不重编译的话跑的还是旧代码（踩过一次，白排查半天）。
7. **`tauri` 的 feature 要和 `tauri.conf.json` 的 allowlist 对齐**：
   `Cargo.toml` 写了 `features = ["protocol-asset"]` 而配置里没声明，
   构建直接报「does not match the allowlist」。
8. **`cargo run --example` 要求文件在 `src-tauri/examples/`**，
   不是项目根的 `examples/`；里面的 `#[path]` 也要按那个位置算相对路径。

## 命令行帮助

右侧「命令行等价」卡片是根据界面上做的操作，实时拼出等价的 `pdfrev` 命令行，
方便把同样的处理写成脚本或交给别的程序调用（这就是原版 `src/cli.js` 的用途）。

卡片上的「**帮助**」按钮会打开一个面板，把命令行讲清楚：

- **命令**：`info` / `reorder` / `delete` / `extract` / `rotate` / `insert` / `run` 的完整用法与说明
- **通用参数**：`-o, --output`、`--json`、`--dry-run`、`-h, --help`
- **写法速查**：页码（`2` / `3,5,8` / `3-5` / `5-end` / `all`）与插入位置（`head` / `tail` / `before:3` / `after:4`）
- **示例**：9 条从简到繁的可复制命令
- **批量执行**：`spec.json` 的完整样例

面板里所有命令与示例**点一下就复制到剪贴板**，Esc 或点空白处关闭。

帮助内容由 `tools/cli-help.js` 生成进 `src/app.js`，与原版 CLI 的参数保持同源：

```powershell
node tools\cli-help.js           # 写入（幂等）
node tools\cli-help.js --check   # 只校验是否与工具同步
```

## 版权与许可

本软件以 **MIT License** 发布，条款只在根目录的 `LICENSE` 文件维护：

```
MIT License

Copyright (c) 2026 He Xianfeng (何险峰) <xfhe@ipe.ac.cn>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`src-tauri/Cargo.toml` 的 `license` 字段也相应声明为 `MIT`。

界面上版权页展示的就是这份许可（标题「MIT 开源许可」，四条要点 + 可展开全文），
方便不查文件的用户直接看到条款。

界面里的版权页沿用原版（`src/index.html` + `app.js` 里的生成块），
并在顶部放了 `pdfrev_logo.png`。

### 版权页的编号怎么来的

条款用 `<ol>` 渲染，**序号由 `<ol>` 自己生成**，代码里只写小标题：

```js
b.textContent = c.k + '：';   // 正确：渲染成 "1. 授予的权利：..."
// b.textContent = c.n + '. ' + c.k + '：';   // 错：会变成 "1. 1. 个人非商业使用：..."
```

之前文案里手写了「1.」，`<ol>` 又加一遍，界面上就是「1. 1. 2. 2. …」。
现在文本里不再带序号，序号统一交给 `<ol>`。

## 图标与素材

设计原图放在项目根目录（`pdfrev_icon.png`、`pdfrev_logo.png`），
用脚本生成实际使用的素材：

```powershell
python tools\make-assets.py
```

生成 `src-tauri/icons/icon.ico`（16/24/32/48/64/128/256 七个尺寸）、
`src-tauri/icons/icon.png`（512）、`src/assets/pdfrev_logo.png`（版权页用，720px 宽）。

脚本做了一件必要的事：`pdfrev_icon.png` 是 AI 出图，**把「透明」画成了灰白
棋盘格**（40.96px 一格的烘焙像素，不是真透明）。直接用会在任务栏里显示格子。
脚本按「与边界连通的浅色低饱和区域」找出棋盘格底并置为真透明，
再对边缘做 anti-alias 的 alpha 估算，所以小尺寸图标也不会留白边。
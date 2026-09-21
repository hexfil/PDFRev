# PDFRev_Tauri 项目 Handoff

> 给下一次继续写代码的会话看。读完这份就能直接上手，不需要重新摸索。
> 最后更新：2026-09-21（v0.12.0 已发布：国际化 + 英文标题 PDF Revisor）
>
> 测试基线：Rust 单元 14 项 + 真实文档端到端 1 套 + 界面自检 89 项，全部通过。

---

## 1. 这是什么

`F:\PDFRev_Tauri` —— 用 Tauri 2（Rust + 系统 WebView2）重写的 PDFRev。
功能与 `F:\PDFRev`（Electron 版）一一对应，前端界面逻辑直接复用。

存在的意义：体积。

| | Electron 版 | Tauri 版 |
|---|---|---|
| 发布物 | 7z 61.44 MB / 解压 233 MB | 单个 exe 4.49 MB |
| 运行时 | 自带 Chromium + Node | 系统 WebView2 |
| 相对体积 | 100% | 1.93% |

代价是依赖系统 WebView2（Win10 1803+ 通常预装，本机 153.0.4234.48）。

---

## 2. 环境与运行

| 项 | 值 |
|---|---|
| 工作目录 | `F:\PDFRev_Tauri` |
| Rust | 1.98.1（rustup 装的，在 %USERPROFILE%\.cargo\bin，未改 PATH） |
| 构建器 | MSVC（VS 2026 Community 18.6.2，自带 Win SDK 10.0.26100） |
| Tauri | 2.11.6 |
| lopdf | 0.45.0（PDF 页面操作核心） |
| Shell | Windows PowerShell 7（不是 bash） |

### 环境是这次新装的

本机原本没有 Rust，用 rustup 的用户级静默安装（不需要管理员）：
下载 rustup-init.exe 后跑 `-y --default-toolchain stable --profile minimal --no-modify-path`。

`--no-modify-path` 是因为 Codex 会话是非管理员，改 PATH 容易出岔子；
代价是每次都要写全路径 `& "$env:USERPROFILE\.cargo\bin\cargo.exe"`。
`tools\build.ps1` 已经自己找 cargo，不用管。

MSVC 与 WebView2 本机已有，没重装。Rustup 下载约 300 MB。

### 启动

```powershell
cd F:\PDFRev_Tauri\src-tauri
& "$env:USERPROFILE\.cargo\bin\cargo.exe" run            # 开发
& "$env:USERPROFILE\.cargo\bin\cargo.exe" run --release   # 优化
```

首次构建约 3 分钟，之后增量约 20 秒。

---

## 3. 目录结构

```
src/                        前端（与原版共享界面逻辑）
  index.html                界面骨架（含版权页块）
  app.js                    业务逻辑 —— 直接复用原版，一行未改
  style.css                 样式
  bridge-tauri.js           把 Rust 命令包成和 Electron 版一致的 window.api
  selfcheck.js              界面端到端自检（--selfcheck 时才跑）
  vendor/pdf.js             PDF.js 3.11.174
  vendor/pdf.worker.js
  fixtures/p5.pdf, p2.pdf   自检固件（pdf-lib 生成的真 PDF）
src-tauri/
  src/lib.rs                全部 IPC 命令（对应原版 main.js + preload.js）
  src/pdfops.rs             PDF 操作核心（对应原版 pdfops.js）+ 14 项单元测试
  src/main.rs               仅 fn main() 里调 pdfrev_lib::run()
  examples/vpeg_check.rs    真实文档端到端验收
  tauri.conf.json           窗口 / CSP / 打包配置
  icons/icon.ico            图标（脚本生成的几何图形）
tools/
  build.ps1                 构建 + 单测 + 自检 + 组装 dist
  selfcheck.ps1             跑界面自检并把报告打印出来
test/
  tauri-ui.png              界面截图
```

---

## 4. 架构：为什么前端能一行不改

原版 src/renderer/app.js 的全部业务逻辑（状态机、缩略图、拖拽排序、
预览缩放、快捷键、顶栏信息）只依赖 window.api 这一个接口。

src/bridge-tauri.js 把 Rust 命令包装成同样的 11 个方法，形状完全一致：

```js
window.api = {
  openPdf, readFile, save, saveAs, stat, info, op,
  showItem, copyText, getFilePath, promptSavePath,
};
```

于是 app.js 复制过来就能跑。两处必然差异全部在这一层吸收：

1. 二进制过 IPC：Tauri 传 base64 最稳，桥接层两端做 base64 与 Uint8Array 互转；
2. 拖入文件的磁盘路径：Tauri 的 webview 拿不到（Electron 靠 webUtils），
   返回空串，于是走 app.js 里已有的「内存打开、保存时再选位置」分支 ——
   这正好就是需求要的「拖入不另存，直接打开」。

### IPC 命令清单

| 前端调用 | Rust 命令 | 说明 |
|---|---|---|
| window.api.openPdf() | open_pdf | 系统文件对话框（多选） |
| readFile(p) | read_file | 读磁盘文件（返回 base64） |
| save(p, u8, unlock) | save | 原子写 + 只读属性处理 |
| saveAs(u8, name) | save_as | 另存为对话框 |
| promptSavePath(name) | pick_save_path | 只选路径不写 |
| stat(p) | stat | 创建 / 修改时间 |
| info(u8) | pdf_info | 页数 / 标题 / 作者 |
| op(op, u8, args) | pdf_op | delete / reorder / extract / rotate / insert |
| showItem(p) | show_item | 资源管理器定位 |
| copyText(t) | copy_text | 写剪贴板 |
| — | selfcheck_enabled | 前端问「是不是自检模式」 |
| — | selfcheck_dir / selfcheck_report / selfcheck_front | 自检支持 |

---

## 5. 重点实现细节（踩过的坑，都别再踩）

### 5.1 lopdf：trailer 的 Root 必须是引用，不能内联

    // 错：Root 内联进 trailer，catalog() 找不到 -> 任何操作后页数变 0
    doc.trailer.set("Root", dictionary!{ "Type" => "Catalog", "Pages" => ... });

    // 对：先落成一个对象，再引用它
    let root_id = out.add_object(dictionary!{ "Type" => "Catalog", "Pages" => pages_id });
    out.trailer.set("Root", Object::Reference(root_id));

这一条错了会导致 **14 项单测挂 7 项**，而且现象是「页数 = 0」，很容易误判到前端。

### 5.2 Tauri 命令参数名必须和 Rust 形参名一致

Rust 侧签名是 `fn pdf_op(args: OpArgs)`，前端就必须用 `invoke('pdf_op', { args: { op, data, args } })`。
写成平铺 `{ op, data, args }` 会报 `invalid args 'args' ... missing field 'op'`，
**界面上表现为所有页面操作静默失败**（没 toast、没报错）。

### 5.3 Rust 的 Err() 到 JS 是 Promise reject，不是返回值

原版 `app.js` 的 `fail(res)` 只认 `{ok:false, code, error}`。
所以 `bridge-tauri.js` 里每个调用都过一层 `call()`，把 reject 归一化成 `{ok:false, code:'E_IPC', error: message}`。
不包这层就会：无 toast + 控制台未捕获异常。

### 5.4 UTF-16 中文标题

`VPEg.pdf` 的标题是 **UTF-16BE 无 BOM** 的 `EMMS组月度总结（2026-09）`。
只按 UTF-8 解会得到 `EMMS~...` 乱码。`decode_pdf_string()` 必须：
先看 BOM（FE FF / FF FE），再看前两字节是否可解释为 UTF-16，最后回退到 PDFDocEncoding / latin1。

### 5.5 前端资源是编译期嵌入的

改 `src/*.js` / `*.html` / `*.css` 之后**必须重新 cargo build**，否则 exe 里还是旧资源。这条坑踩过，白排查半天。
### 5.6 自检开关不能用 window.eval 注入

前端有 `location.reload()`，注入的全局变量会丢，自检静默不跑。改成前端每次加载都 `invoke('selfcheck_enabled')` 问一次。

### 5.7 localStorage 跨运行残留

版权页的「已看过」标记会留在 localStorage，导致第二次自检不走版权页分支而 FAIL。
自检开始前先清标记再 reload，并用 sessionStorage 防无限重载。

### 5.8 不要手写极简 PDF 当固件

xref / `/Length` 稍不对，PDF.js 就读成 0 页，会误判成前端 bug。`src/fixtures/*.pdf` 全部用 pdf-lib 生成。

### 5.9 CSP

- 不能有 `unsafe-eval`。所以自检里不能用 `new Function` 造滚轮事件，改 `dispatchEvent(new WheelEvent(...))`。
- `connect-src` 必须放行 `ipc:` 和 `http://ipc.localhost`，否则 IPC 全断。
- CSP 写在 `tauri.conf.json`，HTML 里的 `<meta CSP>` 已删。

### 5.10 异步途中 state.bytes 会短暂 undefined

缩略图 / 预览还在异步渲染时读 `state.bytes` 会拿到 undefined。`curBytes()` 必须判空，否则报 `bytes.slice is not a function`。

### 5.11 tauri feature 要和 tauri.conf.json 对齐

`protocol-asset` 与当前 conf 冲突，报错；已从 Cargo.toml 的 `tauri = { features = [] }` 里去掉。

### 5.12 cargo run --example

example 必须放在 `src-tauri/examples/`，`#[path]` 按该位置解析。

### 5.13 路径

`[System.IO.File]::ReadAllText("相对路径")` 用的是**进程 CWD**，脚本里写文件一律用绝对路径。

### 5.14 写入策略

超大 payload、含 shell 行继续符（反引号）的 here-string、含下载 URL 的 here-string 都会被策略拒。改用**分块 AppendAllText** 或字符串数组 join 写入。

### 5.15 拖入文件的磁盘路径拿不到（这是特性，不是 bug）

Tauri 的 webview 拿不到拖入文件的真实路径（Electron 靠 webUtils）。
桥接层 `getFilePath()` 返回空串，于是走 app.js 里已有的「内存打开、保存时再选位置」分支 —— 正好就是需求要的「拖入不另存，直接打开」。
因此 `tauri.conf.json` 里 `dragDropEnabled: false`，让 HTML5 拖放生效。
### 5.17 版权页的序号是 <ol> 给的，文本里不能再写「1.」

条款用 `<ol>` 渲染，序号由 `<ol>` 自己生成。代码里只写小标题：

```js
b.textContent = c.k + '：';   // 对：渲染成 "1. 个人非商业使用：..."
// b.textContent = c.n + '. ' + c.k + '：';   // 错：变成 "1. 1. 个人非商业使用：..."
```

原实现两边都写，界面上就是「1. 1. 2. 2. …」。
`src/index.html` 里的占位 `<li>` 也一并去掉手写序号（JS 会重填，但静态标记要保持一致）。

### 5.18 AI 出图的「透明」是烘焙的棋盘格

`pdfrev_icon.png` 是 AI 生成的，**把「透明」直接画成了灰白棋盘格**
（1024 边长上 25 格，40.96px 一格，左上角第一格是 235 灰）。
直接当图标用，任务栏里会显示一整片格子。

`tools/make-assets.py` 的处理办法：
1. 按「亮度 > 205 且饱和度 < 28」找浅色区，**只取与边界 4 连通的那一块**
   当背景（图形内部的纯白 255 是设计的一部分，不能一起抠掉）；
2. 置为真透明，再对紧贴背景的一圈做 anti-alias：用「像素与重建出的棋盘格
   底色的距离 / 48」估算 alpha，避免边缘留一圈白毛；
3. 裁到内容 bbox 再补成正方形（原图四周有大片空白，直接缩放会偏小且不居中）。

### 5.19 截图脚本必须先做 DPI 感知

PowerShell 是 DPI-unaware 的：Windows 会把窗口坐标虚拟化成逻辑像素，
`GetWindowRect` 返回的是缩小过的一整套整数（本机 2404x1639 -> 1374x937）。
`PrintWindow` 再往这个缩小的位图上贴真实像素，结果只贴进窗口内容的一角 ——
截出来的图看起来「版权页卡片跑到右半边」，全是伪影，不是界面真的错位。
所以 `tools/screenshot.ps1` 在取坐标前先调 `WinShot.MakeDpiAware()`。

另外 WebView2 是 DirectComposition 渲染，普通 BitBlt 抓到的是空白，
必须 `PrintWindow(hwnd, hdc, 2)`（`PW_RENDERFULLCONTENT`）。

### 5.21 「生成块」的工具必须幂等

`tools/cli-help.js` 第一次生成时在标记前留了两个换行，第二次只留一个 ——
于是 `--check` 永远报「不同步」，而且每跑一次文件都在变。修法是把两条分支
统一成同一个形状：

```js
const b = block();                       // 生成块本身不以空行开头
const i = src.indexOf(MARK);
const head = (i < 0 ? src : src.slice(0, i)).replace(/\s+$/, '');
return head + '\n\n' + b + '\n';         // 正文 + 恰好一个空行 + 块
```

### 5.22 手写段和生成段的注释头不能重名

`tools/cli-help.js` 用 `/* ---------------- 命令行帮助` 当查找标记，
而我手写的渲染函数那一段注释头**正好也是这行** —— 工具会把渲染函数
当成自己的旧块，整段覆盖掉。

修法：生成标记改成独一无二的 `/* ==== CLI-HELP-BLOCK:`，
手写段另起一个不同措辞的注释头，并在注释里写明「别改成和生成标记一样」。

### 5.25 多语言（i18n）：文案只有一处，Rust 不返回中文

**需求**：各类菜单都支持国际化，顶栏加语言选择框。

架构（三个决定，都很重要）：

1. **词典单一来源**：`src/i18n.js` 里 `I18N_ZH` / `I18N_EN` 两张平铺表
   （153 个键），加上 `I18N_ERR`（36 个后端错误键）。缺键回落 zh，再回落键名本身，
   所以漏翻时界面上会直接看见 `pdf.pagerange` 这种键名，不会静默显示空白。
2. **静态标记**：`index.html` 上写 `data-i18n`（textContent）、`data-i18n-html`
   （innerHTML，只有带 `<b>`/`<code>` 的许可声明用）、`data-i18n-title`、
   `data-i18n-ph`（placeholder）、`data-i18n-aria`。`applyI18n()` 在启动和
   每次 `setLang()` 时整表灌一遍 —— 静态文案不需要 app.js 参与。
3. **Rust 不返回中文**：所有错误改成返回语言无关的
   `{ code, ekey, eargs, error }`：
   - `ekey` —— 稳定键，如 `pdf.pagerange` / `io.eacces`
   - `eargs` —— 占位符实参，如 `{ n: 9, total: 3 }`
   - `error` —— 英文兜底（没有 ekey 时才用）

   翻译只在 `src/i18n.js` 的 `I18N_ERR` 一处，前端用 `tErr(res)` 渲染。
   **加语言不用动 Rust、不用重编译**。`pdfops.rs` 新增 `PdfErr { key, args, en }`
   与 `pub type Res<T> = Result<T, PdfErr>`，`lib.rs` 里实现
   `impl From<pdfops::PdfErr> for ErrPayload` 做转换。

踩过的坑：

- **`bridge-tauri.js` 必须原样转发 `ekey`/`eargs`**。Tauri 的 `Err(ErrPayload)`
  在 JS 侧是 Promise reject，桥接层把它归一化成 `{ ok:false, code, error }` ——
  早先只搬了 `code`/`error`，`ekey` 丢了，于是切到英文时后端错误仍显示英文兜底
  （看起来「像是翻了」，其实只是没走翻译表）。
- **不懂 `-replace` 就别用它做整段改写**。上一轮用 PowerShell 的
  here-string + `-replace` 往 `pdfops.rs` 里塞代码，结果把 `\n` 当成了
  **字面两字符**写进文件（`PdfErr::with(\n            "pdf.pagerange",\n ...)`），
  cargo 报了一堆语法错。要么用 `'...'` 单引号 here-string（`\n` 不会转义）
  并显式写真实的换行，要么用 `[System.IO.File]::WriteAllText` 拼数组。修法：
  `$t.Replace('\n', "`r`n")` 或改回真换行。
- **PowerShell 写盘会把 LF 变 CRLF**，而 `.gitattributes` 规定 `*.js`/`*.css`/
  `*.html`/`*.rs` 是 `eol=lf`。用 `Get-Content` + `Set-Content` 改一次文件，
  整文件就「全变了」，而且 `tools/cli-help.js --check` 会报「与工具不同步」
  （它比对的是完整字节）。改完统一 `Replace("`r`n","`n")` 再写回。
- **改 `renderFileInfo()` 这种多行块时，`Get-Content` 切片会漏行**。
  这次漏掉了 `line2.appendChild(meta)`，自检报「顶栏显示创建与修改时间 -> (无)」。
  切行之后一定回头读一遍函数全文，或直接用精确字符串 `Replace`。
- **切语言要重画的只有 JS 拼出来的东西**：顶栏文件信息、缩略图角标
  （`.chk` title / `.ph` / `.idx`）、插入位置下拉、命令行帮助面板、版权页条款、
  已打开的预览标题。这些集中在 `window.addEventListener('pdfrev:langchange', ...)`
  里，由 `setLang()` 派发自定义事件触发 —— i18n.js 不反向依赖 app.js。
- **CLI 帮助内容也分语言**：`tools/cli-help.js` 现在生成
  `CLI_HELP_BY_LANG = { zh: {...}, en: {...} }`，渲染时用 `CLI_HELP_OF()` 取当前语言。
  注意用 `cliHelpLang`（语言 id）当「已渲染」标记，不能用布尔 ——
  否则切语言后面板不会重画。
- **窗口标题要单独同步**：`<title>` 只管网页自己，任务栏 / 标题栏是操作系统
  的窗口属性，得调 Rust 的 `set_window_title`（`tauri.conf.json` 的 `title`
  只在启动那一刻生效）。现在 `i18n.js` 的 `applyNativeTitle()` 在两种时机调：
  `applyI18n()` 里（切语言）和 `DOMContentLoaded`（启动时 —— 脚本顺序是
  i18n.js 在 bridge-tauri.js **之前**，那一刻还没有 `window.api`）。
  只做前一半的话，英文界面下任务栏会挂着中文标题。英文标题按用户要求定为
  **PDF Revisor**（`I18N_EN['app.title']`）。
### 5.24 顶栏品牌的位置与字号（用户指定）
用户要求两件事，都只改顶栏，不碰其它视图：

1. **「logo + PDFRev」放到「版权」前面**：`index.html` 里把那一行从
   `<header>` 第一个子元素移到 `#btnUndo` 与 `#btnCopyright` 中间。
   注意 `.brand-icon` 是 `display:block` 的 `<img>`，紧跟的空格不会渲染出间隙，
   实际间距由 `.toolbar` 的 `gap: 8px` 提供，所以不用额外加 margin。
2. **标题加黑加粗、增大一号**：界面基准字号是 `body` 的 13px，
   所以「大一号」取 **15px**（不是 16px，那会跳到二级标题的尺度）；
   字重写 `900`。
   坑：微软雅黑没有 900 字重，浏览器会把 900 回落到加粗的 700，
   肉眼看不出「更黑」。所以额外加 `-webkit-text-stroke: .35px var(--accent)`
   做极细描边压黑——比 `text-shadow` 干净，也不会在小字号下糊成一团。

配套加了 3 项自检（当时的基线是 69 项）：
- 用 `compareDocumentPosition` 断言 `.brand` 与 `.brand-icon` 都排在
  `#btnCopyright` 之前（只断言 `.brand` 不够，图标也得在按钮左边）。
- `getComputedStyle(.brand).fontSize === '15px'`。
- `parseInt(fontWeight) >= 800`。

另外顶栏品牌图标从 20px 调到 24px，跟 15px 文字视觉重量配平。

### 5.23 PowerShell 的 $Args 是自动变量

`screenshot.ps1` 里加了 `[string[]]$Args` 参数后报
`ParameterBindingValidationException` —— `$Args` 是 PowerShell 的自动变量，
不能当自己的参数名。改成 `$AppArgs`。

另外 `Start-Process -ArgumentList @()` 传空数组会报
「The argument is null, empty, ...」，所以改成按有没有参数分两支调用。
### 5.20 自检报告文件的两侧竞争

前端每出一条结论就落一次盘，而外部 `selfcheck.ps1` 同时在轮询读它：

- 读方：`[System.IO.File]::ReadAllText` 默认独占打开，会把写方挡在门外
  （os error 32）。改用 `FileShare.ReadWrite` 打开（`Read-Shared` 函数）。
- 写方：改成「写临时文件 + 改名覆盖」的原子替换，并对改名失败重试；
  再加一把 `static Mutex` 串行化，因为前端那些落盘调用本身是并发的。
- 前端：`report()` 里 `invoke` 返回的 Promise 必须 `.catch(() => {})`。
  不吞掉的话，被占用时那次 reject 会变成 unhandledrejection，
  最后「渲染进程无未捕获错误」那一项会被自己制造的噪音判 FAIL（真踩过）。
### 5.16 pdf.js 的 destroy() 会 reject（自检偶发 FAIL 的根因）

`PDFDocumentProxy.destroy()` 返回 Promise：**渲染进行中被 destroy、
或对同一个 doc 重复 destroy 时都会 reject**。原版没吞掉这个 Promise，
于是偶发变成 unhandledrejection，界面自检「渲染进程无未捕获错误」这一项
就会**时好时坏**（构建脚本因此拒绝发布）。

修法：统一走 `safeDestroy(doc)`——try/catch 包一层 + `p.catch(() => {})`。
同一批修掉的还有 4 处裸 `doc.destroy()`。

同时把 `window.addEventListener('unhandledrejection', ...)` 的错误描述
换成 `describeErr(reason)`：原来直接 `String(reason)`，reason 是对象时
只会看到 `[object Object]`，根本查不出原因。
---

## 6. 测试怎么写、怎么跑

三层测试，全部可重复执行。

### 6.1 Rust 单元测试（14 项）

在 `src-tauri/src/pdfops.rs` 末尾 `#[cfg(test)] mod tests`。覆盖：页码表达式解析、顺序表达式、
插入位置、旋转角度校验、删除全部被拒、抽页、重排补尾、旋转累加、元数据保留、删完再读稳定。

    cd F:\PDFRev_Tauri\src-tauri
    & "$env:USERPROFILE\.cargo\bin\cargo.exe" test

### 6.2 真实文档端到端（examples/vpeg_check.rs）

拿用户的 `F:\PDFRev\test\VPEg.pdf`（62 页 / 10.35 MB）跑全流程：
读 -> 删页 -> 抽页 -> 旋转 -> 插入 -> 重排 -> 写盘 -> 再读校验，并断言**源文件 sha256 未被改动**。

    & "$env:USERPROFILE\.cargo\bin\cargo.exe" run --release --example vpeg_check

### 6.3 界面端到端自检（89 项，跑在真实 WebView2 里）

`src/selfcheck.js`。exe 带 `--selfcheck` 启动时，`selfcheck_enabled` 返回 true，前端加载完自动跑。

**为什么用轮询文件**：WebView2 是 GUI 进程，终端拿不到它的 stdout，
只能把报告写到 `%TEMP%\pdfrev-tauri-selfcheck.txt`，外部脚本轮询文件里出现「自检完成」标记。

覆盖清单（89 项）：
| 组 | 项数 | 覆盖内容 |
|---|---|---|
| 版权页 | 16 | 存在、工具栏按钮、首次弹出、四条条款齐全、版权行含版权方与邮箱、条款无重复编号、条款标题完整、标题为 MIT、声明以 MIT 发布、折叠区含全文、全文含五个要点段落、logo 已加载、logo 尺寸合理、文案与 i18n 词典一致、可关闭 |
| 顶栏品牌 | 3 | 品牌图标已加载、logo + PDFRev 排在版权按钮之前、标题字号 15px / 字重 >=800 |
| 桥接层 | 2 | window.api 注入、11 方法一一对应 |
| 命令行帮助 | 15 | 有「帮助」按钮、初始隐藏、可打开、列出全部 7 命令、命令名齐全、4 个通用参数、页码写法、插入位置写法、9 条示例、示例完整可复制、示例覆盖面、spec.json 样例、命令可点击复制、Esc 关闭、无未填占位 |
| IPC | 3 | read_file、返回 Uint8Array、pdf_info 页数 |
| 缩略图 | 2 | 打开后渲染 5 个缩略图、canvas 有内容像素（PDF.js 可用） |
| 顶栏信息 | 3 | 文件名/页数/大小、完整磁盘路径、创建与修改时间 |
| 预览 | 5 | 双击打开、停在正确页、滚轮放大、滚轮缩小、Delete 删当前页 |
| 页面操作 | 6 | 删除后页序正确、关闭预览后缩略图数、排序生效、撤销排序、旋转后可解析、旋转不改页序 |
| 保存 | 3 | save 落盘、磁盘文件页数、stat 返回时间 |
| 剪贴板与路径 | 2 | 写剪贴板、桥接层不返回磁盘路径（拖入走内存分支） |
| 真实文档 | 6 | 打开 VPEg.pdf、报 62 页、中文标题 UTF-16BE 正确解码、渲染 62 缩略图、缩略图有内容、删除第 1 页 |
| 稳定性 | 3 | 可重开帮助面板、窗口置前、渲染进程无未捕获错误 |
| 国际化 | 20 | 语言选择框存在、2 个选项、选项用各语言自身名称、所有 data-i18n 标记都能查到词条、静态标记覆盖 >=50 处、切英文后按钮文案变英文、`<html lang>` 变 en、标签变英文、版权页变英文、页数文案变英文（pages）、选择被 localStorage 记住、后端错误按语言渲染、切回中文后复原、缩略图角标重画、切语言不改页数、英文网页标题为 PDF Revisor、原生窗口标题读回为 PDF Revisor、切回中文后原生标题复原 |

    cd F:\PDFRev_Tauri
    powershell -ExecutionPolicy Bypass -File tools\selfcheck.ps1

### 6.4 一键：构建 + 三层测试 + 组装 dist

    powershell -ExecutionPolicy Bypass -File tools\build.ps1

---

## 7. 常用命令

    $cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"

    # 开发运行
    cd F:\PDFRev_Tauri\src-tauri; & $cargo run

    # 三层测试
    & $cargo test
    & $cargo run --release --example vpeg_check
    cd F:\PDFRev_Tauri; powershell -ExecutionPolicy Bypass -File tools\selfcheck.ps1

    # 发布构建 + 组装
    cd F:\PDFRev_Tauri; powershell -ExecutionPolicy Bypass -File tools\build.ps1

    # VPEg.pdf 基线校验（在 F:\PDFRev 跑）
    node -e "const{PDFDocument}=require('pdf-lib');PDFDocument.load(require('fs').readFileSync('test/VPEg.pdf'),{updateMetadata:false}).then(d=>console.log(d.getPageCount()+' 页 | '+d.getProducer()))"

自检报告：`%TEMP%\pdfrev-tauri-selfcheck.txt`
---

## 8. 已知限制

1. **NSIS 安装包未生成**：需要 `cargo install tauri-cli` 才能 `tauri build`。
   当前交付的是**单文件 exe**（放空目录即为便携版，已验证）。
2. **没有 CLI 形态**：原版也没有，所有操作走界面。
3. **没有「新建空白 PDF」**：原版同样没有，功能以对齐为界。
4. **插入后页面树扁平化**：插入会把页树展平，书签 / 大纲会丢。原版 Electron 版同样如此，不算回归。
5. **copy_referenced() 只深拷一层**：嵌套资源（表单 XObject 里的引用）可能不全。VPEg.pdf 及常规文档不受影响。
6. **图标是脚本生成的几何图形**，不是设计稿。
7. **拖入文件拿不到磁盘路径**：见 5.15，行为符合需求。

---

## 9. 用户文件与事故记录

**用户的文件绝不可改写。** 每轮验证都要比对 sha256。

| 文件 | 大小 | sha256 前 16 | 备注 |
|---|---|---|---|
| `F:\PDFRev\test\VPEg.pdf` | 10849010 | `32045FD8F1ACFD7C` | 62 页，Producer `Skia/PDF m153`，中文标题 UTF-16BE 无 BOM |
| `F:\PDFRev\test\ViPOS工作计划及进展-20260914-f.xlsx` | 46608 | `B470698E011FCB7C` | 不参与 PDF 流程，仅作核对 |

事故记录：本次开发**没有发生过**用户文件被改写。所有操作都是「读源文件 -> 内存操作 -> 写新文件」。
`vpeg_check` 每轮都会断言源文件 sha256 未变。

---

## 10. 下次继续时的起手式

    # 1. 确认环境还在
    & "$env:USERPROFILE\.cargo\bin\cargo.exe" --version

    # 2. 先跑测试，确认基线是绿的
    cd F:\PDFRev_Tauri\src-tauri; & "$env:USERPROFILE\.cargo\bin\cargo.exe" test
    cd F:\PDFRev_Tauri; powershell -ExecutionPolicy Bypass -File tools\selfcheck.ps1

    # 3. 再改代码。改完 src/*.js 记得重新 cargo build（见 5.5）

改动前先想清楚落点：

- **PDF 页面语义** -> `src-tauri/src/pdfops.rs`（并补单测）
- **新增一个界面能力** -> `src-tauri/src/lib.rs` 加命令 + `src/bridge-tauri.js` 加同名方法 + `src/app.js` 调用
- **纯界面** -> 只动 `src/*`，但必须重新 build
---

## 11. 本次交付的验证结果

全部通过（2026-09-21，**v0.12.0**）：

| 项 | 结果 |
|---|---|
| Rust 单元测试 | 14 项通过，0 失败 |
| 真实文档端到端 | 通过（62 页；删 / 抽 / 转 / 插 / 排序均正确） |
| 源文件完整性 | VPEg.pdf sha256 32045FD8F1ACFD7C 未变 |
| 界面自检 | 89 项通过，0 失败（真实 WebView2） |
| 发布物 | dist\PDFRev.exe 4,703,232 字节（4.49 MB），版本号 0.12.0 |
| 便携性 | 单独放空目录仍全绿，无需额外 dll |
| 体积对比 | Electron 便携版解压 233 MB -> Tauri 4.49 MB（1.93%） |
| 界面截图 | test\tauri-ui.png（2404x1639）、test\copyright.png（版权页，含 logo） |
| 应用图标 | exe 内嵌图标已换：32x32 抽样 69.7% 红色、真透明、无棋盘残留 |
| 版权页 | MIT 许可：无重复编号；含 logo（720x269）；含可展开的许可全文 |
| 多语言 | 界面全量支持简中 / 英文，顶栏语言选择框，后端错误也按语言渲染，窗口标题同步（20 项断言） |
| 校验值 | sha256 994CA77A12C2868FD11106E025AD3EA5DCA82BDA7279D6A12F4BBFAD947AB49F |

---

## 12. 与 Electron 原版的功能对照

| 功能 | 原版 | Tauri 版 | 备注 |
|---|---|---|---|
| 打开 PDF（对话框 / 多选） | 有 | 有 | |
| 拖拽文件到中心区域打开 | 有 | 有 | 不另存，直接读内存（见 5.15） |
| 缩略图列表 + 点击翻页 | 有 | 有 | |
| 拖拽排序页面 | 有 | 有 | |
| 删除页 / 按范围删 | 有 | 有 | |
| 抽取指定页为新文件 | 有 | 有 | |
| 旋转页面 | 有 | 有 | |
| 插入其它 PDF | 有 | 有 | |
| 双击页面预览 | 有 | 有 | |
| 预览滚轮缩放 | 有 | 有 | |
| 预览中 Delete 删页 | 有 | 有 | |
| 保存 / 另存为 | 有 | 有 | 原子写 |
| 只读文件处理 | 有 | 有 | |
| 顶栏文件名 + 完整路径 | 有 | 有 | |
| 顶栏创建 / 修改时间 | 有 | 有 | |
| 顶栏页数 / 体积 | 有 | 有 | |
| 在资源管理器定位 | 有 | 有 | |
| 复制文本到剪贴板 | 有 | 有 | |
| 版权页 | 许可条款页 | MIT 许可页（原版是自定义商业条款） |
| 多语言界面 | 无 | 简中 / 英文 + 顶栏语言选择框（全部菜单/按钮/提示/错误）；英文标题 PDF Revisor，窗口标题随语言切换 |

---

## 13. 交付物清单

- `dist\PDFRev.exe` — 单文件便携版（4.49 MB）
- `dist\LICENSE`（MIT）
- `README.md` — 使用与构建说明
- `handoff.md` — 本文件
- 源码：`src\`（前端）+ `src-tauri\src\`（Rust）
- 工具：`tools\build.ps1`、`tools\selfcheck.ps1`
- 工具：`tools\build.ps1`、`tools\selfcheck.ps1`、`tools\screenshot.ps1`、`tools\make-assets.py`、`tools\cli-help.js`、`tools\check-license.py`
- 素材：`src\assets\pdfrev_logo.png`（版权页）、`src\assets\pdfrev_icon.png`（顶栏）
- 设计原图：根目录 `pdfrev_icon.png`、`pdfrev_logo.png`（脚本的输入，不入构建产物）

发布版不含 `src-tauri\target\`（已 gitignore）。

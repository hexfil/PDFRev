'use strict';

/**
 * PDFRev 国际化（i18n）。
 *
 * 设计要点：
 *   1. 界面文案集中在 I18N_ZH / I18N_EN 两份词典里，逐键对应；
 *   2. index.html 的静态标记用 data-i18n / data-i18n-title / data-i18n-ph 打标，
 *      启动与切语言时由 applyI18n() 统一灌值（不写死中文，便于加语言）；
 *   3. app.js 里拼出来的动态文案走 t(key, params)；
 *   4. Rust 侧不返回中文错误，而是返回稳定的错误键 + 参数（{code, ekey, eargs}），
 *      由这里按当前语言渲染。这样加语言不必改 Rust，也不会漏翻后端提示。
 *
 * 缺键行为：当前语言缺某键时回落 zh，再不行显示键名本身 ——
 * 让漏翻「看得见」，而不是静默显示一片空白。
 */

/** localStorage 里记住用户选的语言 */
const I18N_LANG_KEY = 'pdfrev.lang';

/** 支持的语言：id 既是词典键，也是 <html lang> 与 <select> 的取值 */
const I18N_LANGS = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
];

const I18N_ZH = {
  'app.title': 'PDFRev - PDF 页面修改器',
  'app.fileFilter': 'PDF 文件',

  'tb.open': '打开 PDF',
  'tb.save': '保存',
  'tb.saveAs': '另存为',
  'tb.undo': '撤销',
  'tb.undoTip': '撤销上一步（Ctrl+Z）',
  'tb.copyright': '版权',
  'tb.copyrightTip': '查看版权与使用许可',
  'tb.langTip': '界面语言',
  'tb.langAria': '选择界面语言',

  'file.none': '未打开文件',
  'file.unsaved': '未保存到磁盘',
  'file.line1': '{name}  ·  {n} 页  ·  {size}',
  'file.times': '创建 {created}   ·   修改 {modified}',
  'file.tipCreated': '创建 {created}',
  'file.tipModified': '修改 {modified}',
  'file.tipUnsaved': '尚未保存到磁盘',
  'file.saveTo': '保存到 {path}',
  'file.pickSave': '选择保存位置',

  'pages.title': '页面',
  'pages.count': '{n} 页',
  'pages.selectAll': '全选',
  'pages.selectNone': '清空选择',
  'pages.selectInvert': '反选',
  'pages.empty': '打开一个 PDF 开始',
  'pages.rotateLeft': '↺ 左转',
  'pages.rotateLeftTip': '选中页逆时针旋转 90°',
  'pages.rotateRight': '↻ 右转',
  'pages.rotateRightTip': '选中页顺时针旋转 90°',
  'pages.deleteSel': '删除选中页',
  'pages.selInfo': '已选 {n} 页',

  'thumb.pick': '选中第 {i} 页',
  'thumb.page': '第 {i} 页',
  'thumb.origPage': '原第 {i} 页',

  'card.expr.title': '按页码操作',
  'card.expr.label': '页码表达式',
  'card.expr.ph': '如 2  或  3,5,8  或  3-5  或  5-end',
  'card.expr.del': '删除这些页',
  'card.expr.extract': '提取为新 PDF',

  'card.order.title': '页面排序',
  'card.order.label': '新顺序（逗号分隔的页码）',
  'card.order.ph': '如 3,1,2,4-6（未列出的页自动排到末尾）',
  'card.order.apply': '应用排序',
  'card.order.reverse': '反转全部页序',
  'card.order.hint': '也可以直接拖动左侧缩略图调整顺序。',
  'card.order.dragged': '拖动调整顺序',
  'card.order.applied': '已应用排序',
  'card.order.reversed': '已反转页序',

  'card.ins.title': '插入另一个 PDF',
  'card.ins.pick': '选择要插入的 PDF…',
  'card.ins.go': '插入',
  'card.ins.none': '未选择文件',
  'card.ins.picked': '{name}（{size}）',
  'card.ins.atLabel': '插入位置',
  'card.ins.atHead': '首页（最前面）',
  'card.ins.atTail': '尾页（最后面）',
  'card.ins.before': '第 {i} 页之前',
  'card.ins.after': '第 {i} 页之后',
  'card.ins.atCustom': '自定义…',
  'card.ins.atPh': '如 before:3 / after:4 / head / tail',
  'card.ins.pagesLabel': '插入该文件的哪些页（可留空 = 全部）',
  'card.ins.pagesPh': '如 1-2 或 3',

  'card.cli.title': '命令行等价',
  'card.cli.out': '拖拽或点击操作后，这里显示对应的 pdfrev 命令。',
  'card.cli.copyCmd': '复制命令',
  'card.cli.copyJson': '复制 JSON',
  'card.cli.help': '帮助',
  'card.cli.helpTip': '查看 pdfrev 命令行的全部参数与示例',
  'card.cli.noCmd': '（当前操作没有对应的批量命令）',

  'drop.text': '松开以打开 PDF',
  'drop.hint': '也可以拖到窗口任意位置',

  'pv.pageOf': '第 {p} 页 / 共 {t} 页',
  'pv.page': '第 {p} 页',
  'pv.prev': '← 上一页',
  'pv.next': '下一页 →',
  'pv.zoomOutTip': '缩小（滚轮向下 / Ctrl+-）',
  'pv.zoomFit': '适应',
  'pv.zoomFitTip': '适应窗口（Ctrl+0）',
  'pv.zoom100Tip': '实际大小 100%（Ctrl+1）',
  'pv.zoomInTip': '放大（滚轮向上 / Ctrl++）',
  'pv.delete': '删除此页 (Delete)',
  'pv.close': '关闭 (Esc)',
  'pv.loading': '渲染中…',
  'pv.foot': '滚轮缩放（或 Ctrl+滚轮）· 双击空白关闭 · Delete 删除本页 · ← → 翻页 · Esc 关闭',

  'ch.title': 'pdfrev 命令行帮助',
  'ch.close': '关闭 (Esc)',
  'ch.hCommands': '命令',
  'ch.hFlags': '通用参数',
  'ch.hSyntax': '写法速查',
  'ch.hExamples': '示例',
  'ch.hSpec': '批量执行 spec.json',
  'ch.specNote': 'pdfrev run 一次读入多步操作，步骤按数组顺序执行：',
  'ch.clickCopy': '点击复制',

  'cf.cancel': '取消',
  'cf.ok': '确定',

  'toast.opFail': '操作失败',
  'toast.opened': '已打开 {name}（{n} 页）',
  'toast.oneFile': '一次只打开一个文件，已用第一个：{name}',
  'toast.done': '完成',
  'toast.undone': '已撤销',
  'toast.saved': '已保存到 {path}',
  'toast.savedUnlock': '已清除只读属性并保存到 {path}',
  'toast.savedAs': '已另存为 {path}',
  'toast.readonlyAsk': '{msg}\n\n（清除后该文件即可被正常覆盖）',
  'toast.cantDeleteAll': '不能删除全部页面',
  'toast.deletedN': '已删除 {n} 页',
  'toast.deletedPages': '已删除 {spec}',
  'toast.deletedPage': '已删除第 {p} 页',
  'toast.pickRotate': '请先选中要旋转的页',
  'toast.rotatedN': '已旋转 {n} 页',
  'toast.needExpr': '请输入页码表达式',
  'toast.extracted': '已提取到 {path}',
  'toast.needOrder': '请输入新顺序',
  'toast.pickInsert': '请先选择要插入的 PDF',
  'toast.needPosition': '请填写插入位置',
  'toast.inserted': '已插入 {name}',
  'toast.noCmd': '暂无可复制的命令',
  'toast.cmdCopied': '命令已复制',
  'toast.noJson': '暂无可复制的 JSON',
  'toast.jsonCopied': 'JSON 已复制',
  'toast.copied': '已复制：{code}',
  'toast.copiedCmd': '已复制命令',
  'toast.copiedSpec': '已复制 spec.json',
  'toast.pickDeleteHint': '请先选中要删除的页，或双击某页进入预览后按 Delete',
  'toast.renderPageFail': '这一页渲染失败: {msg}',
  'toast.renderFail': '渲染失败: {msg}',
  'toast.lastPage': '只剩一页，不能删除',
  'toast.pdfOnly': '只支持 PDF 文件',
  'toast.readDragFail': '读取拖入的文件失败: {msg}',
  'toast.emptyDrag': '拖入的文件是空的',
  'toast.dragOpened': '已从拖入内容打开（未落盘），按「保存」可选择存放位置',

  'cr.title': 'MIT 开源许可',
  'cr.holder': '版权所有 © 2026， 何险峰 (He Xianfeng,  xfhe@ipe.ac.cn）',
  'cr.licenseHtml': '本软件以 <b>MIT License</b> 发布，全文见 <code>LICENSE</code>。',
  'cr.c1k': '授予的权利',
  'cr.c1t': '任何人可免费获得本软件及文档的副本，不受限制地使用、复制、修改、合并、发布、分发、再授权和/或销售本软件，但须遵守下列条件。',
  'cr.c2k': '保留声明',
  'cr.c2t': '上述版权声明与本许可声明必须包含在本软件的所有副本或主要部分中。',
  'cr.c3k': '免责声明',
  'cr.c3t': '本软件按「原样」提供，不附带任何明示或默示的担保，包括但不限于对适销性、特定用途适用性和非侵权的担保。',
  'cr.c4k': '责任限制',
  'cr.c4t': '作者或版权持有人不对任何索赔、损害或其他责任负责，无论该责任源于合同、侵权或其他方式，亦无论是否与软件或软件的使用或其他交易有关。',
  'cr.sep': '：',
  'cr.expand': '展开 MIT 许可全文',
  'cr.close': '关闭',
  'cr.repoLabel': '项目主页：{host}',

  'cli.cmd': '命令',
  'cli.flag': '通用参数',
  'cli.syntax': '写法速查',
  'cli.example': '示例',
  'cli.spec': '批量执行 spec.json',
};
const I18N_EN = {
  'app.title': 'PDF Revisor',
  'app.fileFilter': 'PDF files',

  'tb.open': 'Open PDF',
  'tb.save': 'Save',
  'tb.saveAs': 'Save As',
  'tb.undo': 'Undo',
  'tb.undoTip': 'Undo last step (Ctrl+Z)',
  'tb.copyright': 'License',
  'tb.copyrightTip': 'Copyright and license',
  'tb.langTip': 'Interface language',
  'tb.langAria': 'Choose interface language',

  'file.none': 'No file open',
  'file.unsaved': 'Not saved to disk',
  'file.line1': '{name}  ·  {n} pages  ·  {size}',
  'file.times': 'Created {created}   ·   Modified {modified}',
  'file.tipCreated': 'Created {created}',
  'file.tipModified': 'Modified {modified}',
  'file.tipUnsaved': 'Not yet saved to disk',
  'file.saveTo': 'Save to {path}',
  'file.pickSave': 'Choose where to save',

  'pages.title': 'Pages',
  'pages.count': '{n} pages',
  'pages.selectAll': 'Select all',
  'pages.selectNone': 'Clear',
  'pages.selectInvert': 'Invert',
  'pages.empty': 'Open a PDF to begin',
  'pages.rotateLeft': '↺ Left',
  'pages.rotateLeftTip': 'Rotate selected pages 90° counter-clockwise',
  'pages.rotateRight': '↻ Right',
  'pages.rotateRightTip': 'Rotate selected pages 90° clockwise',
  'pages.deleteSel': 'Delete selected',
  'pages.selInfo': '{n} selected',

  'thumb.pick': 'Select page {i}',
  'thumb.page': 'Page {i}',
  'thumb.origPage': 'was page {i}',

  'card.expr.title': 'By page numbers',
  'card.expr.label': 'Page expression',
  'card.expr.ph': 'e.g. 2  or  3,5,8  or  3-5  or  5-end',
  'card.expr.del': 'Delete these pages',
  'card.expr.extract': 'Extract as new PDF',

  'card.order.title': 'Reorder pages',
  'card.order.label': 'New order (comma-separated page numbers)',
  'card.order.ph': 'e.g. 3,1,2,4-6 (unlisted pages go to the end)',
  'card.order.apply': 'Apply order',
  'card.order.reverse': 'Reverse all pages',
  'card.order.hint': 'You can also drag thumbnails on the left to reorder.',
  'card.order.dragged': 'Reordered by dragging',
  'card.order.applied': 'Order applied',
  'card.order.reversed': 'Pages reversed',

  'card.ins.title': 'Insert another PDF',
  'card.ins.pick': 'Choose a PDF to insert…',
  'card.ins.go': 'Insert',
  'card.ins.none': 'No file chosen',
  'card.ins.picked': '{name} ({size})',
  'card.ins.atLabel': 'Insert position',
  'card.ins.atHead': 'First page (very front)',
  'card.ins.atTail': 'Last page (very end)',
  'card.ins.before': 'Before page {i}',
  'card.ins.after': 'After page {i}',
  'card.ins.atCustom': 'Custom…',
  'card.ins.atPh': 'e.g. before:3 / after:4 / head / tail',
  'card.ins.pagesLabel': 'Which pages of that file to insert (leave empty = all)',
  'card.ins.pagesPh': 'e.g. 1-2 or 3',

  'card.cli.title': 'CLI equivalent',
  'card.cli.out': 'After you drag or click an action, the matching pdfrev command appears here.',
  'card.cli.copyCmd': 'Copy command',
  'card.cli.copyJson': 'Copy JSON',
  'card.cli.help': 'Help',
  'card.cli.helpTip': 'Show all pdfrev command-line options and examples',
  'card.cli.noCmd': '(this action has no batch-command equivalent)',

  'drop.text': 'Release to open the PDF',
  'drop.hint': 'You can also drop it anywhere in the window',

  'pv.pageOf': 'Page {p} of {t}',
  'pv.page': 'Page {p}',
  'pv.prev': '← Previous',
  'pv.next': 'Next →',
  'pv.zoomOutTip': 'Zoom out (wheel down / Ctrl+-)',
  'pv.zoomFit': 'Fit',
  'pv.zoomFitTip': 'Fit to window (Ctrl+0)',
  'pv.zoom100Tip': 'Actual size 100% (Ctrl+1)',
  'pv.zoomInTip': 'Zoom in (wheel up / Ctrl++)',
  'pv.delete': 'Delete this page (Delete)',
  'pv.close': 'Close (Esc)',
  'pv.loading': 'Rendering…',
  'pv.foot': 'Wheel to zoom (or Ctrl+wheel) · double-click empty area to close · Delete removes this page · ← → to flip · Esc to close',

  'ch.title': 'pdfrev command-line help',
  'ch.close': 'Close (Esc)',
  'ch.hCommands': 'Commands',
  'ch.hFlags': 'Common options',
  'ch.hSyntax': 'Syntax cheat sheet',
  'ch.hExamples': 'Examples',
  'ch.hSpec': 'Batch spec.json',
  'ch.specNote': 'pdfrev run reads several steps at once and executes them in array order:',
  'ch.clickCopy': 'Click to copy',

  'cf.cancel': 'Cancel',
  'cf.ok': 'OK',

  'toast.opFail': 'Operation failed',
  'toast.opened': 'Opened {name} ({n} pages)',
  'toast.oneFile': 'Only one file at a time; used the first one: {name}',
  'toast.done': 'Done',
  'toast.undone': 'Undone',
  'toast.saved': 'Saved to {path}',
  'toast.savedUnlock': 'Cleared the read-only flag and saved to {path}',
  'toast.savedAs': 'Saved as {path}',
  'toast.readonlyAsk': '{msg}\n\n(the file can be overwritten normally once cleared)',
  'toast.cantDeleteAll': 'Cannot delete every page',
  'toast.deletedN': 'Deleted {n} pages',
  'toast.deletedPages': 'Deleted {spec}',
  'toast.deletedPage': 'Deleted page {p}',
  'toast.pickRotate': 'Select the pages to rotate first',
  'toast.rotatedN': 'Rotated {n} pages',
  'toast.needExpr': 'Enter a page expression',
  'toast.extracted': 'Extracted to {path}',
  'toast.needOrder': 'Enter the new order',
  'toast.pickInsert': 'Choose the PDF to insert first',
  'toast.needPosition': 'Enter the insert position',
  'toast.inserted': 'Inserted {name}',
  'toast.noCmd': 'No command to copy yet',
  'toast.cmdCopied': 'Command copied',
  'toast.noJson': 'No JSON to copy yet',
  'toast.jsonCopied': 'JSON copied',
  'toast.copied': 'Copied: {code}',
  'toast.copiedCmd': 'Command copied',
  'toast.copiedSpec': 'spec.json copied',
  'toast.pickDeleteHint': 'Select pages to delete first, or double-click a page and press Delete',
  'toast.renderPageFail': 'Failed to render this page: {msg}',
  'toast.renderFail': 'Render failed: {msg}',
  'toast.lastPage': 'Only one page left, cannot delete',
  'toast.pdfOnly': 'Only PDF files are supported',
  'toast.readDragFail': 'Failed to read the dropped file: {msg}',
  'toast.emptyDrag': 'The dropped file is empty',
  'toast.dragOpened': 'Opened from the dropped content (in memory); click Save to choose a location',

  'cr.title': 'MIT License',
  'cr.holder': 'Copyright © 2026 He Xianfeng (何险峰) <xfhe@ipe.ac.cn>',
  'cr.licenseHtml': 'This software is released under the <b>MIT License</b>; the full text is in <code>LICENSE</code>.',
  'cr.c1k': 'Granted rights',
  'cr.c1t': 'Anyone may obtain a free copy of this software and its documentation and use, copy, modify, merge, publish, distribute, sublicense and/or sell it without restriction, subject to the conditions below.',
  'cr.c2k': 'Notice retention',
  'cr.c2t': 'The copyright notice above and this permission notice must be included in all copies or substantial portions of the software.',
  'cr.c3k': 'Disclaimer',
  'cr.c3t': 'The software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and non-infringement.',
  'cr.c4k': 'Limitation of liability',
  'cr.c4t': 'In no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or its use or other dealings.',
  'cr.sep': ': ',
  'cr.expand': 'Show the full MIT license text',
  'cr.close': 'Close',
  'cr.repoLabel': 'Project home: {host}',

  'cli.cmd': 'Commands',
  'cli.flag': 'Common options',
  'cli.syntax': 'Syntax cheat sheet',
  'cli.example': 'Examples',
  'cli.spec': 'Batch spec.json',
};
/** 两语言错误键 -> 文案（Rust 侧只返回键与参数，翻译放在这里） */
const I18N_ERR = {
  zh: {
    'io.eacces': '没有写入权限，无法{act} {path}。若是系统保护目录，请改用「另存为」保存到文档或桌面。',
    'io.enotfound': '目标目录不存在：{dir}',
    'io.enotdir': '保存路径不合法（上级路径不是文件夹）：{path}',
    'io.enospc': '磁盘空间不足，无法保存。',
    'io.erofs': '目标磁盘是只读的，无法写入：{dir}',
    'io.ebusy': '文件正被其他程序占用（可能已在 PDF 阅读器中打开），请关闭后重试。',
    'io.act.create': '创建',
    'io.act.saveTo': '保存到',
    'readonly.ask': '文件是只读的，无法覆盖保存：{path}。是否清除只读属性后覆盖？',
    'file.notfound': '文件不存在: {path}',
    'pdf.parse': '{name} 无法解析（可能是加密或损坏文件）: {msg}',
    'pdf.b64': '数据解码失败: {msg}',
    'pdf.pagerange': '页码 {n} 超出范围（文档共 {total} 页）',
    'pdf.emptyPages': '页码参数为空',
    'pdf.badPage': '无法识别的页码写法: "{p}"',
    'pdf.noPages': '页码参数没有解析出任何页',
    'pdf.ambiguous': '位置 "{s}" 有歧义，请写成 before:{s} 或 after:{s}',
    'pdf.badPosition': '无法识别的插入位置: "{s}"',
    'pdf.noPosition': '缺少插入位置',
    'pdf.delAll': '不能删除全部页面，结果 PDF 会没有任何页',
    'pdf.need2': '排序至少需要 2 页',
    'pdf.angle': '旋转角度只能是 90 / 180 / 270',
    'pdf.insertEmpty': '待插入 PDF 没有可插入的页',
  'pdf.noInsertSource': '还没有选择要插入的 PDF，请先点「选择要插入的 PDF…」',
    'pdf.noPageTree': '重建后的 PDF 缺少页面树',
    'pdf.noCatalog': '重建后的 PDF 缺少 Catalog',
    'pdf.readPage': '读取页面对象失败: {msg}',
    'pdf.write': '生成 PDF 失败: {msg}',
    'pdf.readInsertPage': '读取待插入页面失败: {msg}',
    'pdf.unknownOp': '未知操作: {op}',
    'clip.fail': '写剪贴板失败: {msg}',
    'shell.fail': '无法打开资源管理器: {msg}',
    'app.noWindow': '没有主窗口',
    'shot.size': '取窗口尺寸失败: {msg}',
    'selfcheck.dir': '无法创建自检目录: {msg}',
    'selfcheck.write': '写自检报告失败: {msg}',
    'app.titleFail': '设置窗口标题失败: {msg}',
    'app.badUrl': '只能打开 http/https 链接: {url}',
    'app.openUrlFail': '无法打开链接: {msg}',
    'selfcheck.title': '无法读取窗口标题: {msg}',
  },
  en: {
    'io.eacces': 'No write permission, cannot {act} {path}. If this is a protected system folder, use "Save As" to save to Documents or Desktop.',
    'io.enotfound': 'Target directory does not exist: {dir}',
    'io.enotdir': 'Invalid save path (a parent path is not a folder): {path}',
    'io.enospc': 'Not enough disk space to save.',
    'io.erofs': 'The target disk is read-only, cannot write: {dir}',
    'io.ebusy': 'The file is in use by another program (it may be open in a PDF reader). Close it and try again.',
    'io.act.create': 'create',
    'io.act.saveTo': 'save to',
    'readonly.ask': 'The file is read-only and cannot be overwritten: {path}. Clear the read-only flag and overwrite?',
    'file.notfound': 'File does not exist: {path}',
    'pdf.parse': '{name} could not be parsed (possibly encrypted or damaged): {msg}',
    'pdf.b64': 'Data decoding failed: {msg}',
    'pdf.pagerange': 'Page {n} is out of range (the document has {total} pages)',
    'pdf.emptyPages': 'The page parameter is empty',
    'pdf.badPage': 'Unrecognized page syntax: "{p}"',
    'pdf.noPages': 'The page parameter did not resolve to any page',
    'pdf.ambiguous': 'Position "{s}" is ambiguous; write before:{s} or after:{s}',
    'pdf.badPosition': 'Unrecognized insert position: "{s}"',
    'pdf.noPosition': 'Insert position is missing',
    'pdf.delAll': 'Cannot delete every page; the resulting PDF would have no pages',
    'pdf.need2': 'Reordering needs at least 2 pages',
    'pdf.angle': 'Rotation angle must be 90 / 180 / 270',
    'pdf.insertEmpty': 'The PDF to insert has no insertable pages',
  'pdf.noInsertSource': 'No PDF to insert yet - pick one with the pick button first',
    'pdf.noPageTree': 'The rebuilt PDF is missing its page tree',
    'pdf.noCatalog': 'The rebuilt PDF is missing its Catalog',
    'pdf.readPage': 'Failed to read a page object: {msg}',
    'pdf.write': 'Failed to generate the PDF: {msg}',
    'pdf.readInsertPage': 'Failed to read a page to insert: {msg}',
    'pdf.unknownOp': 'Unknown operation: {op}',
    'clip.fail': 'Failed to write to the clipboard: {msg}',
    'shell.fail': 'Could not open File Explorer: {msg}',
    'app.noWindow': 'No main window',
    'shot.size': 'Failed to get the window size: {msg}',
    'selfcheck.dir': 'Could not create the self-check directory: {msg}',
    'selfcheck.write': 'Failed to write the self-check report: {msg}',
    'app.titleFail': 'Could not set the window title: {msg}',
    'app.badUrl': 'Only http/https links can be opened: {url}',
    'app.openUrlFail': 'Could not open the link: {msg}',
    'selfcheck.title': 'Could not read the window title: {msg}',
  },
};

/**
 * 当前语言。
 * 默认跟随系统语言，但用户一旦在语言框里选过就以他的选择为准。
 */
let i18nLang = 'zh';

/** 把 {name} 这类占位符替换成实参 */
function i18nFormat(s, params) {
  if (!params) return s;
  return String(s).replace(/\{(\w+)\}/g, (m, k) =>
    (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
}

/** 词典查键：当前语言 -> zh -> 键名（漏翻时看得见） */
function i18nRaw(key, params) {
  const cur = I18N_DICT_GET(i18nLang, key);
  if (cur !== undefined) return i18nFormat(cur, params);
  const fallback = I18N_DICT_GET('zh', key);
  if (fallback !== undefined) return i18nFormat(fallback, params);
  return key;
}

function I18N_DICT_GET(lang, key) {
  const d = lang === 'en' ? I18N_EN : I18N_ZH;
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

/** 取当前语言 */
function i18nGetLang() {
  return i18nLang;
}

/** 系统语言偏好是否更接近英文（首次启动时据此选默认语言） */
function i18nSystemPrefersEn() {
  try {
    const l = (navigator.language || '').toLowerCase();
    return l.startsWith('en');
  } catch (e) {
    return false;
  }
}

/** 从 localStorage 读上次选择；没有则按系统语言猜 */
function i18nLoadLang() {
  let saved = null;
  try { saved = localStorage.getItem(I18N_LANG_KEY); } catch (e) { /* 隐私模式 */ }
  if (saved && I18N_LANGS.some((l) => l.id === saved)) return saved;
  return i18nSystemPrefersEn() ? 'en' : 'zh';
}

/** 记住语言选择（写不进去也不影响本次使用） */
function i18nSaveLang(lang) {
  try { localStorage.setItem(I18N_LANG_KEY, lang); } catch (e) { /* 隐私模式 */ }
}
/** 对外主入口：当前语言下取文案 */
function t(key, params) {
  return i18nRaw(key, params);
}

/**
 * 渲染后端错误。
 *
 * Rust 侧返回 { code, ekey, eargs }：
 *   ekey  —— 稳定键，如 'pdf.pagerange'（不带语言）
 *   eargs —— 占位符实参，如 { n: 7, total: 5 }
 * 拿不到 ekey 时退回原始 error 文本（老行为，保证不会显示成空白）。
 */
function tErr(res) {
  if (!res) return t('toast.opFail');
  const key = res.ekey || (res.code ? 'err.' + res.code : '');
  const table = i18nLang === 'en' ? I18N_ERR.en : I18N_ERR.zh;
  const fallback = I18N_ERR.zh;
  if (key && (table[key] || fallback[key])) {
    const s = table[key] || fallback[key];
    // eargs.act 是 'create' / 'saveTo' 这类动作标记，翻译成对应语言的动词
    const args = Object.assign({}, res.eargs || {});
    if (args.act) args.act = i18nRaw('io.act.' + args.act);
    return i18nFormat(s, args);
  }
  return res.error || t('toast.opFail');
}

/**
 * 把 index.html 上所有 data-i18n* 标记按当前语言灌一遍。
 *
 * 支持三种标记：
 *   data-i18n         -> textContent
 *   data-i18n-html    -> innerHTML（只有 cr.licenseHtml 这类自带标签的用）
 *   data-i18n-title   -> title 属性
 *   data-i18n-ph      -> placeholder 属性
 *   data-i18n-aria    -> aria-label 属性
 */
function applyI18n(root) {
  const scope = root || document;

  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-ph'));
  });
  scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });

  document.title = t('app.title');
  document.documentElement.lang = i18nLang === 'en' ? 'en' : 'zh-CN';
  applyNativeTitle();
}

/**
 * 同步原生窗口标题（任务栏 / 标题栏）。
 *
 * <title> 只影响网页自己，任务栏上显示的是窗口属性，所以要多调一次 Rust。
 * 启动时 window.api 可能还没被 bridge-tauri.js 装好（脚本顺序：i18n 在它前面），
 * 那就等 DOMContentLoaded 再补一次 —— 两种情况都必须覆盖，否则英文界面下
 * 任务栏还挂着中文标题。
 */
function applyNativeTitle() {
  const title = t('app.title');
  try {
    if (window.api && typeof window.api.setWindowTitle === 'function') {
      const p = window.api.setWindowTitle(title);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {
    /* 桥接层还没就绪 / 非 Tauri 环境（纯浏览器打开）都不影响界面 */
  }
}

/** 语言下拉里可选项（<option> 用各语言自己的名字，不翻译） */
function i18nOptionsHtml() {
  return I18N_LANGS.map((l) =>
    '<option value="' + l.id + '">' + l.label + '</option>').join('');
}

/**
 * 切换语言：更新词典、灌静态标记、通知 app.js 重渲染动态文案。
 *
 * 「通知」走一个自定义事件，避免 i18n.js 反向依赖 app.js
 * （app.js 才是了解哪些内容需要重画的那个）。
 */
function setLang(lang) {
  if (!I18N_LANGS.some((l) => l.id === lang)) return;
  i18nLang = lang;
  i18nSaveLang(lang);
  applyI18n();
  window.dispatchEvent(new CustomEvent('pdfrev:langchange', { detail: { lang } }));
}

/** 启动：定语言 + 灌一遍静态标记（app.js 会在之后补动态部分） */
function i18nInit() {
  i18nLang = i18nLoadLang();
  applyI18n();
}

i18nInit();

/* bridge-tauri.js 在本文件之后加载，启动那一刻还没有 window.api；
   等 DOM 就绪再补一次原生标题。 */
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyNativeTitle);
  } else {
    applyNativeTitle();
  }
}
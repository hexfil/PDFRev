'use strict';

/**
 * 「命令行等价」区的帮助内容 —— 单一来源。
 *
 *   node tools/cli-help.js           # 写入 src/app.js（幂等）
 *   node tools/cli-help.js --check   # 只校验，CI / 自检用
 *
 * 为什么用脚本生成：帮助里描述的命令、参数、页码语法必须与原版 CLI
 * （F:\PDFRev\src\cli.js 的 USAGE、parseArgs、各分支）保持一致，手抄会漂。
 * 这里的 CLI_USAGE 就是原版 USAGE 的可读版本，CLI_TABLE / CLI_EXAMPLES
 * 逐条对应原版的命令分支。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_JS = path.join(ROOT, 'src', 'app.js');

const CLI_NAME = 'pdfrev';

/**
 * 帮助内容按语言组织。
 *
 * 命令、参数、语法（页码写法、位置写法）在各语言里都保持与真实 CLI 完全一致 ——
 * 这些是「要照抄进终端」的东西，不能翻译；翻译的只有说明文字。
 * 所以结构上把「可复制的命令串」与「解释」分开：*_CMD 不翻译，*_D 逐语言。
 */
const CLI_HELP = {
  zh: {
    cmds: [
      { n: 'info',    u: 'pdfrev info <文件>',
        d: '只读：打印页数（以及有的话，标题）。不改写文件。' },
      { n: 'reorder', u: 'pdfrev reorder <文件> --order 3,1,2 [-o 输出.pdf]',
        d: '按给定顺序重排页面。未列出的页自动按原顺序追加到末尾。' },
      { n: 'delete',  u: 'pdfrev delete <文件> --pages 2,5,7-9 [-o 输出.pdf]',
        d: '删除指定页。别名 remove。' },
      { n: 'extract', u: 'pdfrev extract <文件> --pages 1-3 [-o 输出.pdf]',
        d: '只保留指定页，导出为新 PDF。' },
      { n: 'rotate',  u: 'pdfrev rotate <文件> [--pages 2] [--angle 90] [-o 输出.pdf]',
        d: '旋转页面，角度为 90 的整数倍；--pages 省略时表示 all。' },
      { n: 'insert',  u: 'pdfrev insert <文件> --pdf 插页.pdf --at head|tail|before:3|after:4 [--pages 1-2] [-o 输出.pdf]',
        d: '把另一个 PDF 插进来。--pages 指定插入源里的哪些页，留空表示全部。' },
      { n: 'run',     u: 'pdfrev run <spec.json|-> [-o 输出.pdf]',
        d: '批量：从 JSON 读多步操作依次执行。文件名写 - 表示从标准输入读。' },
    ],
    flags: [
      { f: '-o, --output <路径>', d: '输出文件。省略时在原文件旁写 <原名>-out.pdf。' },
      { f: '--json',              d: '输出机器可读的 JSON（成功 {ok:true,...}，失败 {ok:false,error}）。' },
      { f: '--dry-run',           d: '只算不写：不产生输出文件，用于预览结果。' },
      { f: '-h, --help',          d: '打印用法。不带任何参数运行也等同于帮助。' },
      { f: '-V, --version',       d: 'PDFRev.exe 打印版本号并退出（图形界面本体不接收其它参数）。' },
    ],
    syntax: [
      { k: '页码', v: '2  ·  3,5,8  ·  3-5  ·  5-end  ·  all' },
      { k: '位置', v: 'head=首页  ·  tail=尾页  ·  before:3=第 3 页前  ·  after:4=第 4 页后' },
      { k: '顺序', v: '--order 3,1,2（未列出的页自动追加到末尾）' },
      { k: '退出码', v: '0 成功，1 失败（错误信息走 stderr；配 --json 时为 stdout 的 JSON）' },
    ],
    examples: [
      { d: '看页数（只读，不动文件）', c: 'pdfrev info in.pdf' },
      { d: '删掉第 2、5 页和第 7~9 页', c: 'pdfrev delete in.pdf --pages 2,5,7-9 -o out.pdf' },
      { d: '只留下前 3 页，另存为新文件', c: 'pdfrev extract in.pdf --pages 1-3 -o cover.pdf' },
      { d: '把第 3 页提到最前面', c: 'pdfrev reorder in.pdf --order 3,1,2 -o out.pdf' },
      { d: '第 2 页顺时针转 90 度', c: 'pdfrev rotate in.pdf --pages 2 --angle 90 -o out.pdf' },
      { d: '整个文档转正 180 度', c: 'pdfrev rotate in.pdf --angle 180 -o out.pdf' },
      { d: '把插页.pdf 的第 1 页插到第 3 页之前', c: 'pdfrev insert in.pdf --pdf 插页.pdf --at before:3 --pages 1 -o out.pdf' },
      { d: '只算不写，先看结果', c: 'pdfrev delete in.pdf --pages 2 --dry-run --json' },
      { d: '批量：一趟做完删页 + 重排', c: 'pdfrev run spec.json -o out.pdf' },
    ],
  },
  en: {
    cmds: [
      { n: 'info',    u: 'pdfrev info <file>',
        d: 'Read-only: print the page count (and the title, if present). Does not modify the file.' },
      { n: 'reorder', u: 'pdfrev reorder <file> --order 3,1,2 [-o out.pdf]',
        d: 'Reorder pages as given. Pages not listed are appended at the end in their original order.' },
      { n: 'delete',  u: 'pdfrev delete <file> --pages 2,5,7-9 [-o out.pdf]',
        d: 'Delete the given pages. Alias: remove.' },
      { n: 'extract', u: 'pdfrev extract <file> --pages 1-3 [-o out.pdf]',
        d: 'Keep only the given pages and export them as a new PDF.' },
      { n: 'rotate',  u: 'pdfrev rotate <file> [--pages 2] [--angle 90] [-o out.pdf]',
        d: 'Rotate pages; the angle must be a multiple of 90. Omitting --pages means all.' },
      { n: 'insert',  u: 'pdfrev insert <file> --pdf insert.pdf --at head|tail|before:3|after:4 [--pages 1-2] [-o out.pdf]',
        d: 'Insert another PDF. --pages selects which pages of the source to insert; empty means all.' },
      { n: 'run',     u: 'pdfrev run <spec.json|-> [-o out.pdf]',
        d: 'Batch: read several steps from JSON and run them in order. Use - as the file name to read stdin.' },
    ],
    flags: [
      { f: '-o, --output <path>', d: 'Output file. If omitted, writes <name>-out.pdf next to the original.' },
      { f: '--json',              d: 'Emit machine-readable JSON (success {ok:true,...}, failure {ok:false,error}).' },
      { f: '--dry-run',           d: 'Compute only, write nothing: use it to preview the result.' },
      { f: '-h, --help',          d: 'Print usage. Running with no arguments is equivalent to help.' },
      { f: '-V, --version',       d: 'PDFRev.exe prints its version and exits (the GUI takes no other arguments).' },
    ],
    syntax: [
      { k: 'Pages',    v: '2  ·  3,5,8  ·  3-5  ·  5-end  ·  all' },
      { k: 'Position', v: 'head=very front  ·  tail=very end  ·  before:3=before page 3  ·  after:4=after page 4' },
      { k: 'Order',    v: '--order 3,1,2 (unlisted pages are appended at the end)' },
      { k: 'Exit code', v: '0 success, 1 failure (errors go to stderr; with --json they go to stdout as JSON)' },
    ],
    examples: [
      { d: 'Show the page count (read-only, does not touch the file)', c: 'pdfrev info in.pdf' },
      { d: 'Delete pages 2, 5 and 7-9', c: 'pdfrev delete in.pdf --pages 2,5,7-9 -o out.pdf' },
      { d: 'Keep only the first 3 pages, save as a new file', c: 'pdfrev extract in.pdf --pages 1-3 -o cover.pdf' },
      { d: 'Move page 3 to the very front', c: 'pdfrev reorder in.pdf --order 3,1,2 -o out.pdf' },
      { d: 'Rotate page 2 by 90 degrees clockwise', c: 'pdfrev rotate in.pdf --pages 2 --angle 90 -o out.pdf' },
      { d: 'Rotate the whole document upright by 180 degrees', c: 'pdfrev rotate in.pdf --angle 180 -o out.pdf' },
      { d: 'Insert page 1 of insert.pdf before page 3', c: 'pdfrev insert in.pdf --pdf insert.pdf --at before:3 --pages 1 -o out.pdf' },
      { d: 'Compute only, preview the result first', c: 'pdfrev delete in.pdf --pages 2 --dry-run --json' },
      { d: 'Batch: delete + reorder in one pass', c: 'pdfrev run spec.json -o out.pdf' },
    ],
  },
};

/** 保持旧名字指向中文，兼容已有引用与自检 */
const CLI_COMMANDS = CLI_HELP.zh.cmds;
const CLI_FLAGS = CLI_HELP.zh.flags;
const CLI_SYNTAX = CLI_HELP.zh.syntax;
const CLI_EXAMPLES = CLI_HELP.zh.examples;

/** 批量 spec.json 的样子 */
const CLI_SPEC = [
  '{',
  '  "input": "in.pdf",',
  '  "output": "out.pdf",',
  '  "steps": [',
  '    { "op": "delete",  "pages": "2,5" },',
  '    { "op": "rotate",  "pages": "1", "angle": 90 },',
  '    { "op": "reorder", "order": "3,1,2" }',
  '  ]',
  '}',
];

/** 生成注入 app.js 的常量块 */
function block() {
  const J = (v) => JSON.stringify(v, null, 2).split('\n')
    .map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
  return [
    '/* ==== CLI-HELP-BLOCK: 由 tools/cli-help.js 生成，勿手改 ==== */',
    '',
    'const CLI_NAME = ' + JSON.stringify(CLI_NAME) + ';',
    'const CLI_SPEC = ' + J(CLI_SPEC.join('\n')) + ';',
    '',
    '/** 帮助内容按语言分组；渲染时按当前语言取一份（CLI_HELP_OF） */',
    'const CLI_HELP_BY_LANG = {',
    '  zh: ' + J(CLI_HELP.zh) + ',',
    '  en: ' + J(CLI_HELP.en) + ',',
    '};',
    '',
    '/** 取当前语言的帮助内容；没有该语言就回落中文 */',
    'function CLI_HELP_OF() {',
    '  return CLI_HELP_BY_LANG[i18nGetLang()] || CLI_HELP_BY_LANG.zh;',
    '}',
    '',
    '/** 兼容旧引用（自检里会用） */',
    'const CLI_COMMANDS = CLI_HELP_BY_LANG.zh.cmds;',
    'const CLI_FLAGS = CLI_HELP_BY_LANG.zh.flags;',
    'const CLI_SYNTAX = CLI_HELP_BY_LANG.zh.syntax;',
    'const CLI_EXAMPLES = CLI_HELP_BY_LANG.zh.examples;',
    '',
  ].join('\n');
}

const MARK = '/* ==== CLI-HELP-BLOCK:';

/**
 * 把生成块写进 app.js。
 *
 * 必须幂等：写一次和写两次的结果要完全一样，否则 --check 会永远报「不同步」。
 * 所以两条分支统一成「正文（去掉尾部空白）+ 恰好一个空行 + 生成块」——
 * 早先的写法在首次生成时留了两个换行、再次生成只留一个，正是这个 bug。
 */
function inject(src) {
  const b = block();                       // 生成块本身不以空行开头
  const i = src.indexOf(MARK);
  const head = (i < 0 ? src : src.slice(0, i)).replace(/\s+$/, '');
  return head + '\n\n' + b + '\n';
}

const check = process.argv.includes('--check');
const before = fs.readFileSync(APP_JS, 'utf8');
const after = inject(before);

if (check) {
  if (after !== before) {
    console.error('命令行帮助与工具不同步，请运行 node tools\\cli-help.js');
    process.exit(1);
  }
  console.log('命令行帮助已同步（' + CLI_COMMANDS.length + ' 个命令 / ' +
    CLI_FLAGS.length + ' 个通用参数 / ' + CLI_EXAMPLES.length + ' 个示例）');
} else {
  fs.writeFileSync(APP_JS, after);
  console.log(after === before ? '命令行帮助无需更新' : '命令行帮助已写入 src/app.js');
}

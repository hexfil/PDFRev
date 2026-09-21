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

/** 各命令：name / 用法 / 说明 */
const CLI_COMMANDS = [
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
];

/** 通用参数 */
const CLI_FLAGS = [
  { f: '-o, --output <路径>', d: '输出文件。省略时在原文件旁写 <原名>-out.pdf。' },
  { f: '--json',              d: '输出机器可读的 JSON（成功 {ok:true,...}，失败 {ok:false,error}）。' },
  { f: '--dry-run',           d: '只算不写：不产生输出文件，用于预览结果。' },
  { f: '-h, --help',          d: '打印用法。不带任何参数运行也等同于帮助。' },
];

/** 语法速查 */
const CLI_SYNTAX = [
  { k: '页码', v: '2  ·  3,5,8  ·  3-5  ·  5-end  ·  all' },
  { k: '位置', v: 'head=首页  ·  tail=尾页  ·  before:3=第 3 页前  ·  after:4=第 4 页后' },
  { k: '顺序', v: '--order 3,1,2（未列出的页自动追加到末尾）' },
  { k: '退出码', v: '0 成功，1 失败（错误信息走 stderr；配 --json 时为 stdout 的 JSON）' },
];

/** 可复制的示例（按“从简到繁”排） */
const CLI_EXAMPLES = [
  { d: '看页数（只读，不动文件）', c: 'pdfrev info in.pdf' },
  { d: '删掉第 2、5 页和第 7~9 页', c: 'pdfrev delete in.pdf --pages 2,5,7-9 -o out.pdf' },
  { d: '只留下前 3 页，另存为新文件', c: 'pdfrev extract in.pdf --pages 1-3 -o cover.pdf' },
  { d: '把第 3 页提到最前面', c: 'pdfrev reorder in.pdf --order 3,1,2 -o out.pdf' },
  { d: '第 2 页顺时针转 90 度', c: 'pdfrev rotate in.pdf --pages 2 --angle 90 -o out.pdf' },
  { d: '整个文档转正 180 度', c: 'pdfrev rotate in.pdf --angle 180 -o out.pdf' },
  { d: '把插页.pdf 的第 1 页插到第 3 页之前', c: 'pdfrev insert in.pdf --pdf 插页.pdf --at before:3 --pages 1 -o out.pdf' },
  { d: '只算不写，先看结果', c: 'pdfrev delete in.pdf --pages 2 --dry-run --json' },
  { d: '批量：一趟做完删页 + 重排', c: 'pdfrev run spec.json -o out.pdf' },
];

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
    'const CLI_COMMANDS = ' + J(CLI_COMMANDS) + ';',
    'const CLI_FLAGS = ' + J(CLI_FLAGS) + ';',
    'const CLI_SYNTAX = ' + J(CLI_SYNTAX) + ';',
    'const CLI_EXAMPLES = ' + J(CLI_EXAMPLES) + ';',
    'const CLI_SPEC = ' + J(CLI_SPEC.join('\n')) + ';',
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

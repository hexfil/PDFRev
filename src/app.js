'use strict';

/* global pdfjsLib */

const bridge = window.api;
const $ = (id) => document.getElementById(id);

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.js';

const state = {
  filePath: null,
  fileName: null,
  /**
   * 打开来源：
   *   'disk' —— 有真实磁盘路径，保存 = 直接覆盖原文件
   *   'drag' —— 拖入但拿不到路径，需首次保存时选位置（不会自动另存）
   */
  origin: 'disk',
  /** 磁盘文件时间戳（毫秒），打开 / 保存后刷新；拿不到时为 null */
  fileTimes: null,
  bytes: null,        // Uint8Array，当前工作状态
  history: [],        // 撤销栈（Uint8Array）
  total: 0,
  selected: new Set(),// 选中的 1 基页码
  insertBytes: null,
  insertName: null,
  lastCmd: '',
  lastJson: null,
};

let renderToken = 0;

function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function fail(res) {
  if (!res || res.ok === false) {
    toast(tErr(res), true);
    return true;
  }
  return false;
}

/* ---------------- 状态同步到界面 ---------------- */

/** 按当前文档页数重建“插入位置”下拉，避免出现越界页码 */
function rebuildInsertAt() {
  const sel = $('insertAt');
  const keep = sel.value;
  const total = state.total;
  // 长文档只列出前 300 页避免下拉过长，其余页码用下面的“自定义…”输入
  const max = Math.min(total, 300);
  const opts = ['<option value="head">' + t('card.ins.atHead') + '</option>', '<option value="tail">' + t('card.ins.atTail') + '</option>'];
  for (let i = 1; i <= max; i++) {
    opts.push('<option value="before:' + i + '">' + t('card.ins.before', { i: i }) + '</option>');
    opts.push('<option value="after:' + i + '">' + t('card.ins.after', { i: i }) + '</option>');
  }
  opts.push('<option value="custom">' + t('card.ins.atCustom') + '</option>');
  sel.innerHTML = opts.join('');
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'head';
}

/** 时间戳 -> 「2026-09-20 18:49」 */
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

/**
 * 顶栏文件信息：
 *   第一行 —— 文件名 · 页数 · 大小  [+ 路径提示]
 *   第二行 —— 完整路径，以及创建时间 / 修改时间
 * 路径用 textContent 写入（不是 innerHTML），文件名里的特殊字符不会被当成标签。
 */
function renderFileInfo() {
  const el = $('fileInfo');
  if (!state.bytes) {
    el.textContent = t('file.none');
    el.classList.remove('has-path');
    el.title = '';
    return;
  }

  const line1 = document.createElement('span');
  line1.className = 'fi-main';
  line1.textContent = t('file.line1', { name: state.fileName, n: state.total, size: fmtSize(state.bytes.length) });

  const line2 = document.createElement('span');
  line2.className = 'fi-sub';

  if (state.filePath) {
    const pathEl = document.createElement('span');
    pathEl.className = 'fi-path';
    pathEl.textContent = state.filePath;
    line2.appendChild(pathEl);

    const times = state.fileTimes;
    const meta = document.createElement('span');
    meta.className = 'fi-meta';
    meta.textContent = t('file.times', { created: fmtTime(times && times.created), modified: fmtTime(times && times.modified) });
    line2.appendChild(meta);
  } else {
    const unsaved = document.createElement('span');
    unsaved.className = 'fi-path';
    unsaved.textContent = t('file.unsaved');
    line2.appendChild(unsaved);
  }

  el.textContent = '';
  el.appendChild(line1);
  el.appendChild(line2);
  el.classList.add('has-path');
  el.title = state.filePath
    ? state.filePath + '\n' + t('file.tipCreated', { created: fmtTime(state.fileTimes && state.fileTimes.created) })
      + '\n' + t('file.tipModified', { modified: fmtTime(state.fileTimes && state.fileTimes.modified) })
    : t('file.tipUnsaved');
}

async function refreshFileTimes() {
  if (!state.filePath) { state.fileTimes = null; return; }
  const res = await bridge.stat(state.filePath);
  state.fileTimes = res && res.ok && res.stat ? res.stat : null;
}

function syncToolbar() {
  const open = !!state.bytes;
  const sel = state.selected.size;
  $('btnSave').disabled = !open;
  $('btnSaveAs').disabled = !open;
  $('btnUndo').disabled = !state.history.length;
  $('btnExprDelete').disabled = !open;
  $('btnExprExtract').disabled = !open;
  $('btnApplyOrder').disabled = !open;
  $('btnReverse').disabled = !open || state.total < 2;
  $('btnInsert').disabled = !open || !state.insertBytes;
  $('btnRotateLeft').disabled = !open || !sel;
  $('btnRotateRight').disabled = !open || !sel;
  $('btnDeleteSel').disabled = !open || !sel;
  renderFileInfo();
  btnSave.title = state.filePath ? t('file.saveTo', { path: state.filePath }) : t('file.pickSave');
  pageCount.textContent = open ? t('pages.count', { n: state.total }) : '';
  selInfo.textContent = t('pages.selInfo', { n: sel });
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function setCmd(cmd, json) {
  state.lastCmd = cmd || '';
  state.lastJson = json || null;
  cliOut.textContent = cmd || t('card.cli.noCmd');
}

/* ---------------- 加载 / 渲染 ---------------- */

async function loadPdfFile(path) {
  const res = await bridge.readFile(path);
  if (fail(res)) return;
  await loadBytes(new Uint8Array(res.file.data), res.file.path, res.file.name);
}

async function loadBytes(bytes, path, name, origin) {
  if (pv.open) closePreview();
  state.bytes = bytes;
  state.filePath = path;
  state.fileName = name;
  state.origin = origin || 'disk';
  state.history = [];
  state.selected.clear();
  await refreshFileTimes();   // 顶栏要显示创建 / 修改时间
  const info = await bridge.info(bytes);
  if (fail(info)) return;
  state.total = info.info.pages;
  rebuildInsertAt();
  syncToolbar();
  await renderThumbs();
  toast(t('toast.opened', { name: name, n: state.total }));
}

async function renderThumbs() {
  const token = ++renderToken;
  const pane = $('thumbs');
  pane.innerHTML = '';
  if (!state.bytes) {
    pane.innerHTML = '<div class="empty">' + t('pages.empty') + '</div>';
    return;
  }

  const doc = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;

  for (let i = 1; i <= doc.numPages; i++) {
    const card = document.createElement('div');
    card.className = 'thumb';
    card.dataset.page = String(i);
    card.draggable = true;

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'chk';
    chk.checked = state.selected.has(i);
    chk.title = t('thumb.pick', { i: i });
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) state.selected.add(i); else state.selected.delete(i);
      card.classList.toggle('selected', chk.checked);
      syncToolbar();
    });

    const wrap = document.createElement('div');
    wrap.className = 'canvas-wrap';
    wrap.innerHTML = '<span class="ph">' + t('thumb.page', { i: i }) + '</span>';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<span class="idx">' + t('thumb.origPage', { i: i }) + '</span><span class="new-idx">' + i + '</span>';

    card.appendChild(chk);
    card.appendChild(wrap);
    card.appendChild(meta);

    card.addEventListener('click', () => {
      chk.checked = !chk.checked;
      chk.dispatchEvent(new Event('change'));
    });

    // 双击进入大图预览
    card.addEventListener('dblclick', (e) => {
      e.preventDefault();
      openPreview(i);
    });

    bindDrag(card);
    pane.appendChild(card);
  }

  syncToolbar();

  // 逐个渲染缩略图，保证界面先出来
  for (let i = 1; i <= doc.numPages; i++) {
    if (token !== renderToken) { safeDestroy(doc); return; }
    const card = pane.querySelector('.thumb[data-page="' + i + '"]');
    if (!card) continue;
    try {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(150 / base.width, 165 / base.height);
      const vp = page.getViewport({ scale: Math.max(scale, 0.08) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const wrapEl = card.querySelector('.canvas-wrap');
      wrapEl.innerHTML = '';
      wrapEl.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    } catch (err) {
      /* 单页渲染失败不影响其他页 */
    }
  }
  safeDestroy(doc);
}

/**
 * 安全释放 PDFDocumentProxy。
 *
 * pdf.js 的 destroy() 返回 Promise：渲染进行中被 destroy、
 * 或对同一个 doc 重复 destroy 时都会 reject。不吞掉就变成
 * unhandledrejection，自检里表现为偶发的未捕获错误。
 */
function safeDestroy(doc) {
  if (!doc) return;
  try {
    const p = doc.destroy();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ---------------- 拖拽排序 ---------------- */

let dragSrc = null;

function bindDrag(card) {
  card.addEventListener('dragstart', (e) => {
    dragSrc = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.page);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    clearDropMarks();
    dragSrc = null;
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragSrc || dragSrc === card) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    card.classList.toggle('drop-before', !after);
    card.classList.toggle('drop-after', after);
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('drop-before', 'drop-after');
  });
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    const after = card.classList.contains('drop-after');
    clearDropMarks();
    if (!dragSrc || dragSrc === card) return;
    const pane = $('thumbs');
    if (after) card.after(dragSrc); else card.before(dragSrc);
    const order = [...pane.querySelectorAll('.thumb')].map((el) => Number(el.dataset.page));
    await applyOrder(order, t('card.order.dragged'));
  });
}

function clearDropMarks() {
  document.querySelectorAll('.thumb').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

/* ---------------- 操作 ---------------- */

function pushHistory() {
  state.history.push(state.bytes);
  if (state.history.length > 40) state.history.shift();
}

async function applyOrder(order, label) {
  pushHistory();
  const res = await bridge.op('reorder', state.bytes, { order: order.join(',') });
  if (fail(res)) { state.history.pop(); return; }
  state.bytes = new Uint8Array(res.data);
  state.selected.clear();
  state.total = order.length;
  setCmd(
    'pdfrev reorder "' + state.fileName + '" --order ' + order.join(',') + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'reorder', order: order.join(',') }] }
  );
  toast(label || t('card.order.applied'));
  await renderThumbs();
}

async function doOp(op, args, cmd, json, label) {
  if (!state.bytes) return;
  pushHistory();
  const res = await bridge.op(op, state.bytes, args);
  if (fail(res)) { state.history.pop(); return; }
  state.bytes = new Uint8Array(res.data);
  if (op === 'delete') {
    const rest = [...state.selected].length;
    state.selected.clear();
  }
  const info = await bridge.info(state.bytes);
  if (info.ok) state.total = info.info.pages;
  setCmd(cmd, json);
  toast(label || t('toast.done'));
  await renderThumbs();
}

async function refreshTotal() {
  const info = await bridge.info(state.bytes);
  if (info.ok) state.total = info.info.pages;
  rebuildInsertAt();
  syncToolbar();
}

/* ---------------- 事件绑定 ---------------- */

$('btnOpen').addEventListener('click', async () => {
  const res = await bridge.openPdf();
  if (fail(res)) return;
  if (res.canceled) return;
  const f = res.files[0];
  if (res.files.length > 1) toast(t('toast.oneFile', { name: f.name }));
  await loadBytes(new Uint8Array(f.data), f.path, f.name);
});

/**
 * 保存到已有路径。
 * 目标文件带只读属性时（常见于从微信/网盘/邮件另存出来的 PDF），
 * Windows 会直接抛 EPERM「operation is not permitted」。
 * 这种情况先问用户，同意后清除只读属性再覆盖。
 */
async function saveToPath(target, unlock) {
  let res = await bridge.save(target, state.bytes, !!unlock);
  if (res && res.ok === false && res.code === 'READONLY') {
    const yes = await askConfirm(t('toast.readonlyAsk', { msg: tErr(res) }));
    if (!yes) return null;
    res = await bridge.save(target, state.bytes, true);
  }
  if (fail(res)) return null;
  // 保存会改写修改时间，重新读一次磁盘时间戳
  await refreshFileTimes();
  if (res.clearedReadonly) toast(t('toast.savedUnlock', { path: res.path }));
  else toast(t('toast.saved', { path: res.path }));
  syncToolbar();
  return res;
}

$('btnSave').addEventListener('click', async () => {
  if (!state.bytes) return;
  // 拖入且拿不到路径时，第一次保存才需要用户指定落盘位置
  if (!state.filePath) {
    const picked = await bridge.promptSavePath(state.fileName || 'output.pdf');
    if (fail(picked)) return;
    if (picked.canceled) return;
    state.filePath = picked.path;
    state.origin = 'disk';
  }
  await saveToPath(state.filePath, false);
});

$('btnSaveAs').addEventListener('click', async () => {
  if (!state.bytes) return;
  const base = (state.fileName || 'output.pdf').replace(/\.pdf$/i, '');
  const res = await bridge.saveAs(state.bytes, base + '-rev.pdf');
  if (fail(res)) return;
  if (res.canceled) return;
  toast(t('toast.savedAs', { path: res.path }));
  bridge.showItem(res.path);
});

$('btnUndo').addEventListener('click', async () => {
  if (!state.history.length) return;
  state.bytes = state.history.pop();
  state.selected.clear();
  await refreshTotal();
  await renderThumbs();
  toast(t('toast.undone'));
});

$('btnSelectAll').addEventListener('click', () => {
  if (!state.bytes) return;
  for (let i = 1; i <= state.total; i++) state.selected.add(i);
  applySelectionToDom();
});
$('btnSelectNone').addEventListener('click', () => {
  state.selected.clear();
  applySelectionToDom();
});
$('btnSelectInvert').addEventListener('click', () => {
  const next = new Set();
  for (let i = 1; i <= state.total; i++) if (!state.selected.has(i)) next.add(i);
  state.selected = next;
  applySelectionToDom();
});

function applySelectionToDom() {
  document.querySelectorAll('.thumb').forEach((el) => {
    const p = Number(el.dataset.page);
    const on = state.selected.has(p);
    el.classList.toggle('selected', on);
    const chk = el.querySelector('.chk');
    if (chk) chk.checked = on;
  });
  syncToolbar();
}

$('btnDeleteSel').addEventListener('click', async () => {
  const pages = [...state.selected].sort((a, b) => a - b);
  if (!pages.length) return;
  if (pages.length === state.total) { toast(t('toast.cantDeleteAll'), true); return; }
  const spec = pages.join(',');
  await doOp(
    'delete',
    { pages: spec },
    'pdfrev delete "' + state.fileName + '" --pages ' + spec + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'delete', pages: spec }] },
    t('toast.deletedN', { n: pages.length })
  );
});

$('btnRotateLeft').addEventListener('click', () => rotate(-90));
$('btnRotateRight').addEventListener('click', () => rotate(90));

async function rotate(angle) {
  const pages = [...state.selected].sort((a, b) => a - b);
  if (!pages.length) { toast(t('toast.pickRotate'), true); return; }
  const spec = pages.join(',');
  const deg = ((angle % 360) + 360) % 360;
  await doOp(
    'rotate',
    { pages: spec, angle: deg },
    'pdfrev rotate "' + state.fileName + '" --pages ' + spec + ' --angle ' + deg + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'rotate', pages: spec, angle: deg }] },
    t('toast.rotatedN', { n: pages.length })
  );
}

$('btnExprDelete').addEventListener('click', async () => {
  const spec = $('exprPages').value.trim();
  if (!spec) { toast(t('toast.needExpr'), true); return; }
  await doOp(
    'delete',
    { pages: spec },
    'pdfrev delete "' + state.fileName + '" --pages ' + spec + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'delete', pages: spec }] },
    t('toast.deletedPages', { spec: spec })
  );
});

$('btnExprExtract').addEventListener('click', async () => {
  const spec = $('exprPages').value.trim();
  if (!spec) { toast(t('toast.needExpr'), true); return; }
  const res = await bridge.op('extract', state.bytes, { pages: spec });
  if (fail(res)) return;
  const save = await bridge.saveAs(new Uint8Array(res.data), (state.fileName || 'x.pdf').replace(/\.pdf$/i, '') + '-extract.pdf');
  if (fail(save)) return;
  if (save.canceled) return;
  setCmd(
    'pdfrev extract "' + state.fileName + '" --pages ' + spec + ' -o "' + save.path + '"',
    { input: state.filePath, output: save.path, steps: [{ op: 'extract', pages: spec }] }
  );
  toast(t('toast.extracted', { path: save.path }));
  bridge.showItem(save.path);
});

$('btnApplyOrder').addEventListener('click', async () => {
  const v = $('orderInput').value.trim();
  if (!v) { toast(t('toast.needOrder'), true); return; }
  await applyOrder(v.split(/[,，\s]+/).filter(Boolean), t('card.order.applied'));
});

$('btnReverse').addEventListener('click', async () => {
  const order = [];
  for (let i = state.total; i >= 1; i--) order.push(i);
  await applyOrder(order, t('card.order.reversed'));
});

$('btnPickInsert').addEventListener('click', async () => {
  const res = await bridge.openPdf();
  if (fail(res)) return;
  if (res.canceled) return;
  const f = res.files[0];
  state.insertBytes = new Uint8Array(f.data);
  state.insertName = f.name;
  $('insertFile').textContent = t('card.ins.picked', { name: f.name, size: fmtSize(f.size) });
  syncToolbar();
});

$('insertAt').addEventListener('change', () => {
  const custom = $('insertAt').value === 'custom';
  $('insertAtCustom').style.display = custom ? '' : 'none';
  if (custom) $('insertAtCustom').focus();
});

$('btnInsert').addEventListener('click', async () => {
  if (!state.insertBytes) { toast(t('toast.pickInsert'), true); return; }
  const at = $('insertAt').value === 'custom' ? $('insertAtCustom').value.trim() : $('insertAt').value;
  if (!at) { toast(t('toast.needPosition'), true); return; }
  const pages = $('insertPages').value.trim();
  pushHistory();
  const res = await bridge.op('insert', state.bytes, {
    data: state.insertBytes, at, insertPages: pages || undefined,
  });
  if (fail(res)) { state.history.pop(); return; }
  state.bytes = new Uint8Array(res.data);
  const info = await bridge.info(state.bytes);
  if (info.ok) state.total = info.info.pages;
  const cmd = 'pdfrev insert "' + state.fileName + '" --pdf "' + state.insertName + '" --at ' + at +
    (pages ? ' --pages ' + pages : '') + ' -o output.pdf';
  const steps = [{ op: 'insert', pdf: state.insertName, at: at }];
  if (pages) steps[0].insertPages = pages;
  setCmd(cmd, { input: state.filePath, output: 'output.pdf', steps });
  toast(t('toast.inserted', { name: state.insertName }));
  await renderThumbs();
});

$('btnCopyCli').addEventListener('click', async () => {
  if (!state.lastCmd) { toast(t('toast.noCmd'), true); return; }
  await bridge.copyText(state.lastCmd);
  toast(t('toast.copiedCmd'));
});

$('btnCopyCliJson').addEventListener('click', async () => {
  if (!state.lastJson) { toast(t('toast.noJson'), true); return; }
  await bridge.copyText(JSON.stringify(state.lastJson, null, 2));
  toast(t('toast.jsonCopied'));
});

/* ---------------- 命令行帮助面板（渲染逻辑，手写） ----------------
   注意：上面的常量块由 tools/cli-help.js 生成，别把这段的注释写成和它一样，
   否则工具会把自己的生成标记和这里认成同一处、覆盖掉这些函数（踩过）。 */

/**
 * 帮助面板的渲染标记：记录上一次是用哪种语言渲染的。
 * 不能只用一个 bool —— 切语言后内容必须重画；用语言 id 做标记，
 * 语言没变时仍然只渲染一次。
 */
let cliHelpLang = null;

/** 生成帮助面板内容：命令表 + 通用参数 + 语法速查 + 示例 + spec.json 样例 */
function renderCliHelp() {
  const lang = i18nGetLang();
  if (cliHelpLang === lang) return;
  const body = $('chBody');
  if (!body) return;

  const help = CLI_HELP_OF();

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  /** 一行「左说明、右代码」的可复制条目 */
  const copyRow = (label, code) => {
    const row = el('div', 'ch-row');
    row.appendChild(el('span', 'ch-desc', label));
    const c = el('code', 'ch-cmd', code);
    c.title = t('ch.clickCopy');
    c.addEventListener('click', async () => {
      await bridge.copyText(code);
      toast(t('toast.copied', { code: code }));
    });
    row.appendChild(c);
    return row;
  };

  body.textContent = '';

  /* 1. 命令 */
  body.appendChild(el('h4', null, t('cli.cmd')));
  for (const c of help.cmds) {
    const item = el('div', 'ch-item');
    const line = el('div', 'ch-line');
    const cmd = el('code', 'ch-cmd', c.u);
    cmd.title = t('ch.clickCopy');
    cmd.addEventListener('click', async () => { await bridge.copyText(c.u); toast(t('toast.cmdCopied')); });
    line.appendChild(cmd);
    item.appendChild(line);
    item.appendChild(el('div', 'ch-note', c.d));
    body.appendChild(item);
  }

  /* 2. 通用参数 */
  body.appendChild(el('h4', null, t('cli.flag')));
  const flags = el('dl', 'ch-dl');
  for (const f of help.flags) {
    flags.appendChild(el('dt', null, f.f));
    flags.appendChild(el('dd', null, f.d));
  }
  body.appendChild(flags);

  /* 3. 语法速查 */
  body.appendChild(el('h4', null, t('cli.syntax')));
  const syn = el('dl', 'ch-dl');
  for (const s of help.syntax) {
    syn.appendChild(el('dt', null, s.k));
    syn.appendChild(el('dd', null, s.v));
  }
  body.appendChild(syn);

  /* 4. 示例（点击整行复制） */
  body.appendChild(el('h4', null, t('cli.example')));
  for (const e of help.examples) body.appendChild(copyRow(e.d, e.c));

  /* 5. 批量 spec.json */
  body.appendChild(el('h4', null, t('cli.spec')));
  body.appendChild(el('div', 'ch-note', t('ch.specNote')));
  const pre = el('pre', 'ch-pre', CLI_SPEC);
  pre.title = t('ch.clickCopy');
  pre.addEventListener('click', async () => { await bridge.copyText(CLI_SPEC); toast(t('toast.copiedSpec')); });
  body.appendChild(pre);

  cliHelpLang = lang;
}

function openCliHelp() {
  renderCliHelp();
  $('cliHelp').classList.remove('hidden');
  const btn = $('chClose');
  if (btn) btn.focus();
}

function closeCliHelp() {
  $('cliHelp').classList.add('hidden');
  return true;
}

function cliHelpHidden() {
  const el = $('cliHelp');
  return !el || el.classList.contains('hidden');
}

if ($('btnCliHelp')) $('btnCliHelp').addEventListener('click', openCliHelp);
if ($('chClose')) $('chClose').addEventListener('click', closeCliHelp);
if ($('cliHelp')) {
  $('cliHelp').addEventListener('click', (e) => {
    if (e.target === $('cliHelp')) closeCliHelp();
  });
}

document.addEventListener('keydown', (e) => {
  // 命令行帮助打开时只响应它（Esc 关闭）。放在最前面，
  // 否则 Esc 会先被预览分支吃掉、帮助面板留在屏幕上。
  if (!cliHelpHidden()) {
    if (e.key === 'Escape') { e.preventDefault(); closeCliHelp(); }
    return;
  }

  // 确认框打开时只响应它
  if (!$('confirm').classList.contains('hidden')) {
    if (e.key === 'Enter') { e.preventDefault(); settleConfirm(true); }
    if (e.key === 'Escape') { e.preventDefault(); settleConfirm(false); }
    return;
  }

  // 预览打开时优先处理预览快捷键
  if (pv.open) {
    // 缩放快捷键：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 适应 / Ctrl+1 实际大小
    if (e.ctrlKey || e.metaKey) {
      const kz = e.key;
      if (kz === '=' || kz === '+') { e.preventDefault(); zoomStep(ZOOM_STEP); return; }
      if (kz === '-' || kz === '_') { e.preventDefault(); zoomStep(1 / ZOOM_STEP); return; }
      if (kz === '0') { e.preventDefault(); zoomFit(); return; }
      if (kz === '1') { e.preventDefault(); zoomActual(); return; }
    }
    // 直接调用函数而不是 click()：按钮在只剩一页时是 disabled，click() 不会触发、也就不会有提示
    if (e.key === 'Delete') { e.preventDefault(); deletePreviewedPage(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closePreview(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); $('pvPrev').click(); return; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); $('pvNext').click(); return; }
    return;
  }

  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('btnUndo').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('btnOpen').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('btnSave').click(); }
  // 有选中页时 Delete 删除选中页，否则提示
  if (e.key === 'Delete') {
    e.preventDefault();
    if (state.selected.size) $('btnDeleteSel').click();
    else toast(t('toast.pickDeleteHint'), true);
  }
});

/* ---------------- 页面预览（双击缩略图打开） ---------------- */

const pv = {
  open: false,
  page: 1,
  doc: null,
  token: 0,
  // 缩放：fitScale = 适应窗口的倍数；zoom 为 1 表示“适应”，>1 放大，<1 缩小
  zoom: 1,
  fitScale: 1,
  pageW: 0,
  pageH: 0,
};

const ZOOM_MIN = 0.1;   // 相对“适应窗口”的最小倍数
const ZOOM_MAX = 8;     // 最大倍数
const ZOOM_STEP = 1.15; // 每格滚轮的缩放比例

async function openPreview(page) {
  if (!state.bytes) return;
  pv.open = true;
  pv.zoom = 1;            // 每次打开都回到“适应窗口”
  $('preview').classList.remove('hidden');
  await showPreviewPage(page);
}

function closePreview() {
  pv.open = false;
  pv.token++;
  pv.zoom = 1;
  pv.fitScale = 1;
  $('preview').classList.add('hidden');
  $('pvCanvas').width = 0;
  $('pvCanvas').height = 0;
  if (pv.doc) { safeDestroy(pv.doc); pv.doc = null; }
  // 焦点交还给主界面，Delete 恢复为“删除选中页”
  $('btnSave').focus();
}

/** 渲染预览区第 page 页（1 基） */
async function showPreviewPage(page) {
  // 先领取本次渲染的编号：之后任何 await 期间若又有新的翻页/删除，
  // 本次渲染就会被判定为过期而丢弃，避免旧画面覆盖新页面。
  const token = ++pv.token;

  if (!pv.doc) {
    const doc = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;
    if (token !== pv.token) { safeDestroy(doc); return; }
    pv.doc = doc;
  }
  const total = pv.doc.numPages;
  if (page < 1) page = 1;
  if (page > total) page = total;
  pv.page = page;

  pvTitle.textContent = t('pv.pageOf', { p: page, t: total });
  $('pvPrev').disabled = page <= 1;
  $('pvNext').disabled = page >= total;
  $('pvDelete').disabled = total <= 1;
  $('pvLoading').classList.remove('hidden');

  try {
    const docPage = await pv.doc.getPage(page);
    if (token !== pv.token) return;
    const base = docPage.getViewport({ scale: 1 });
    pv.pageW = base.width;
    pv.pageH = base.height;
    // 适应窗口的倍数（放大上限 3 倍，避免小页面被拉得很糊）
    const stage = $('pvStage');
    const availW = Math.max(stage.clientWidth - 48, 320);
    const availH = Math.max(stage.clientHeight - 48, 320);
    pv.fitScale = Math.min(availW / base.width, availH / base.height, 3);
    await renderPreviewCanvas(docPage, token);
  } catch (err) {
    if (token === pv.token) toast(t('toast.renderPageFail', { msg: (err && err.message ? err.message : err) }), true);
  } finally {
    if (token === pv.token) $('pvLoading').classList.add('hidden');
  }
}

/** 按 pv.zoom 把当前页画到预览画布上 */
async function renderPreviewCanvas(docPage, token) {
  const scale = pv.fitScale * pv.zoom;
  const vp = docPage.getViewport({ scale });
  const canvas = $('pvCanvas');
  const ctx = canvas.getContext('2d');

  // 先备份旧画面，尺寸变化时用它做过渡，避免缩放瞬间闪烁空白
  let backup = null;
  if (canvas.width > 0 && canvas.height > 0) {
    backup = document.createElement('canvas');
    backup.width = canvas.width;
    backup.height = canvas.height;
    backup.getContext('2d').drawImage(canvas, 0, 0);
  }

  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  applyCanvasLayout();

  // 记住缩放前的滚动中心，缩小时尽量保持在原位置
  const stage = $('pvStage');
  const cx = stage.scrollLeft + stage.clientWidth / 2;
  const cy = stage.scrollTop + stage.clientHeight / 2;
  const oldW = backup ? backup.width : 0;

  // 尽量把超采样上限压住，避免放大到极大时内存爆掉
  const maxPixels = 40e6;
  let renderScale = scale;
  if (canvas.width * canvas.height > maxPixels) {
    const k = Math.sqrt(maxPixels / (canvas.width * canvas.height));
    renderScale = scale * k;
  }
  const rvp = renderScale === scale ? vp : docPage.getViewport({ scale: renderScale });

  try {
    await docPage.render({ canvasContext: ctx, viewport: rvp }).promise;
  } catch (err) {
    if (token !== pv.token) return;
    toast(t('toast.renderFail', { msg: (err && err.message ? err.message : err) }), true);
    return;
  }
  if (token !== pv.token) return;

  // 用备份做一次平滑过渡（缩放过程中旧画面短暂拉伸）
  if (backup && oldW > 0 && renderScale !== scale) {
    const b = document.createElement('canvas');
    b.width = canvas.width;
    b.height = canvas.height;
    const bctx = b.getContext('2d');
    bctx.imageSmoothingQuality = 'low';
    bctx.drawImage(backup, 0, 0, backup.width, backup.height, 0, 0, b.width, b.height);
    bctx.drawImage(canvas, 0, 0);
    ctx.drawImage(b, 0, 0);
  }

  // 恢复滚动中心（按尺寸比例换算）
  if (oldW > 0) {
    const ratio = canvas.width / oldW;
    stage.scrollLeft = cx * ratio - stage.clientWidth / 2;
    stage.scrollTop = cy * ratio - stage.clientHeight / 2;
  }
  updateZoomLabel();
}

/** 画布的显示尺寸：等倍时居中填充，放大时按滚动查看 */
function applyCanvasLayout() {
  const canvas = $('pvCanvas');
  const stage = $('pvStage');
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  const fits = canvas.width <= stageW && canvas.height <= stageH;
  canvas.style.width = Math.round(canvas.width) + 'px';
  canvas.style.height = Math.round(canvas.height) + 'px';
  stage.classList.toggle('zoomed', !fits);
  if (fits) {
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
  } else {
    canvas.style.maxWidth = 'none';
    canvas.style.maxHeight = 'none';
  }
}

function updateZoomLabel() {
  $('pvZoomVal').textContent = Math.round(pv.zoom * 100) + '%';
}

/** 以某个屏幕坐标为中心缩放（滚轮缩放时保持光标下的内容不动） */
async function zoomAt(factor, clientX, clientY) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pv.zoom * factor));
  if (Math.abs(next - pv.zoom) < 1e-6) return;
  const stage = $('pvStage');
  const canvas = $('pvCanvas');
  const rect = canvas.getBoundingClientRect();

  // 光标在画布内容中的相对位置（0~1）
  let fx = 0.5;
  let fy = 0.5;
  if (clientX !== undefined && rect.width > 0 && rect.height > 0) {
    fx = (clientX - rect.left) / rect.width;
    fy = (clientY - rect.top) / rect.height;
    if (!isFinite(fx) || fx < 0 || fx > 1) fx = 0.5;
    if (!isFinite(fy) || fy < 0 || fy > 1) fy = 0.5;
  }
  const beforeScrollX = stage.scrollLeft;
  const beforeScrollY = stage.scrollTop;

  pv.zoom = next;
  const docPage = await pv.doc.getPage(pv.page);
  await renderPreviewCanvas(docPage, pv.token);

  // 让光标下的那一点保持不动
  const newW = canvas.width;
  const newH = canvas.height;
  const oldW = rect.width;
  const oldH = rect.height;
  if (oldW > 0 && oldH > 0) {
    const contentX = beforeScrollX + (clientX !== undefined ? clientX - rect.left : oldW / 2);
    const contentY = beforeScrollY + (clientY !== undefined ? clientY - rect.top : oldH / 2);
    stage.scrollLeft = contentX * (newW / oldW) - (clientX !== undefined ? clientX - stage.getBoundingClientRect().left : stage.clientWidth / 2);
    stage.scrollTop = contentY * (newH / oldH) - (clientY !== undefined ? clientY - stage.getBoundingClientRect().top : stage.clientHeight / 2);
  }
}

/** 设为“适应窗口”（zoom = 1） */
async function zoomFit() {
  pv.zoom = 1;
  if (!pv.doc) return;
  const docPage = await pv.doc.getPage(pv.page);
  await renderPreviewCanvas(docPage, pv.token);
}

/** 设为实际大小（按 100% 真实比例） */
async function zoomActual() {
  if (!pv.fitScale) return;
  pv.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, 1 / pv.fitScale));
  const docPage = await pv.doc.getPage(pv.page);
  await renderPreviewCanvas(docPage, pv.token);
}

/** 删除预览中的当前页；删完自动显示后一页（或前一页），没有页了则关闭 */
async function deletePreviewedPage() {
  const total = state.total;
  if (total <= 1) { toast(t('toast.lastPage'), true); return; }
  const page = pv.page;
  const wasLast = page >= total;
  // 让在途的渲染作废，并记住本次删除的编号
  const gen = ++pv.token;

  await doOp(
    'delete',
    { pages: String(page) },
    'pdfrev delete "' + state.fileName + '" --pages ' + page + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'delete', pages: String(page) }] },
    t('toast.deletedPage', { p: page })
  );

  // 删除期间用户若翻页/关闭了预览，本次后续处理作废
  if (gen !== pv.token || !pv.open) return;

  // 文档已重建，预览用的 pdfjs 实例必须作废
  if (pv.doc) { safeDestroy(pv.doc); pv.doc = null; }
  if (state.total <= 0) { closePreview(); return; }
  await showPreviewPage(wasLast ? state.total : page);
}

$('pvClose').addEventListener('click', closePreview);
$('pvPrev').addEventListener('click', () => showPreviewPage(pv.page - 1));
$('pvNext').addEventListener('click', () => showPreviewPage(pv.page + 1));
$('pvDelete').addEventListener('click', () => deletePreviewedPage());
$('pvZoomIn').addEventListener('click', () => zoomStep(ZOOM_STEP));
$('pvZoomOut').addEventListener('click', () => zoomStep(1 / ZOOM_STEP));
$('pvZoomFit').addEventListener('click', () => zoomFit());
$('pvZoom100').addEventListener('click', () => zoomActual());

/** 以舞台中心为锚点缩放 */
function zoomStep(factor) {
  const stage = $('pvStage');
  const r = stage.getBoundingClientRect();
  return zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
}

/* 滚轮缩放：直接滚 = 缩放；Ctrl+滚轮也可（触控板双指同样生效） */
$('pvStage').addEventListener('wheel', (e) => {
  if (!pv.open || !pv.doc) return;
  e.preventDefault();
  // 向下滚缩小，向上滚放大；触控板 deltaY 很小时也能平滑响应
  const factor = Math.pow(ZOOM_STEP, -e.deltaY / 100);
  zoomAt(factor, e.clientX, e.clientY);
}, { passive: false });

/* 放大后可按住拖动平移 */
let panning = null;
$('pvStage').addEventListener('mousedown', (e) => {
  if (!pv.open || e.button !== 0) return;
  const stage = $('pvStage');
  if (!stage.classList.contains('zoomed')) return;
  panning = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.classList.add('dragging');
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!panning) return;
  const stage = $('pvStage');
  stage.scrollLeft = panning.left - (e.clientX - panning.x);
  stage.scrollTop = panning.top - (e.clientY - panning.y);
});
window.addEventListener('mouseup', () => {
  if (!panning) return;
  panning = null;
  $('pvStage').classList.remove('dragging');
});

/* 双击关闭：只在空白处触发，避免缩放后误关 */
$('pvStage').addEventListener('dblclick', (e) => {
  if (e.target === $('pvCanvas')) return;
  closePreview();
});

/* 窗口尺寸变化时重算“适应窗口” */
window.addEventListener('resize', () => {
  if (!pv.open || !pv.doc || pv.zoom !== 1) return;
  const docPage = pv.doc.getPage(pv.page);
  docPage.then((dp) => {
    const stage = $('pvStage');
    const availW = Math.max(stage.clientWidth - 48, 320);
    const availH = Math.max(stage.clientHeight - 48, 320);
    pv.fitScale = Math.min(availW / pv.pageW, availH / pv.pageH, 3);
    renderPreviewCanvas(dp, pv.token);
  }).catch(() => { /* ignore */ });
});

/* ---------------- 通用确认框 ---------------- */

let confirmResolve = null;

function askConfirm(msg) {
  $('confirmMsg').textContent = msg;
  $('confirm').classList.remove('hidden');
  $('confirmOk').focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(v) {
  $('confirm').classList.add('hidden');
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(v);
}

$('confirmOk').addEventListener('click', () => settleConfirm(true));
$('confirmCancel').addEventListener('click', () => settleConfirm(false));
$('confirm').addEventListener('click', (e) => { if (e.target === $('confirm')) settleConfirm(false); });

/* ---------------- 拖拽文件到中心区域打开 ---------------- */

/** 只判断"拖的是文件"；缩略图内部排序拖动带 text/plain，不显示遮罩 */
function isFileDrag(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).indexOf('Files') >= 0) return true;
  return false;
}

let dragDepth = 0;
const dz = () => $('dropzone');

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  dz().classList.remove('hidden');
  $('thumbs').classList.add('drag-over');
});

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dz().classList.add('hidden');
    $('thumbs').classList.remove('drag-over');
  }
});

window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;   // 缩略图排序的 drop 由卡片自己处理
  e.preventDefault();
  dragDepth = 0;
  dz().classList.add('hidden');
  $('thumbs').classList.remove('drag-over');
  await handleDroppedFiles(e.dataTransfer.files);
});

async function handleDroppedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const pdf = files.find((f) => /.pdf$/i.test(f.name));
  if (!pdf) { toast(t('toast.pdfOnly'), true); return; }
  if (files.length > 1) toast(t('toast.oneFile', { name: pdf.name }));

  // 取拖入文件的真实磁盘路径（Electron 32 起 File.path 已废弃，走 webUtils）
  let diskPath = '';
  try {
    diskPath = bridge.getFilePath(pdf) || '';
  } catch (err) {
    diskPath = '';
  }
  // 兜底：老版本 Electron / 某些来源还带 path 属性
  if (!diskPath && pdf.path) diskPath = pdf.path;

  if (diskPath) {
    const res = await bridge.readFile(diskPath);
    if (fail(res)) return;
    return await loadBytes(new Uint8Array(res.file.data), res.file.path, res.file.name, 'disk');
  }

  // 拿不到路径：直接用内存里的内容打开，不弹保存框、不写盘。
  // 之后按“保存”时才让用户选位置。
  let bytes;
  try {
    bytes = new Uint8Array(await pdf.arrayBuffer());
  } catch (err) {
    toast(t('toast.readDragFail', { msg: (err && err.message ? err.message : err) }), true);
    return;
  }
  if (!bytes.length) { toast(t('toast.emptyDrag'), true); return; }
  toast(t('toast.dragOpened'));
  return await loadBytes(bytes, null, pdf.name, 'drag');
}

/* ---------------- 工具与自检钩子 ---------------- */

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

window.__errs = window.__errs || [];
window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
// 未捕获的 Promise 拒绝：reason 可能是对象，直接 String() 只会得到 [object Object]
window.addEventListener('unhandledrejection', (e) => window.__errs.push(describeErr(e.reason)));
function describeErr(r) {
  if (r == null) return String(r);
  if (typeof r === 'string') return r;
  if (r instanceof Error) return r.name + ': ' + r.message;
  try { return JSON.stringify(r); } catch (err) { return Object.prototype.toString.call(r); }
}
window.__currentBytes = () => state.bytes;
window.__state = state;
window.__pv = pv;

syncToolbar();
/* ---------------- 版权页（MIT 许可） ----------------
   COPYRIGHT_FULL 必须与项目根目录的 LICENSE 文件逐字一致，
   由 tools/check-license.py 校验（构建前会自动跑）。
   原版用的是 tools/sync-copyright.js 从多份界面同步；本版只有一处界面，
   所以改为「LICENSE 为准 + 脚本校验」，不再生成。 */

/**
 * 版权页文案改为从 i18n 词典取（键 cr.title / cr.holder / cr.c1k…cr.c4t），
 * 这样切语言时整页跟着变。条款标题与正文分开，连接符也随语言变（cr.sep）。
 */
function copyrightClauses() {
  const sep = t('cr.sep');
  return [1, 2, 3, 4].map((i) => ({ k: t('cr.c' + i + 'k'), t: t('cr.c' + i + 't'), sep: sep }));
}

/** MIT 许可全文（与项目根目录的 LICENSE 文件逐字一致） */
const COPYRIGHT_FULL = [
  'MIT License',
  '',
  'Copyright (c) 2026 He Xianfeng (何险峰) <xfhe@ipe.ac.cn>',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
].join('\n');
/**
 * 把版权条款填进 #copyright 的列表。
 *
 * 每次都重建（不再用 dataset.filled 缓存）：切语言时要整体换成另一种语言的条款。
 * COPYRIGHT_FULL 是 MIT 原文，各语言共用同一份 —— 许可证原文不翻译，
 * 且必须与根目录 LICENSE 逐字一致（tools/check-license.py 校验）。
 */
function renderCopyright() {
  const el = $('copyright');
  if (!el) return;

  // 版本号与项目主页：版本从 Rust 侧取（Cargo.toml 是唯一来源，
  // 界面不再手写一份，否则发版时容易和 exe 属性对不上）。
  if (!renderCopyright.metaLoaded) {
    renderCopyright.metaLoaded = true;
    loadCopyrightMeta();
  }
  const list = el.querySelector('.cr-list');
  if (list) {
    list.textContent = '';
    for (const c of copyrightClauses()) {
      const li = document.createElement('li');
      const b = document.createElement('b');
      // <ol> 已经自带 1./2./3./4. 编号，这里只渲染标题，避免出现「1. 1. 个人非商业使用」
      b.textContent = c.k + c.sep;
      li.appendChild(b);
      li.appendChild(document.createTextNode(c.t));
      list.appendChild(li);
    }
  }

  const full = el.querySelector('#crFull');
  if (full) full.textContent = COPYRIGHT_FULL;
}
/**
 * 填版权页的版本号与项目主页。
 *
 * 只跑一次：两个值都是常量，切语言不需要重新取。
 * 链接点击走 open_url（默认浏览器打开），而不是让 webview 自己跳 ——
 * 跳走之后界面就没了，用户得重新打开程序。
 */
async function loadCopyrightMeta() {
  try {
    const v = await bridge.appVersion();
    if (v && $('crVersion')) $('crVersion').textContent = v;
  } catch (e) { /* 取不到就保持占位「—」 */ }
  try {
    const u = await bridge.appRepoUrl();
    const a = $('crRepo');
    if (u && a) {
      a.textContent = t('cr.repoLabel', { host: u.replace(/^https?:\/\//, '') });
      a.href = u;
    }
  } catch (e) { /* 同上 */ }
}
/** 显示版权页（首次启动、点「版权」按钮都用它） */
function openCopyright() {
  renderCopyright();
  $('copyright').classList.remove('hidden');
  const btn = $('crClose');
  if (btn) btn.focus();
}

function closeCopyright() {
  $('copyright').classList.add('hidden');
  copyrightMarkSeen();
  return true;
}

const COPYRIGHT_SEEN_KEY = 'pdfrev.copyright.seen.v1';

/** 记录「已看过」，之后不再自动弹 */
function copyrightMarkSeen() {
  try { localStorage.setItem(COPYRIGHT_SEEN_KEY, '1'); } catch (e) { /* 隐私模式下写不了 */ }
}

function copyrightHidden() {
  const el = $('copyright');
  return !el || el.classList.contains('hidden');
}

/** 是否已在本次安装里看过（看过就不再自动弹） */
function copyrightSeen() {
  try { return localStorage.getItem(COPYRIGHT_SEEN_KEY) === '1'; } catch (e) { return false; }
}

/** 首次启动自动展示一次；已看过则不打扰 */
function maybeShowCopyrightFirstRun() {
  if (copyrightSeen()) return false;
  setTimeout(() => {
    // 再查一次 copyrightSeen：用户可能在 600ms 内就点了「关闭」，
    // 只判断「没打开文档」的话会把已经关掉的版权页又弹回来。
    if (!copyrightSeen() && !pv.open && !state.bytes) openCopyright();
  }, 600);
  return true;
}

/* 版权页里的项目主页链接：交给系统浏览器打开。
   webview 自己跳转会丢掉界面（而且 CSP 也只允许 self），所以拦下默认行为。 */
if ($('crRepo')) {
  $('crRepo').addEventListener('click', async (e) => {
    e.preventDefault();
    const url = $('crRepo').href;
    const res = await bridge.openUrl(url);
    if (res && res.ok === false) toast(tErr(res), true);
  });
}

/* 工具栏「版权」按钮 + 点遮罩关闭 + 首次启动自动展示 */
if ($('btnCopyright')) $('btnCopyright').addEventListener('click', openCopyright);
if ($('crClose')) $('crClose').addEventListener('click', closeCopyright);
if ($('copyright')) {
  $('copyright').addEventListener('click', (e) => {
    if (e.target === $('copyright')) closeCopyright();
  });
}
maybeShowCopyrightFirstRun();

/* 版权页显示期间吞掉全局快捷键（Esc 关闭）。
   挂在 window 捕获阶段：window 是 document 的祖先，捕获阶段先于
   app.js 里那个 document keydown 处理器执行，stopPropagation 之后
   它就不再被触发（否则 Esc/Delete 会作用到背后的页面）。 */
window.addEventListener('keydown', (e) => {
  if (copyrightHidden()) return;
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); closeCopyright(); }
}, true);

/* 暴露给测试脚本（test/copyright.js / pdfrev_web/test/ui.js） */
if (typeof window !== 'undefined') {
  window.__copyright = {
    open: openCopyright, close: closeCopyright, seen: copyrightSeen,
    hidden: copyrightHidden, firstRun: maybeShowCopyrightFirstRun,
    key: COPYRIGHT_SEEN_KEY,
    title: () => t('cr.title'), holder: () => t('cr.holder'),
    clauses: copyrightClauses,
    version: () => ($('crVersion') || {}).textContent || '',
    repo: () => ($('crRepo') || {}).href || '',
    meta: loadCopyrightMeta,
  };
}



/* ---------------- 语言选择 ---------------- */

/**
 * 语言下拉框。
 *
 * 选项用各语言自己的名字写（「简体中文」/「English」），不跟着界面语言变 ——
 * 用户看不懂当前语言时，至少还能认出自己要选的那一行。
 */
(function initLangSelect() {
  const sel = $('langSelect');
  if (!sel) return;
  sel.innerHTML = i18nOptionsHtml();
  sel.value = i18nGetLang();
  sel.addEventListener('change', () => {
    setLang(sel.value);
    sel.value = i18nGetLang();
  });
})();

/**
 * 语言切换后重画「动态生成」的部分。
 *
 * 静态标记（按钮、标签、占位符）已由 i18n.js 的 applyI18n() 处理；
 * 这里的都是 JS 拼出来的：顶栏文件信息、缩略图角标、插入位置下拉、
 * 命令行帮助面板、版权页条款，以及已打开的预览标题。
 */
window.addEventListener('pdfrev:langchange', () => {
  // 缩略图角标与复选框提示：直接重画一次（不重新解码 PDF，改的是文本节点）
  document.querySelectorAll('.thumb').forEach((card) => {
    const i = Number(card.dataset.page);
    const chk = card.querySelector('.chk');
    if (chk) chk.title = t('thumb.pick', { i: i });
    const ph = card.querySelector('.canvas-wrap .ph');
    if (ph) ph.textContent = t('thumb.page', { i: i });
    const idx = card.querySelector('.meta .idx');
    if (idx) idx.textContent = t('thumb.origPage', { i: i });
  });

  rebuildInsertAt();
  renderCopyright();

  // 帮助面板：语言变了要重画（cliHelpLang 标记失配，renderCliHelp 会重建）
  if ($('cliHelp') && !$('cliHelp').classList.contains('hidden')) renderCliHelp();

  // 预览标题
  if (pv.open && pv.doc) $('pvTitle').textContent = t('pv.pageOf', { p: pv.page, t: pv.doc.numPages });

  // 顶栏文件信息 + 页数 / 已选 / 保存按钮提示
  syncToolbar();

  // 插入文件那一行（有选文件时）
  if (state.insertName) {
    $('insertFile').textContent = t('card.ins.picked', { name: state.insertName, size: fmtSize(state.insertBytes.length) });
  }
});

/* ==== CLI-HELP-BLOCK: 由 tools/cli-help.js 生成，勿手改 ==== */

const CLI_NAME = "pdfrev";
const CLI_SPEC = "{\n  \"input\": \"in.pdf\",\n  \"output\": \"out.pdf\",\n  \"steps\": [\n    { \"op\": \"delete\",  \"pages\": \"2,5\" },\n    { \"op\": \"rotate\",  \"pages\": \"1\", \"angle\": 90 },\n    { \"op\": \"reorder\", \"order\": \"3,1,2\" }\n  ]\n}";

/** 帮助内容按语言分组；渲染时按当前语言取一份（CLI_HELP_OF） */
const CLI_HELP_BY_LANG = {
  zh: {
    "cmds": [
      {
        "n": "info",
        "u": "pdfrev info <文件>",
        "d": "只读：打印页数（以及有的话，标题）。不改写文件。"
      },
      {
        "n": "reorder",
        "u": "pdfrev reorder <文件> --order 3,1,2 [-o 输出.pdf]",
        "d": "按给定顺序重排页面。未列出的页自动按原顺序追加到末尾。"
      },
      {
        "n": "delete",
        "u": "pdfrev delete <文件> --pages 2,5,7-9 [-o 输出.pdf]",
        "d": "删除指定页。别名 remove。"
      },
      {
        "n": "extract",
        "u": "pdfrev extract <文件> --pages 1-3 [-o 输出.pdf]",
        "d": "只保留指定页，导出为新 PDF。"
      },
      {
        "n": "rotate",
        "u": "pdfrev rotate <文件> [--pages 2] [--angle 90] [-o 输出.pdf]",
        "d": "旋转页面，角度为 90 的整数倍；--pages 省略时表示 all。"
      },
      {
        "n": "insert",
        "u": "pdfrev insert <文件> --pdf 插页.pdf --at head|tail|before:3|after:4 [--pages 1-2] [-o 输出.pdf]",
        "d": "把另一个 PDF 插进来。--pages 指定插入源里的哪些页，留空表示全部。"
      },
      {
        "n": "run",
        "u": "pdfrev run <spec.json|-> [-o 输出.pdf]",
        "d": "批量：从 JSON 读多步操作依次执行。文件名写 - 表示从标准输入读。"
      }
    ],
    "flags": [
      {
        "f": "-o, --output <路径>",
        "d": "输出文件。省略时在原文件旁写 <原名>-out.pdf。"
      },
      {
        "f": "--json",
        "d": "输出机器可读的 JSON（成功 {ok:true,...}，失败 {ok:false,error}）。"
      },
      {
        "f": "--dry-run",
        "d": "只算不写：不产生输出文件，用于预览结果。"
      },
      {
        "f": "-h, --help",
        "d": "打印用法。不带任何参数运行也等同于帮助。"
      },
      {
        "f": "-V, --version",
        "d": "PDFRev.exe 打印版本号并退出（图形界面本体不接收其它参数）。"
      }
    ],
    "syntax": [
      {
        "k": "页码",
        "v": "2  ·  3,5,8  ·  3-5  ·  5-end  ·  all"
      },
      {
        "k": "位置",
        "v": "head=首页  ·  tail=尾页  ·  before:3=第 3 页前  ·  after:4=第 4 页后"
      },
      {
        "k": "顺序",
        "v": "--order 3,1,2（未列出的页自动追加到末尾）"
      },
      {
        "k": "退出码",
        "v": "0 成功，1 失败（错误信息走 stderr；配 --json 时为 stdout 的 JSON）"
      }
    ],
    "examples": [
      {
        "d": "看页数（只读，不动文件）",
        "c": "pdfrev info in.pdf"
      },
      {
        "d": "删掉第 2、5 页和第 7~9 页",
        "c": "pdfrev delete in.pdf --pages 2,5,7-9 -o out.pdf"
      },
      {
        "d": "只留下前 3 页，另存为新文件",
        "c": "pdfrev extract in.pdf --pages 1-3 -o cover.pdf"
      },
      {
        "d": "把第 3 页提到最前面",
        "c": "pdfrev reorder in.pdf --order 3,1,2 -o out.pdf"
      },
      {
        "d": "第 2 页顺时针转 90 度",
        "c": "pdfrev rotate in.pdf --pages 2 --angle 90 -o out.pdf"
      },
      {
        "d": "整个文档转正 180 度",
        "c": "pdfrev rotate in.pdf --angle 180 -o out.pdf"
      },
      {
        "d": "把插页.pdf 的第 1 页插到第 3 页之前",
        "c": "pdfrev insert in.pdf --pdf 插页.pdf --at before:3 --pages 1 -o out.pdf"
      },
      {
        "d": "只算不写，先看结果",
        "c": "pdfrev delete in.pdf --pages 2 --dry-run --json"
      },
      {
        "d": "批量：一趟做完删页 + 重排",
        "c": "pdfrev run spec.json -o out.pdf"
      }
    ]
  },
  en: {
    "cmds": [
      {
        "n": "info",
        "u": "pdfrev info <file>",
        "d": "Read-only: print the page count (and the title, if present). Does not modify the file."
      },
      {
        "n": "reorder",
        "u": "pdfrev reorder <file> --order 3,1,2 [-o out.pdf]",
        "d": "Reorder pages as given. Pages not listed are appended at the end in their original order."
      },
      {
        "n": "delete",
        "u": "pdfrev delete <file> --pages 2,5,7-9 [-o out.pdf]",
        "d": "Delete the given pages. Alias: remove."
      },
      {
        "n": "extract",
        "u": "pdfrev extract <file> --pages 1-3 [-o out.pdf]",
        "d": "Keep only the given pages and export them as a new PDF."
      },
      {
        "n": "rotate",
        "u": "pdfrev rotate <file> [--pages 2] [--angle 90] [-o out.pdf]",
        "d": "Rotate pages; the angle must be a multiple of 90. Omitting --pages means all."
      },
      {
        "n": "insert",
        "u": "pdfrev insert <file> --pdf insert.pdf --at head|tail|before:3|after:4 [--pages 1-2] [-o out.pdf]",
        "d": "Insert another PDF. --pages selects which pages of the source to insert; empty means all."
      },
      {
        "n": "run",
        "u": "pdfrev run <spec.json|-> [-o out.pdf]",
        "d": "Batch: read several steps from JSON and run them in order. Use - as the file name to read stdin."
      }
    ],
    "flags": [
      {
        "f": "-o, --output <path>",
        "d": "Output file. If omitted, writes <name>-out.pdf next to the original."
      },
      {
        "f": "--json",
        "d": "Emit machine-readable JSON (success {ok:true,...}, failure {ok:false,error})."
      },
      {
        "f": "--dry-run",
        "d": "Compute only, write nothing: use it to preview the result."
      },
      {
        "f": "-h, --help",
        "d": "Print usage. Running with no arguments is equivalent to help."
      },
      {
        "f": "-V, --version",
        "d": "PDFRev.exe prints its version and exits (the GUI takes no other arguments)."
      }
    ],
    "syntax": [
      {
        "k": "Pages",
        "v": "2  ·  3,5,8  ·  3-5  ·  5-end  ·  all"
      },
      {
        "k": "Position",
        "v": "head=very front  ·  tail=very end  ·  before:3=before page 3  ·  after:4=after page 4"
      },
      {
        "k": "Order",
        "v": "--order 3,1,2 (unlisted pages are appended at the end)"
      },
      {
        "k": "Exit code",
        "v": "0 success, 1 failure (errors go to stderr; with --json they go to stdout as JSON)"
      }
    ],
    "examples": [
      {
        "d": "Show the page count (read-only, does not touch the file)",
        "c": "pdfrev info in.pdf"
      },
      {
        "d": "Delete pages 2, 5 and 7-9",
        "c": "pdfrev delete in.pdf --pages 2,5,7-9 -o out.pdf"
      },
      {
        "d": "Keep only the first 3 pages, save as a new file",
        "c": "pdfrev extract in.pdf --pages 1-3 -o cover.pdf"
      },
      {
        "d": "Move page 3 to the very front",
        "c": "pdfrev reorder in.pdf --order 3,1,2 -o out.pdf"
      },
      {
        "d": "Rotate page 2 by 90 degrees clockwise",
        "c": "pdfrev rotate in.pdf --pages 2 --angle 90 -o out.pdf"
      },
      {
        "d": "Rotate the whole document upright by 180 degrees",
        "c": "pdfrev rotate in.pdf --angle 180 -o out.pdf"
      },
      {
        "d": "Insert page 1 of insert.pdf before page 3",
        "c": "pdfrev insert in.pdf --pdf insert.pdf --at before:3 --pages 1 -o out.pdf"
      },
      {
        "d": "Compute only, preview the result first",
        "c": "pdfrev delete in.pdf --pages 2 --dry-run --json"
      },
      {
        "d": "Batch: delete + reorder in one pass",
        "c": "pdfrev run spec.json -o out.pdf"
      }
    ]
  },
};

/** 取当前语言的帮助内容；没有该语言就回落中文 */
function CLI_HELP_OF() {
  return CLI_HELP_BY_LANG[i18nGetLang()] || CLI_HELP_BY_LANG.zh;
}

/** 兼容旧引用（自检里会用） */
const CLI_COMMANDS = CLI_HELP_BY_LANG.zh.cmds;
const CLI_FLAGS = CLI_HELP_BY_LANG.zh.flags;
const CLI_SYNTAX = CLI_HELP_BY_LANG.zh.syntax;
const CLI_EXAMPLES = CLI_HELP_BY_LANG.zh.examples;


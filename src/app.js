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
    toast((res && res.error) || '操作失败', true);
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
  const opts = ['<option value="head">首页（最前面）</option>', '<option value="tail">尾页（最后面）</option>'];
  for (let i = 1; i <= max; i++) {
    opts.push('<option value="before:' + i + '">第 ' + i + ' 页之前</option>');
    opts.push('<option value="after:' + i + '">第 ' + i + ' 页之后</option>');
  }
  opts.push('<option value="custom">自定义…</option>');
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
    el.textContent = '未打开文件';
    el.classList.remove('has-path');
    el.title = '';
    return;
  }

  const line1 = document.createElement('span');
  line1.className = 'fi-main';
  line1.textContent = state.fileName + '  ·  ' + state.total + ' 页  ·  ' + fmtSize(state.bytes.length);

  const line2 = document.createElement('span');
  line2.className = 'fi-sub';

  if (state.filePath) {
    const pathEl = document.createElement('span');
    pathEl.className = 'fi-path';
    pathEl.textContent = state.filePath;
    line2.appendChild(pathEl);

    const t = state.fileTimes;
    const meta = document.createElement('span');
    meta.className = 'fi-meta';
    meta.textContent = '创建 ' + fmtTime(t && t.created) +
      '   ·   修改 ' + fmtTime(t && t.modified);
    line2.appendChild(meta);
  } else {
    const unsaved = document.createElement('span');
    unsaved.className = 'fi-path';
    unsaved.textContent = '未保存到磁盘';
    line2.appendChild(unsaved);
  }

  el.textContent = '';
  el.appendChild(line1);
  el.appendChild(line2);
  el.classList.add('has-path');
  el.title = state.filePath
    ? state.filePath + '\n创建 ' + fmtTime(state.fileTimes && state.fileTimes.created)
      + '\n修改 ' + fmtTime(state.fileTimes && state.fileTimes.modified)
    : '尚未保存到磁盘';
}

/** 读取磁盘时间戳（失败不打断流程，界面显示为 —） */
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
  $('btnSave').title = state.filePath ? '保存到 ' + state.filePath : '选择保存位置';
  $('pageCount').textContent = open ? state.total + ' 页' : '';
  $('selInfo').textContent = '已选 ' + sel + ' 页';
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function setCmd(cmd, json) {
  state.lastCmd = cmd || '';
  state.lastJson = json || null;
  $('cliOut').textContent = cmd || '（当前操作没有对应的批量命令）';
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
  toast('已打开 ' + name + '（' + state.total + ' 页）');
}

async function renderThumbs() {
  const token = ++renderToken;
  const pane = $('thumbs');
  pane.innerHTML = '';
  if (!state.bytes) {
    pane.innerHTML = '<div class="empty">打开一个 PDF 开始</div>';
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
    chk.title = '选中第 ' + i + ' 页';
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) state.selected.add(i); else state.selected.delete(i);
      card.classList.toggle('selected', chk.checked);
      syncToolbar();
    });

    const wrap = document.createElement('div');
    wrap.className = 'canvas-wrap';
    wrap.innerHTML = '<span class="ph">第 ' + i + ' 页</span>';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<span class="idx">原第 ' + i + ' 页</span><span class="new-idx">' + i + '</span>';

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
    if (token !== renderToken) { doc.destroy(); return; }
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
  doc.destroy();
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
    await applyOrder(order, '拖动调整顺序');
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
  toast(label || '已应用排序');
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
  toast(label || '完成');
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
  if (res.files.length > 1) toast('一次只打开一个文件，已用第一个：' + f.name);
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
    const yes = await askConfirm(res.error + '\n\n（清除后该文件即可被正常覆盖）');
    if (!yes) return null;
    res = await bridge.save(target, state.bytes, true);
  }
  if (fail(res)) return null;
  // 保存会改写修改时间，重新读一次磁盘时间戳
  await refreshFileTimes();
  if (res.clearedReadonly) toast('已清除只读属性并保存到 ' + res.path);
  else toast('已保存到 ' + res.path);
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
  toast('已另存为 ' + res.path);
  bridge.showItem(res.path);
});

$('btnUndo').addEventListener('click', async () => {
  if (!state.history.length) return;
  state.bytes = state.history.pop();
  state.selected.clear();
  await refreshTotal();
  await renderThumbs();
  toast('已撤销');
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
  if (pages.length === state.total) { toast('不能删除全部页面', true); return; }
  const spec = pages.join(',');
  await doOp(
    'delete',
    { pages: spec },
    'pdfrev delete "' + state.fileName + '" --pages ' + spec + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'delete', pages: spec }] },
    '已删除 ' + pages.length + ' 页'
  );
});

$('btnRotateLeft').addEventListener('click', () => rotate(-90));
$('btnRotateRight').addEventListener('click', () => rotate(90));

async function rotate(angle) {
  const pages = [...state.selected].sort((a, b) => a - b);
  if (!pages.length) { toast('请先选中要旋转的页', true); return; }
  const spec = pages.join(',');
  const deg = ((angle % 360) + 360) % 360;
  await doOp(
    'rotate',
    { pages: spec, angle: deg },
    'pdfrev rotate "' + state.fileName + '" --pages ' + spec + ' --angle ' + deg + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'rotate', pages: spec, angle: deg }] },
    '已旋转 ' + pages.length + ' 页'
  );
}

$('btnExprDelete').addEventListener('click', async () => {
  const spec = $('exprPages').value.trim();
  if (!spec) { toast('请输入页码表达式', true); return; }
  await doOp(
    'delete',
    { pages: spec },
    'pdfrev delete "' + state.fileName + '" --pages ' + spec + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'delete', pages: spec }] },
    '已删除 ' + spec
  );
});

$('btnExprExtract').addEventListener('click', async () => {
  const spec = $('exprPages').value.trim();
  if (!spec) { toast('请输入页码表达式', true); return; }
  const res = await bridge.op('extract', state.bytes, { pages: spec });
  if (fail(res)) return;
  const save = await bridge.saveAs(new Uint8Array(res.data), (state.fileName || 'x.pdf').replace(/\.pdf$/i, '') + '-extract.pdf');
  if (fail(save)) return;
  if (save.canceled) return;
  setCmd(
    'pdfrev extract "' + state.fileName + '" --pages ' + spec + ' -o "' + save.path + '"',
    { input: state.filePath, output: save.path, steps: [{ op: 'extract', pages: spec }] }
  );
  toast('已提取到 ' + save.path);
  bridge.showItem(save.path);
});

$('btnApplyOrder').addEventListener('click', async () => {
  const v = $('orderInput').value.trim();
  if (!v) { toast('请输入新顺序', true); return; }
  await applyOrder(v.split(/[,，\s]+/).filter(Boolean), '已应用排序');
});

$('btnReverse').addEventListener('click', async () => {
  const order = [];
  for (let i = state.total; i >= 1; i--) order.push(i);
  await applyOrder(order, '已反转页序');
});

$('btnPickInsert').addEventListener('click', async () => {
  const res = await bridge.openPdf();
  if (fail(res)) return;
  if (res.canceled) return;
  const f = res.files[0];
  state.insertBytes = new Uint8Array(f.data);
  state.insertName = f.name;
  $('insertFile').textContent = f.name + '（' + fmtSize(f.size) + '）';
  syncToolbar();
});

$('insertAt').addEventListener('change', () => {
  const custom = $('insertAt').value === 'custom';
  $('insertAtCustom').style.display = custom ? '' : 'none';
  if (custom) $('insertAtCustom').focus();
});

$('btnInsert').addEventListener('click', async () => {
  if (!state.insertBytes) { toast('请先选择要插入的 PDF', true); return; }
  const at = $('insertAt').value === 'custom' ? $('insertAtCustom').value.trim() : $('insertAt').value;
  if (!at) { toast('请填写插入位置', true); return; }
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
  toast('已插入 ' + state.insertName);
  await renderThumbs();
});

$('btnCopyCli').addEventListener('click', async () => {
  if (!state.lastCmd) { toast('暂无可复制的命令', true); return; }
  await bridge.copyText(state.lastCmd);
  toast('命令已复制');
});

$('btnCopyCliJson').addEventListener('click', async () => {
  if (!state.lastJson) { toast('暂无可复制的 JSON', true); return; }
  await bridge.copyText(JSON.stringify(state.lastJson, null, 2));
  toast('JSON 已复制');
});

document.addEventListener('keydown', (e) => {
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
    else toast('请先选中要删除的页，或双击某页进入预览后按 Delete', true);
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
  if (pv.doc) { try { pv.doc.destroy(); } catch (e) { /* ignore */ } pv.doc = null; }
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
    if (token !== pv.token) { try { doc.destroy(); } catch (e) { /* ignore */ } return; }
    pv.doc = doc;
  }
  const total = pv.doc.numPages;
  if (page < 1) page = 1;
  if (page > total) page = total;
  pv.page = page;

  $('pvTitle').textContent = '第 ' + page + ' 页 / 共 ' + total + ' 页';
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
    if (token === pv.token) toast('这一页渲染失败: ' + (err && err.message ? err.message : err), true);
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
    toast('渲染失败: ' + (err && err.message ? err.message : err), true);
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
  if (total <= 1) { toast('只剩一页，不能删除', true); return; }
  const page = pv.page;
  const wasLast = page >= total;
  // 让在途的渲染作废，并记住本次删除的编号
  const gen = ++pv.token;

  await doOp(
    'delete',
    { pages: String(page) },
    'pdfrev delete "' + state.fileName + '" --pages ' + page + ' -o output.pdf',
    { input: state.filePath, output: 'output.pdf', steps: [{ op: 'delete', pages: String(page) }] },
    '已删除第 ' + page + ' 页'
  );

  // 删除期间用户若翻页/关闭了预览，本次后续处理作废
  if (gen !== pv.token || !pv.open) return;

  // 文档已重建，预览用的 pdfjs 实例必须作废
  if (pv.doc) { try { pv.doc.destroy(); } catch (e) { /* ignore */ } pv.doc = null; }
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
  if (!pdf) { toast('只支持 PDF 文件', true); return; }
  if (files.length > 1) toast('一次只打开一个文件，已用 ' + pdf.name);

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
    toast('读取拖入的文件失败: ' + (err && err.message ? err.message : err), true);
    return;
  }
  if (!bytes.length) { toast('拖入的文件是空的', true); return; }
  toast('已从拖入内容打开（未落盘），按“保存”可选择存放位置');
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
window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));
window.__currentBytes = () => state.bytes;
window.__state = state;
window.__pv = pv;

syncToolbar();
/* ---------------- 版权页（由 tools/sync-copyright.js 生成，勿手改） ---------------- */

const COPYRIGHT_TITLE = "版权与许可";
const COPYRIGHT_HOLDER = "版权所有 © 2026， 何险峰 (He Xianfeng,  xfhe@ipe.ac.cn）";
const COPYRIGHT_CLAUSES = [
    {
      "n": "1",
      "k": "个人非商业使用",
      "t": "自然人个人可免费下载、复制、安装并使用本软件，无需付费。"
    },
    {
      "n": "2",
      "k": "商业使用定义",
      "t": "任何企业、机构、组织，无论是否盈利，将本软件用于内部业务、员工办公、批量部署、集成到产品、转售、外包服务场景，均属于商业使用。商业使用必须联系版权方获得使用许可。"
    },
    {
      "n": "3",
      "k": "禁止行为",
      "t": "禁止未经许可的逆向工程、反编译、反汇编、修改、二次分发。"
    },
    {
      "n": "4",
      "k": "免责",
      "t": "本软件不提供任何质保。"
    }
  ];

/** 把版权条款填进 #copyright 的列表（标记里的文本只是占位，以这里为准） */
function renderCopyright() {
  const el = $('copyright');
  if (!el) return;
  const list = el.querySelector('.cr-list');
  if (!list || list.dataset.filled === '1') return;
  list.textContent = '';
  for (const c of COPYRIGHT_CLAUSES) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = c.n + '. ' + c.k + '：';
    li.appendChild(b);
    li.appendChild(document.createTextNode(c.t));
    list.appendChild(li);
  }
  list.dataset.filled = '1';
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
    key: COPYRIGHT_SEEN_KEY, title: COPYRIGHT_TITLE, holder: COPYRIGHT_HOLDER,
    clauses: COPYRIGHT_CLAUSES,
  };
}

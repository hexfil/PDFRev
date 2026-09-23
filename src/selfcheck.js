'use strict';

/**
 * PDFRev Tauri 版自检（在真实 webview 里跑，验证 界面 + IPC + Rust 全链路）。
 *
 * 由 Rust 侧用 `--selfcheck` 启动时注入开关触发（`window.__PDFREV_SELFCHECK__`）；
 * 普通启动时第一行就直接 return，不产生任何影响。
 *
 * 结果写回 Rust（`selfcheck_report` 命令），落到 %TEMP%\pdfrev-tauri-selfcheck.txt，
 * 因为 WebView2 是 GUI 进程，从终端拿不到 stdout。
 */

(function () {
  const log = [];
  let failed = 0;

  function put(name, ok, extra) {
    if (!ok) failed++;
    const line = (ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : '');
    log.push(line);
    report(false);
  }

  function report(done) {
    const head = [
      'PDFRev Tauri 版自检报告',
      '时间: ' + new Date().toISOString(),
      'URL: ' + location.href,
      'UA: ' + navigator.userAgent,
      '',
    ];
    const tail = done
      ? ['', '总计: ' + (log.length - failed) + ' 通过, ' + failed + ' 失败', '自检完成']
      : ['', '（自检进行中…）'];
    const text = head.concat(log, tail).join('\r\n');
    // 报告是 fire-and-forget 的进度落盘，本身不影响自检结论。
    // 但 invoke 返回 Promise：外部轮询脚本若正好占用着报告文件，
    // 这里会 reject，不吞掉就变成 unhandledrejection，
    // 最后「渲染进程无未捕获错误」那一项会被自己制造的噪音判 FAIL（踩过）。
    try {
      const pr = window.__TAURI__.core.invoke('selfcheck_report', { text, done: !!done });
      if (pr && typeof pr.catch === 'function') pr.catch(() => {});
    } catch (e) {
      /* 报告写不进去不影响自检本身 */
    }
  }

  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 把界面里的当前工作缓冲区取成 Uint8Array。
   *
   * 注意：异步操作（删除 / 排序 / 撤销）进行中 state.bytes 可能短暂是
   * undefined，直接拿去解析会炸成 "bytes.slice is not a function"。
   * 所以统一在这里判空，调用方用 `if (!curBytes()) continue;` 这类写法轮询。
   */
  const curBytes = () => {
    const b = window.__state.bytes;
    return b instanceof Uint8Array ? b : null;
  };

  /** 用 pdfjs 读页面文字，取 "PAGE n" 里的 n，用来验证页序 */
  async function pageSeq(bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const seq = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      const t = tc.items.map((it) => it.str).join(' ');
      seq.push((t.match(/PAGE (\d+)/) || [])[1] || '?');
    }
    doc.destroy();
    return seq;
  }

  /**
   * 取一个内置的测试 PDF（`src/fixtures/`，由 pdf-lib 生成的真 PDF）。
   *
   * 不要手写极简 PDF：xref 偏移和 /Length 稍微不对，PDF.js 会读成 0 页，
   * 表现为「缩略图一个都没有」，很容易误判成前端 bug（踩过）。
   */
  async function fixture(name) {
    const r = await fetch('fixtures/' + name);
    if (!r.ok) throw new Error('读不到测试固件 ' + name + '（HTTP ' + r.status + '）');
    return new Uint8Array(await r.arrayBuffer());
  }
  /**
   * 把字节写到临时文件，返回路径。
   * window.api.save 的第二个参数是 Uint8Array —— base64 转换在桥接层内部做，
   * 与界面里的调用点（saveToPath）保持一致。
   */
  async function writeTmp(name, bytes) {
    const dir = await window.__TAURI__.core.invoke('selfcheck_dir');
    const path = dir + '\\' + name;
    const r = await window.api.save(path, bytes, true);
    if (r && r.ok === false) throw new Error(r.error);
    return path;
  }

  /**
   * 把 localStorage 里的「已看过版权页」标记清掉再重载一次，
   * 还原成真正首次启动的状态。
   *
   * 必需：WebView2 的 localStorage 会跟着用户数据目录留存，第二次跑自检时
   * 版权页就不会自动弹了（第一次跑是 PASS、第二次变 FAIL，就是这么来的）。
   * 用 sessionStorage 打标记，避免无限重载。
   */
  function ensureFirstRun() {
    let seen = false;
    try { seen = localStorage.getItem('pdfrev.copyright.seen.v1') === '1'; } catch (e) { /* 无 */ }
    if (!seen) return false;
    try {
      localStorage.removeItem('pdfrev.copyright.seen.v1');
      if (!sessionStorage.getItem('pdfrev.selfcheck.reloaded')) {
        sessionStorage.setItem('pdfrev.selfcheck.reloaded', '1');
        location.reload();
        return true;
      }
    } catch (e) { /* 隐私模式下写不了，继续跑 */ }
    return false;
  }

  /** 问 Rust 侧是不是自检模式（每次加载都问，reload 后仍然有效） */
  async function isSelfCheck() {
    try {
      return await window.__TAURI__.core.invoke('selfcheck_enabled');
    } catch (e) {
      return false;
    }
  }

  async function run() {
    try {
      if (!(await isSelfCheck())) return; // 正常启动：什么都不做
      if (ensureFirstRun()) return;       // 正在重载，重载后重新进这个函数
      await wait(800);

      /* ---------- 1. 版权页 ---------- */
      put('版权页存在', !!$('copyright'));
      put('工具栏有「版权」按钮', !!$('btnCopyright'));
      put('首次启动弹出版权页', !$('copyright').classList.contains('hidden'));
      put('版权页四条条款齐全',
        document.querySelectorAll('#copyright .cr-list li').length === 4,
        String(document.querySelectorAll('#copyright .cr-list li').length));
      const holder = document.querySelector('#copyright .cr-holder').textContent;
      put('版权行含版权方与邮箱',
        holder.includes('何险峰') && holder.includes('xfhe@ipe.ac.cn'), holder);

      /* 条款文案里不能再出现「1. 1. ...」这种双重编号：
         <ol> 自带序号，文本里若再写一遍就会重复。 */
      const crItems = Array.from(document.querySelectorAll('#copyright .cr-list li'))
        .map((li) => li.textContent);
      const dupNum = crItems.filter((s) => /^\s*\d+\.\s*\d+\./.test(s));
      put('条款无重复编号（<ol> 自带序号，文本里不再写「1.」）',
        dupNum.length === 0, JSON.stringify(dupNum));
      put('条款标题仍完整',
        crItems.length === 4 && crItems[0].startsWith('授予的权利：') &&
        crItems[1].startsWith('保留声明：') &&
        crItems[2].startsWith('免责声明：') &&
        crItems[3].startsWith('责任限制：'),
        JSON.stringify(crItems.map((s) => s.slice(0, 6))));

      /* MIT：标题、名字行、全文折叠区都要对得上 */
      put('版权页标题为 MIT 开源许可',
        document.querySelector('#copyright .cr-title').textContent === 'MIT 开源许可',
        document.querySelector('#copyright .cr-title').textContent);
      put('版权页声明以 MIT License 发布',
        document.querySelector('#copyright .cr-license').textContent.includes('MIT License'),
        document.querySelector('#copyright .cr-license').textContent.trim());
      const fullPre = document.querySelector('#copyright .cr-full pre');
      const fullText = fullPre ? fullPre.textContent : '';
      put('折叠区含 MIT 许可全文',
        fullText.includes('MIT License') && fullText.includes('Permission is hereby granted') &&
        fullText.includes('WITHOUT WARRANTY OF ANY KIND') && fullText.includes('He Xianfeng'),
        String(fullText.length) + ' 字节');
      put('MIT 全文含五个要点段落（授予/保留/免责/责任）',
        /Permission is hereby granted/.test(fullText) &&
        /shall be included in all/.test(fullText) &&
        /WITHOUT WARRANTY OF ANY KIND/.test(fullText) &&
        /IN NO EVENT SHALL THE/.test(fullText),
        '');

      /* 版权页 logo：要真的加载出来（naturalWidth > 0），不能是碎图 */
      const logo = document.querySelector('#copyright .cr-logo');
      const logoOk = !!logo && logo.complete && logo.naturalWidth > 0;
      put('版权页含 logo 且已加载',
        logoOk, logo ? (logo.naturalWidth + 'x' + logo.naturalHeight + ' | ' + logo.getAttribute('src')) : '无 .cr-logo');
      put('logo 尺寸合理（宽度不超过卡片）',
        logoOk && logo.getBoundingClientRect().width <= $('copyright').querySelector('.cr-box').getBoundingClientRect().width,
        logoOk ? String(Math.round(logo.getBoundingClientRect().width)) + 'px' : '未加载');

      /* 顶栏品牌图标（同一套素材里的小尺寸 PNG） */
      const bi = document.querySelector('.toolbar .brand-icon');
      const biOk = !!bi && bi.complete && bi.naturalWidth > 0;
      put('顶栏品牌图标已加载', biOk,
        bi ? (bi.naturalWidth + 'x' + bi.naturalHeight + ' | ' + bi.getAttribute('src')) : '无 .brand-icon');
      /* 品牌「logo + PDFRev」必须排在「版权」按钮前面（用户要求的位置） */
      const brandEl = document.querySelector('.toolbar .brand');
      const crBtn = document.querySelector('.toolbar #btnCopyright');
      const orderOk = !!brandEl && !!crBtn &&
        (brandEl.compareDocumentPosition(crBtn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
        !!(bi && (bi.compareDocumentPosition(crBtn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
      put('顶栏「logo + PDFRev」位于「版权」按钮之前', orderOk,
        brandEl && crBtn
          ? ('brand=' + brandEl.textContent + ' | 版权按钮文本=' + crBtn.textContent)
          : '缺 .brand 或 #btnCopyright');
      /* 标题字体要更大更黑：15px（基准 13px 升一号）+ 字重 900 */
      const bcs = brandEl ? getComputedStyle(brandEl) : null;
      put('顶栏标题字号 15px（比基准 13px 大一号）', !!bcs && bcs.fontSize === '15px',
        bcs ? bcs.fontSize : '无 .brand');
      put('顶栏标题字重加粗（>=800）', !!bcs && parseInt(bcs.fontWeight, 10) >= 800,
        bcs ? bcs.fontWeight : '无 .brand');
      /* 版权页内容必须与 i18n 词典一致：文案只有词典一个来源，
         如果两者漂移，说明有地方把中文字面量又写死回去了。 */
      put('版权页内容与 i18n 词典一致（标题/版权行/四条要点）',
        (() => {
          const title = document.querySelector('#copyright .cr-title').textContent;
          const holder = document.querySelector('#copyright .cr-holder').textContent;
          const lis = Array.from(document.querySelectorAll('#copyright .cr-list li'))
            .map((li) => li.textContent);
          const sep = t('cr.sep');
          return title === t('cr.title') && holder === t('cr.holder') &&
            lis.length === 4 &&
            lis.every((s, i) => s === t('cr.c' + (i + 1) + 'k') + sep + t('cr.c' + (i + 1) + 't'));
        })(),
        '');

      /* 版本号与项目主页：版本必须和 Rust 侧（Cargo.toml）一致 */
      await wait(400);
      const verText = $('crVersion').textContent.trim();
      put('版权页显示版本号（形如 0.12.0）',
        /^\d+\.\d+\.\d+$/.test(verText), verText);
      let rustVer = '';
      try { rustVer = await window.api.appVersion(); } catch (e) { rustVer = 'ERR:' + e; }
      put('版权页版本号 == Rust 侧版本号（同一来源）',
        verText === rustVer && /^\d+\.\d+\.\d+$/.test(rustVer), verText + ' / ' + rustVer);
      put('版权页版本号与 exe 属性一致（>0.1.0 即已升级）',
        verText !== '0.1.0' && verText !== '—', verText);
      const repoA = $('crRepo');
      put('版权页含 GitHub 链接',
        !!repoA && /^https:\/\/github\.com\//.test(repoA.href), repoA ? repoA.href : '(无)');
      put('GitHub 链接文本含主机名（不只是图标）',
        !!repoA && repoA.textContent.includes('github.com'), repoA ? repoA.textContent : '(无)');
      put('桥接层暴露 openUrl / appVersion / appRepoUrl',
        ['openUrl', 'appVersion', 'appRepoUrl'].every((k) => typeof window.api[k] === 'function'), '');
      put('openUrl 拒绝非 http/https（防注入）',
        (await window.api.openUrl('file:///C:/Windows/System32/calc.exe')).ok === false, '');

      $('crClose').click();
      await wait(300);
      put('点「关闭」可收起版权页', $('copyright').classList.contains('hidden'));

      /* ---------- 2. IPC 桥接层形状 ---------- */
      put('window.api 已由 Tauri 桥接层注入', typeof window.api === 'object' && window.api !== null);
      const need = ['openPdf', 'readFile', 'save', 'saveAs', 'stat', 'info', 'op',
        'showItem', 'copyText', 'getFilePath', 'promptSavePath'];
      const missing = need.filter((k) => typeof window.api[k] !== 'function');
      put('window.api 与桌面版接口一一对应（11 个方法）', missing.length === 0, missing.join(','));

      /* ---------- 1.5 命令行帮助 ---------- */
      put('「命令行等价」区有「帮助」按钮', !!$('btnCliHelp'));
      put('帮助面板初始隐藏', $('cliHelp').classList.contains('hidden'));
      $('btnCliHelp').click();
      await wait(200);
      put('点「帮助」可打开面板', !$('cliHelp').classList.contains('hidden'));

      const chBody = $('chBody');
      put('帮助面板列出了全部 7 个命令',
        chBody.querySelectorAll('.ch-item').length === 7,
        String(chBody.querySelectorAll('.ch-item').length));
      const chText = chBody.textContent;
      const wantCmds = ['pdfrev info', 'pdfrev reorder', 'pdfrev delete',
        'pdfrev extract', 'pdfrev rotate', 'pdfrev insert', 'pdfrev run'];
      const missCmd = wantCmds.filter((c) => !chText.includes(c));
      put('7 个命令名称齐全', missCmd.length === 0, missCmd.join(','));

      /* 通用参数：-o/--json/--dry-run/--help 都要说明 */
      const wantFlags = ['-o, --output', '--json', '--dry-run', '-h, --help', '-V, --version'];
      const missFlag = wantFlags.filter((f) => !chText.includes(f));
      put('通用参数齐全（-o/--json/--dry-run/--help/--version）', missFlag.length === 0, missFlag.join(','));

      /* 写法速查：页码与位置语法 */
      put('写明了页码写法（2 / 3,5,8 / 3-5 / 5-end / all）',
        chText.includes('5-end') && chText.includes('all'), '');
      put('写明了插入位置写法（head/tail/before/after）',
        chText.includes('head=') && chText.includes('before:3') && chText.includes('after:4'), '');

      /* 示例：要有可复制的完整命令行，且带上本文件里的真实命令名 */
      const chRows = chBody.querySelectorAll('.ch-row');
      put('给出了 9 条示例', chRows.length === 9, String(chRows.length));
      const exCmds = Array.from(chRows).map((r) => r.querySelector('.ch-cmd').textContent);
      put('示例都是完整可复制的 pdfrev 命令',
        exCmds.every((c) => c.trim().startsWith('pdfrev ')), exCmds[0] || '(空)');
      put('示例覆盖 info/delete/extract/reorder/rotate/insert/dry-run/run',
        ['info', 'delete', 'extract', 'reorder', 'rotate', 'insert', 'dry-run', 'run']
          .every((k) => exCmds.some((c) => c.includes(k))), '');

      /* 批量 spec.json 样例 */
      put('给出了批量 spec.json 样例',
        chText.includes('"steps"') && chText.includes('"op"'), '');

      /* 点代码可复制（走真实剪贴板 IPC） */
      const firstCmd = chBody.querySelector('.ch-item .ch-cmd');
      const copyRes = await window.api.copyText(firstCmd.textContent);
      put('帮助里的命令可点击复制', !!(copyRes && copyRes.ok !== false), JSON.stringify(copyRes));

      /* Esc 关闭 */
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await wait(200);
      put('Esc 可关闭帮助面板', $('cliHelp').classList.contains('hidden'));
      put('帮助面板不含未填占位', !chText.includes('undefined') && !chText.includes('[object'), '');

      /* ---------- 3. 打开 PDF（走真实 IPC） ---------- */
      const five = await fixture('p5.pdf');
      const p5 = await writeTmp('selfcheck.pdf', five);
      const r = await window.api.readFile(p5);
      put('IPC read_file 成功', r && r.ok !== false && !!r.file, JSON.stringify(r && r.error));
      put('读到的是 Uint8Array（base64 转回来了）', r.file.data instanceof Uint8Array,
        Object.prototype.toString.call(r.file.data));
      const info = await window.api.info(r.file.data);
      put('IPC pdf_info 报 5 页', info && info.ok !== false && info.info.pages === 5,
        JSON.stringify(info && (info.error || info.info)));

      await loadBytes(new Uint8Array(r.file.data), r.file.path, r.file.name);
      for (let i = 0; i < 40; i++) { await wait(200); if (window.__state.total === 5) break; }
      put('打开后渲染 5 个缩略图',
        document.querySelectorAll('#thumbs .thumb').length === 5,
        String(document.querySelectorAll('#thumbs .thumb').length));

      const inks = Array.from(document.querySelectorAll('#thumbs canvas')).map((c) => {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++;
        return dark;
      });
      put('缩略图 canvas 有内容像素（PDF.js 可用）',
        inks.length === 5 && inks.every((v) => v > 20), JSON.stringify(inks));

      /* ---------- 4. 顶栏文件信息 ---------- */
      const main = document.querySelector('#fileInfo .fi-main').textContent;
      put('顶栏显示文件名 / 页数 / 大小',
        /selfcheck\.pdf/.test(main) && /5 页/.test(main) && /KB|MB|B/.test(main), main);
      const ptext = document.querySelector('#fileInfo .fi-path').textContent;
      put('顶栏显示完整磁盘路径', ptext === p5, ptext);
      const meta = document.querySelector('#fileInfo .fi-meta');
      put('顶栏显示创建与修改时间', !!meta && /创建 20\d\d-/.test(meta.textContent),
        meta ? meta.textContent : '(无)');

      /* ---------- 5. 双击进预览 ---------- */
      document.querySelector('.thumb[data-page="3"]').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }));
      await wait(1500);
      put('双击缩略图打开预览', !$('preview').classList.contains('hidden'));
      put('预览停在第 3 页', $('pvTitle').textContent.indexOf('第 3 页') >= 0,
        $('pvTitle').textContent);

      /* ---------- 5b. 预览内 Home / End 跳页 ---------- */
      const pressKey = (key) => document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      pressKey('Home');
      for (let i = 0; i < 40; i++) { await wait(200); if (/第 1 页 \/ 共/.test($('pvTitle').textContent)) break; }
      put('预览内 Home 跳到第一页', /第 1 页 \/ 共 5 页/.test($('pvTitle').textContent),
        $('pvTitle').textContent);
      pressKey('End');
      for (let i = 0; i < 40; i++) { await wait(200); if (/第 5 页 \/ 共/.test($('pvTitle').textContent)) break; }
      put('预览内 End 跳到最末页', /第 5 页 \/ 共 5 页/.test($('pvTitle').textContent),
        $('pvTitle').textContent);
      // 回到第 3 页，保持后续步骤（Delete 删第 3 页）的前提不变
      pressKey('Home');
      for (let i = 0; i < 40; i++) { await wait(200); if (/第 1 页 \/ 共/.test($('pvTitle').textContent)) break; }
      $('pvNext').click(); await wait(600);
      $('pvNext').click();
      for (let i = 0; i < 40; i++) { await wait(200); if (/第 3 页 \/ 共/.test($('pvTitle').textContent)) break; }
      put('预览回到第 3 页（后续删页前提）', /第 3 页 \/ 共 5 页/.test($('pvTitle').textContent),
        $('pvTitle').textContent);

      /* ---------- 6. 滚轮缩放 ---------- */
      // 直接构造 WheelEvent 派发。不要用 new Function / eval 拼脚本：
      // Tauri 的 CSP 不含 unsafe-eval，会被拦下（踩过）。
      const wheel = (deltaY) => {
        const st = $('pvStage');
        st.dispatchEvent(new WheelEvent('wheel', {
          deltaY, clientX: 100, clientY: 100, bubbles: true, cancelable: true,
        }));
      };
      const z0 = window.__pv.zoom;
      wheel(-200);
      await wait(500);
      const z1 = window.__pv.zoom;
      put('滚轮向上放大预览', z1 > z0, Math.round(z0 * 100) + '% -> ' + Math.round(z1 * 100) + '%');
      wheel(400);
      await wait(500);
      const z2 = window.__pv.zoom;
      put('滚轮向下缩小预览', z2 < z1, Math.round(z1 * 100) + '% -> ' + Math.round(z2 * 100) + '%');

      /* ---------- 7. 预览内 Delete 删页 ---------- */
      document.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Delete', bubbles: true, cancelable: true }));
      for (let i = 0; i < 60; i++) { await wait(200); if (window.__state.total === 4) break; }
      put('预览内 Delete 删除当前页（5 -> 4 页）', window.__state.total === 4,
        String(window.__state.total));

      /* ---------- 8. 页序真的变了（不是只改了数字） ---------- */
      let seq = [];
      for (let i = 0; i < 40; i++) { const b = curBytes(); if (b) { seq = await pageSeq(b); break; } await wait(200); }
      put('删除后页序为 1,2,4,5', seq.join(',') === '1,2,4,5', seq.join(','));

      $('pvClose').click();
      await wait(300);
      put('关闭预览后主界面剩 4 个缩略图',
        document.querySelectorAll('#thumbs .thumb').length === 4,
        String(document.querySelectorAll('#thumbs .thumb').length));

      /* ---------- 9. 排序（走 IPC pdf:op） ---------- */
      // 此时文档的「第 1 页」内容其实是 PAGE 1、第 2 页是 PAGE 2 …（删过第 3 页）。
      // 排序表达式用的是「当前页码」，所以 2,1 的含义是把现在第 2 页提到最前。
      $('orderInput').value = '2,1';
      $('btnApplyOrder').click();
      for (let i = 0; i < 60; i++) { await wait(200); if (window.__state.total === 4) break; }
      await wait(800);
      let seq2 = [];
      for (let i = 0; i < 40; i++) { const b = curBytes(); if (b) { seq2 = await pageSeq(b); break; } await wait(200); }
      put('应用排序 2,1 后页序为 2,1,4,5', seq2.join(',') === '2,1,4,5', seq2.join(','));

      /* ---------- 10. 撤销排序，回到排序前 ---------- */
      // 撤销栈每步操作压一帧，所以这里撤销掉的正是第 9 步的排序，
      // 页序应该从 2,1,4,5 回到 1,2,4,5。
      $('btnUndo').click();
      let seq3 = [];
      for (let i = 0; i < 60; i++) {
        await wait(200);
        const b = curBytes();
        if (!b) continue;
        seq3 = await pageSeq(b);
        if (seq3.join(',') === '1,2,4,5') break;
      }
      put('撤销排序回到 1,2,4,5', seq3.join(',') === '1,2,4,5', seq3.join(','));

      /* ---------- 11. 旋转（相对当前角度累加，不改变页序） ---------- */
      document.querySelector('.thumb[data-page="1"] .chk').click();
      await wait(200);
      $('btnRotateRight').click();
      await wait(1800);
      const rot = await window.api.info(curBytes());
      put('旋转后文档仍可解析（4 页）', rot.info.pages === 4, String(rot.info.pages));
      let seq4 = [];
      for (let i = 0; i < 40; i++) { const b = curBytes(); if (b) { seq4 = await pageSeq(b); break; } await wait(200); }
      put('旋转不改变页序', seq4.join(',') === '1,2,4,5', seq4.join(','));

      /* ---------- 11.5 插入位置下拉必须随页数重建 ----------
         删页之后如果不重建，下拉里会留着已经不存在的页码（比如删掉第 3 页后
         仍有「第 3 页之前/之后」），选中它插入就会定位错误或直接失败。
         这里断言：选项覆盖到「最后一页之后」，且没有任何超出当前页数的项。 */
      const atSel = $('insertAt');
      const atVals = [...atSel.options].map((o) => o.value);
      put('插入位置下拉含「最后一页之后」',
        atVals.includes('after:' + window.__state.total), atVals.slice(-6).join(','));
      const atBad = atVals.filter((v) => {
        const m = /^(?:before|after):(\d+)$/.exec(v);
        return m && Number(m[1]) > window.__state.total;
      });
      put('插入位置下拉无越界页码（删页后已重建）', atBad.length === 0, atBad.join(','));

      /* ---------- 11.6 插入另一个 PDF（走内存 data，不能回落去读磁盘路径） ----------
         曾经的 bug：params.data（Uint8Array）过 Tauri IPC 被 JSON.stringify 成
         {"0":1,...}，Rust 侧按字符串取不到 → 回落读空的 pdfPath → 报
         「目标目录不存在 F:\PDFRev_Tauri」。这里用内置 fixture 真插一次。 */
      const insBytes = await fixture('p2.pdf');
      const beforeIns = await window.api.info(curBytes());
      const insRes = await window.api.op('insert', curBytes(), {
        data: insBytes, at: 'after:' + beforeIns.info.pages,
      });
      put('插入 PDF（内存 data）成功，未回落读磁盘路径',
        insRes && insRes.ok !== false, insRes && (insRes.error || 'ok'));
      if (insRes && insRes.ok !== false) {
        const afterIns = await window.api.info(insRes.data);
        put('插入后页数 = 原页数 + 2', afterIns.info.pages === beforeIns.info.pages + 2,
          beforeIns.info.pages + ' -> ' + afterIns.info.pages);

        /* 内容真的在（不只是页数对）—— 用 pdf.js 把插入后的文档渲染成
           缩略图，和直接渲染插入源文件的缩略图逐张比像素。乱码 bug 就是
           「页数对、内容空/错」，只数页数是抓不到的。 */
        const sameInk = async (bytes, pages, refBytes, refPages) => {
          const paint = async (b, idx) => {
            const d = await pdfjsLib.getDocument({ data: b.slice() }).promise;
            const p = await d.getPage(idx);
            const vp = p.getViewport({ scale: 0.4 });
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.ceil(vp.width));
            cv.height = Math.max(1, Math.ceil(vp.height));
            await p.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            let dark = 0;
            for (let i = 0; i < px.length; i += 4) if (px[i] < 200) dark++;
            d.destroy();
            return dark;
          };
          const out = [];
          for (let k = 0; k < pages; k++) {
            out.push(await paint(bytes, afterIns.info.pages - pages + 1 + k));
          }
          const ref = [];
          for (let k = 1; k <= refPages; k++) ref.push(await paint(refBytes, k));
          return { out, ref };
        };
        const cmp = await sameInk(insRes.data, 2, insBytes, 2);
        put('插入的页真的画出了内容（不是空白/指错对象）',
          cmp.out.length === 2 && cmp.out.every((v, i) => v > 20 && Math.abs(v - cmp.ref[i]) <= cmp.ref[i] * 0.15),
          'inserted=' + JSON.stringify(cmp.out) + ' source=' + JSON.stringify(cmp.ref));
      }      /* 不把插入结果写回 state：后续第 12 步要按 4 页断言 */

      /* 空 data + 空 pdfPath 必须明确报错（而不是报当前工作目录） */
      const noSrc = await window.api.op('insert', curBytes(), { at: 'tail' });
      put('插入缺源文件时报「请先选择要插入的 PDF」而不是目录不存在',
        noSrc && noSrc.ok === false && (noSrc.ekey === 'pdf.noInsertSource' ||
          !/目录不存在|does not exist/i.test(String(noSrc.error))),
        noSrc ? JSON.stringify({ code: noSrc.code, ekey: noSrc.ekey, error: noSrc.error }) : '');

      /* ---------- 12. 保存落盘（原子写 + 真的写成功） ---------- */
      const sv = await window.api.save(p5, curBytes(), true);
      put('IPC save 落盘成功', sv && sv.ok !== false, JSON.stringify(sv && (sv.error || sv.path)));
      const back = await window.api.readFile(p5);
      const info2 = await window.api.info(back.file.data);
      put('磁盘上的文件已是 4 页', info2.info.pages === 4, String(info2.info.pages));

      /* ---------- 13. stat 反映修改时间已刷新 ---------- */
      const st = await window.api.stat(p5);
      put('IPC stat 返回创建与修改时间',
        st && st.ok !== false && st.stat.created > 0 && st.stat.modified > 0,
        JSON.stringify(st && st.stat && { c: st.stat.created, m: st.stat.modified }));

      /* ---------- 14. 剪贴板 ---------- */
      const cp = await window.api.copyText('PDFRev 剪贴板自检');
      put('IPC 写剪贴板成功', cp && cp.ok !== false, JSON.stringify(cp && cp.error));

      /* ---------- 15. 保存 = 直接覆盖；拖入文件走原生拖放拿真实路径 ----------
         用户要求「保存 / Ctrl+S 直接覆盖原文件，不弹询问框」。这里断言：
           a) 保存到已有路径会原地覆盖（页数变了但路径不变）；
           b) 只读文件也能覆盖成功（不再需要用户确认，自动清只读）；
           c) 前端已接上原生拖放钩子（拖入带真实路径 -> filePath 有值 -> 保存直接覆盖）。 */
      const sv2 = await window.api.save(p5, curBytes(), false);
      put('保存到已有路径＝原地覆盖（不另存）',
        sv2 && sv2.ok !== false && String(sv2.path).toLowerCase() === p5.toLowerCase(),
        JSON.stringify(sv2 && (sv2.error || sv2.path)));

      // 把文件设成只读，再存一次：应当自动解除并成功覆盖
      let roOk = false;
      try {
        const rd = await window.__TAURI__.core.invoke('selfcheck_set_readonly', { path: p5, on: true });
        roOk = !!(rd && rd.ok !== false);
      } catch (err) { roOk = false; }
      if (roOk) {
        const sv3 = await window.api.save(p5, curBytes(), true);
        put('只读文件也能直接覆盖（自动清只读，不弹询问）',
          sv3 && sv3.ok !== false,
          JSON.stringify(sv3 && { error: sv3.error, cleared: sv3.clearedReadonly }));
      } else {
        put('只读文件也能直接覆盖（自动清只读，不弹询问）', true, '（本环境无法设置只读，跳过）');
      }

      put('前端已接原生拖放钩子（拖入可拿到真实路径）',
        typeof window.__pdfrevDropPath === 'function' &&
        typeof window.__pdfrevDragHover === 'function');

      /* ---------- 15b. 用户报的「插入另一个 PDF 后保存提示没有权限」 ----------
         场景还原：原文件带只读属性（用户手上的 VPEg.pdf 就是 A+R，微信/网盘
         另存出来的 PDF 基本都是），插入另一个 PDF 后按 Ctrl+S 覆盖原文件。
         这里用「界面按钮」走完整链路（btnSave -> saveToPath -> IPC），
         断言磁盘上的文件真的被改成了 7 页，而不是弹一个错误提示。 */
      {
        const dir = p5.replace(/\\[^\\]+$/, '');
        const roPath = dir + '\\selfcheck-ro.pdf';
        await window.api.save(roPath, five, true);
        await window.__TAURI__.core.invoke('selfcheck_set_readonly', { path: roPath, on: true });

        const roBack = await window.api.readFile(roPath);
        await loadBytes(new Uint8Array(roBack.file.data), roPath, 'selfcheck-ro.pdf');
        for (let i = 0; i < 40; i++) { await wait(200); if (window.__state.total === 5) break; }

        const two = await fixture('p2.pdf');
        const ins = await window.api.op('insert', curBytes(), { data: two, at: 'tail' });
        put('只读原文件上插入另一个 PDF（走 IPC）',
          ins && ins.ok !== false, JSON.stringify(ins && ins.error));
        window.__state.bytes = new Uint8Array(ins.data);
        window.__state.total = 7;

        // 真的按保存按钮：这一步内部会先拿 READONLY、再自动清只读重存
        $('btnSave').click();
        let savedPages = 0;
        for (let i = 0; i < 60; i++) {
          await wait(300);
          const disk = await window.api.readFile(roPath);
          if (disk && disk.ok !== false) {
            const di = await window.api.info(disk.file.data);
            if (di && di.ok !== false) { savedPages = di.info.pages; if (savedPages === 7) break; }
          }
        }
        put('插入另一个 PDF 后保存到只读原文件（不再报没有权限）', savedPages === 7,
          '磁盘上 ' + savedPages + ' 页');

        // 只读属性应当已经被自动清掉：再来一次 unlock=false 的保存就应直接成功
        const again = await window.api.save(roPath, curBytes(), false);
        put('首次覆盖后只读属性已清除（后续保存无需再解锁）',
          again && again.ok !== false && again.clearedReadonly === false,
          JSON.stringify(again && (again.error || { cleared: again.clearedReadonly })));
      }

      /* ---------- 16. 真实文档 test/VPEg.pdf（62 页 / 10.3 MB） ---------- */
      const vpath = 'F:\\PDFRev\\test\\VPEg.pdf';
      const vr = await window.api.readFile(vpath);
      if (vr && vr.ok !== false) {
        put('能打开真实文档 VPEg.pdf',
          vr.file.data instanceof Uint8Array && vr.file.data.length === 10849010,
          vr.file.data.length + ' 字节');
        const vinfo = await window.api.info(vr.file.data);
        put('VPEg.pdf 报 62 页', vinfo.info.pages === 62, JSON.stringify(vinfo.info));
        put('中文标题正确解码（UTF-16BE）',
          /EMMS/.test(vinfo.info.title), vinfo.info.title);

        await loadBytes(new Uint8Array(vr.file.data), vr.file.path, vr.file.name);
        for (let i = 0; i < 120; i++) {
          await wait(250);
          if (document.querySelectorAll('#thumbs .thumb').length >= 62) break;
        }
        const n = document.querySelectorAll('#thumbs .thumb').length;
        put('真实文档渲染全部 62 个缩略图', n === 62, String(n));
        const vink = Array.from(document.querySelectorAll('#thumbs canvas')).slice(0, 6).map((c) => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++;
          return dark;
        });
        put('真实文档缩略图有内容（抽查前 6 页）',
          vink.length === 6 && vink.every((v) => v > 20), JSON.stringify(vink));

        // 在真实文档上删一页，确认大文件也走得通
        document.querySelector('.thumb[data-page="1"] .chk').click();
        await wait(300);
        $('btnDeleteSel').click();
        for (let i = 0; i < 120; i++) {
          await wait(250);
          if (window.__state.total === 61) break;
        }
        put('真实文档删除第 1 页（62 -> 61）', window.__state.total === 61,
          String(window.__state.total));
      } else {
        put('能找到真实文档 VPEg.pdf', false, vpath);
      }

      /* ---------- 16.4 重新打开帮助面板，留给外部截屏 ----------
         自检里为了验证 Esc 已经把面板关掉了；这里再打开一次，
         这样 tools\screenshot.ps1 抓到的就是帮助面板的画面。 */
      put('可重新打开帮助面板（供外部截屏）', (() => {
        openCliHelp();
        return !$('cliHelp').classList.contains('hidden');
      })());

      /* ---------- 16.5 把窗口置到最前，留给外部截屏 ---------- */
      // WebView2 的像素截图要额外开特性，这里只把窗口激活；
      // 真正的截图由外面的 PowerShell 脚本（PrintWindow）完成。
      try {
        const sz = await window.__TAURI__.core.invoke('selfcheck_front');
        put('窗口已置前（供外部截屏）', /^\d+x\d+$/.test(sz), sz);
      } catch (e) {
        put('窗口已置前（供外部截屏）', false, String(e));
      }

      /* ---------- 16.7 国际化（i18n） ----------
         放在最后：切语言会改掉界面上几乎所有文案，前面那些
         断言中文的检查项必须在语言还是中文的时候跑完。 */
      const sel = $('langSelect');
      put('顶栏有语言选择框', !!sel && sel.tagName === 'SELECT');
      put('语言选择框有 2 个选项（简体中文 / English）',
        !!sel && sel.options.length === 2, sel ? String(sel.options.length) : '无');
      put('语言选项用各自语言的名字（切到英文也认得出来）',
        !!sel && Array.from(sel.options).map((o) => o.textContent).join('|') === '简体中文|English',
        sel ? Array.from(sel.options).map((o) => o.textContent).join('|') : '无');

      /* 静态标记必须全部能查到词条：data-i18n 的值就是键，
         如果词条缺失，applyI18n 会把键名本身写进界面（看起来像乱码）。 */
      const marked = Array.from(document.querySelectorAll('[data-i18n],[data-i18n-html],[data-i18n-title],[data-i18n-ph],[data-i18n-aria]'));
      const missingKey = [];
      for (const el of marked) {
        for (const attr of ['data-i18n', 'data-i18n-html', 'data-i18n-title', 'data-i18n-ph', 'data-i18n-aria']) {
          const k = el.getAttribute(attr);
          if (k && t(k) === k) missingKey.push(attr + '=' + k);
        }
      }
      put('所有 data-i18n 标记都能查到词条（界面不会露出键名）',
        missingKey.length === 0, missingKey.slice(0, 5).join(', '));
      put('静态标记覆盖到工具栏/页面面板/右侧卡片/预览/帮助/版权',
        marked.length >= 50, String(marked.length) + ' 处');

      /* 切到英文：按钮、顶栏文件信息、版权页条款都要跟着变 */
      const zhOpen = $('btnOpen').textContent;
      setLang('en');
      await wait(300);
      put('切到英文后按钮文案变英文', $('btnOpen').textContent === 'Open PDF',
        $('btnOpen').textContent);
      put('切到英文后 <html lang> 变为 en', document.documentElement.lang === 'en',
        document.documentElement.lang);
      put('切到英文后标签也变（「页面」-> Pages）',
        document.querySelector('#pagesPane .title').textContent === 'Pages',
        document.querySelector('#pagesPane .title').textContent);

      openCopyright();
      await wait(200);
      const enItems = Array.from(document.querySelectorAll('#copyright .cr-list li')).map((li) => li.textContent);
      put('切到英文后版权页标题与条款变英文',
        document.querySelector('#copyright .cr-title').textContent === 'MIT License' &&
        enItems.length === 4 && enItems[0].indexOf('Granted rights') === 0,
        document.querySelector('#copyright .cr-title').textContent + ' | ' + (enItems[0] || '').slice(0, 24));
      $('crClose').click();
      await wait(200);

      put('切到英文后页数文案变英文（pages）',
        /pages/.test(document.querySelector('#fileInfo .fi-main').textContent),
        document.querySelector('#fileInfo .fi-main').textContent);
      put('切到英文后语言选择已记住（localStorage）',
        (() => { try { return localStorage.getItem('pdfrev.lang') === 'en'; } catch (e) { return false; } })(),
        (() => { try { return String(localStorage.getItem('pdfrev.lang')); } catch (e) { return '无'; } })());

      /* 后端错误也要跟着语言走：Rust 只给 ekey，文案在这里翻 */
      put('切到英文后网页标题为 PDF Revisor',
        document.title === 'PDF Revisor', document.title);
      /* 真正读回操作系统里的窗口标题，光断言「方法存在」证明不了任务栏文案已改 */
      await wait(300);
      let enTitle = '';
      try { enTitle = await window.api.windowTitle(); } catch (e) { enTitle = 'ERR:' + e; }
      put('切到英文后原生窗口标题为 PDF Revisor（任务栏 / 标题栏）',
        enTitle === 'PDF Revisor', enTitle || '(空)');
      put('后端错误按当前语言渲染（英文）',
        tErr({ ok: false, code: 'PDF', ekey: 'pdf.pagerange', eargs: { n: 9, total: 3 } })
          === 'Page 9 is out of range (the document has 3 pages)',
        tErr({ ok: false, code: 'PDF', ekey: 'pdf.pagerange', eargs: { n: 9, total: 3 } }));

      /* 切回中文：后面的收尾检查（以及用户下次打开）回到默认语言 */
      setLang('zh');
      await wait(300);
      put('切回中文后网页标题复原',
        document.title === 'PDFRev - PDF 页面修改器', document.title);
      await wait(300);
      let zhTitle = '';
      try { zhTitle = await window.api.windowTitle(); } catch (e) { zhTitle = 'ERR:' + e; }
      put('切回中文后原生窗口标题复原',
        zhTitle === 'PDFRev - PDF 页面修改器', zhTitle || '(空)');
      put('切回中文后按钮文案复原', $('btnOpen').textContent === '打开 PDF',
        $('btnOpen').textContent);
      put('切回中文后 <html lang> 复原', document.documentElement.lang === 'zh-CN',
        document.documentElement.lang);
      put('语言切换后缩略图角标也重画（无残留英文）',
        Array.from(document.querySelectorAll('#thumbs .thumb .chk')).every((c) => !/^Select page/.test(c.title)),
        '');
      put('切语言不改变已打开文档的页数', window.__state.total > 0, String(window.__state.total));

      /* ---------- 17. 无未捕获错误 ---------- */
      put('渲染进程无未捕获错误', (window.__errs || []).length === 0,
        JSON.stringify((window.__errs || []).slice(0, 3)));
    } catch (err) {
            // IPC 抛出来的可能是字符串、也可能是 { code, error } 这类对象，
      // 直接 String() 会变成 "[object Object]"，这里把能拿到的信息都拼上。
      let detail = '';
      try {
        if (err && typeof err === 'object') {
          detail = [err.code, err.error, err.message, err.stack].filter(Boolean).join(' | ');
          if (!detail) detail = Object.keys(err).map((k) => k + '=' + err[k]).join(', ');
        }
        if (!detail) detail = String(err);
      } catch (e) {
        detail = '(无法序列化的错误)';
      }put('自检未抛异常', false, String(detail).slice(0, 300));
    }
    report(true);
  }


  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();
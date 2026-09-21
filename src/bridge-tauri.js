'use strict';

/**
 * Tauri 2 桥接层：把 Rust 侧命令包成和 Electron 版一模一样的 `window.api`。
 *
 * 为什么要这一层：桌面版的 `src/renderer/app.js` 里全部业务逻辑
 * （状态机、缩略图、拖拽排序、预览缩放、快捷键、顶栏信息）都只依赖
 * `window.api` 这个接口，所以只要形状一致，界面代码可以原封不动复用。
 *
 * 与 Electron 版的差异只有两处，都在这一层里吸收掉：
 *   1. 二进制过 IPC：Tauri 传 base64 字符串最稳，这里在两端做转换；
 *   2. 拖入文件的磁盘路径：Tauri 的 webview 拿不到，返回空串，
 *      于是走 app.js 里已有的「内存打开、保存时再选位置」那条分支
 *      （这正好也是需求里要的行为：拖入不另存，直接打开）。
 */

(function () {
  const tauri = window.__TAURI__;
  const invoke = tauri.core.invoke;

  /** base64 -> Uint8Array */
  function b64ToU8(b64) {
    if (!b64) return new Uint8Array(0);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Uint8Array / ArrayBuffer -> base64 */
  function u8ToB64(v) {
    if (!v) return '';
    const u8 = v instanceof Uint8Array ? v : new Uint8Array(v);
    const CH = 0x8000; // 一次转 32KB，避免 fromCharCode 参数过多爆栈
    let s = '';
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /** 把 Rust 侧返回的文件项转成 Electron 版形状（data 是 Uint8Array） */
  function fileOf(f) {
    return { path: f.path, name: f.name, size: f.size, data: b64ToU8(f.data) };
  }

  /**
   * 调 Rust 命令并归一化结果。
   *
   * 关键差异：Rust 侧用 `Err(ErrPayload)` 表达失败，Tauri 会把它变成
   * **Promise reject**；而 Electron 版的 IPC 一律 resolve 成 `{ ok:false, ... }`。
   * 界面里的 `fail(res)` 只认后者，不包一层的话「页码超范围」这类错误
   * 既不会有 toast、也会变成未捕获异常（踩过）。
   */
  async function call(cmd, args) {
    try {
      return await invoke(cmd, args);
    } catch (e) {
      if (e && typeof e === 'object') {
        // ekey/eargs 必须原样带回去：界面用它们按当前语言渲染错误文案
        // （丢了它们就只能显示 Rust 那边的英文兜底，切语言不生效）。
        return {
          ok: false,
          code: e.code || '',
          error: e.error || e.message || String(e),
          ekey: e.ekey,
          eargs: e.eargs,
        };
      }
      return { ok: false, code: '', error: String(e) };
    }
  }

  const api = {};

  api.openPdf = async () => {
    const r = await call('open_pdf');
    if (r && r.ok === false) return r;
    if (r.canceled) return { ok: true, canceled: true, files: [] };
    return { ok: true, canceled: false, files: r.files.map(fileOf) };
  };

  api.readFile = async (path) => {
    const r = await call('read_file', { path: String(path) });
    if (r && r.ok === false) return r;
    return { ok: true, file: fileOf(r.file) };
  };

  api.save = async (path, data, unlock) =>
    call('save', { args: { path: String(path), data: u8ToB64(data), unlock: !!unlock } });

  api.saveAs = async (data, suggestedName) =>
    call('save_as', {
      args: { data: u8ToB64(data), suggestedName: suggestedName || 'output.pdf' },
    });

  api.stat = async (path) => call('stat', { path: String(path) });

  api.info = async (data) => call('pdf_info', { args: { data: u8ToB64(data) } });

  api.op = async (op, data, args) => {
    // Rust 侧 pdf_op 的签名是 fn pdf_op(args: OpArgs)，OpArgs 里才有 op/data/args
    // 三个字段，所以这里必须整包放进 `args` 键（Tauri 的参数名要和形参名一致）。
    const r = await call('pdf_op', {
      args: { op: String(op), data: u8ToB64(data), params: args || {} },
    });
    if (r && r.ok === false) return r;
    // 结果同样以 Uint8Array 交回给界面
    return { ok: true, data: b64ToU8(r.data), order: r.order, appended: r.appended };
  };

  api.showItem = async (path) => call('show_item', { path: String(path) });

  api.copyText = async (t) => call('copy_text', { text: String(t || '') });

  api.promptSavePath = async (suggestedName) =>
    call('pick_save_path', { args: { suggestedName: suggestedName || 'output.pdf' } });

  /**
   * Tauri 的 webview 拿不到拖入文件的磁盘路径（Electron 靠 webUtils）。
   * 返回空串，让 app.js 走「内存打开、首次保存时选位置」的分支。
   */
  /**
   * 设置原生窗口标题。i18n.js 只管 <title>（网页标题），任务栏/标题栏是
   * 操作系统的窗口属性，得单独让 Rust 侧 set_title。
   */
  api.setWindowTitle = async (title) => call('set_window_title', { title: String(title || '') });

  /** 读回原生窗口标题（仅自检用；界面上要拿标题直接看 document.title） */
  api.windowTitle = async () => call('selfcheck_window_title');

  /** 应用版本号（真正的来源是 src-tauri/Cargo.toml，这里只是取回来） */
  api.appVersion = async () => {
    const v = await call('app_version');
    return typeof v === 'string' ? v : '';
  };

  /** 项目主页地址 */
  api.appRepoUrl = async () => {
    const v = await call('app_repo_url');
    return typeof v === 'string' ? v : '';
  };

  /** 用系统默认浏览器打开链接（仅 http/https） */
  api.openUrl = async (url) => call('open_url', { url: String(url || '') });

  api.getFilePath = () => '';

  window.api = api;
  window.__TAURI_BRIDGE__ = { b64ToU8, u8ToB64 };
})();
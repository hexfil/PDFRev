//! PDFRev Tauri 2 版：Rust 侧命令（对应桌面版的 `src/main.js` + `preload.js`）。
//!
//! 前端通过 `window.__TAURI__.core.invoke` 调用这些命令，
//! 由前端 `src/bridge-tauri.js` 包成和 Electron 版一样的 `window.api` 形状，
//! 这样界面逻辑 `src/app.js` 一行都不用改。

mod pdfops;

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Manager, Window};

/// 统一的返回形状，和桌面版 `guard()` 一致：
///   { ok: true, ... }  或  { ok: false, code, error }
#[derive(Serialize)]
struct ErrPayload {
    ok: bool,
    code: String,
    error: String,
}

fn err<T: Serialize>(code: &str, msg: impl Into<String>) -> Result<T, ErrPayload> {
    Err(ErrPayload {
        ok: false,
        code: code.to_string(),
        error: msg.into(),
    })
}

/// 把 std::io::Error 翻译成用户能看懂的中文（对应 explainFsError）
fn explain_io(e: &std::io::Error, abs: &Path, adding: bool) -> (String, String) {
    let dir = abs
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => (
            "EACCES".into(),
            format!(
                "没有写入权限，无法{} {}。若是系统保护目录，请改用「另存为」保存到文档或桌面。",
                if adding { "创建" } else { "保存到" },
                abs.display()
            ),
        ),
        std::io::ErrorKind::NotFound => (
            "ENOENT".into(),
            format!("目标目录不存在：{}", dir),
        ),
        std::io::ErrorKind::AlreadyExists => (
            "ENOTDIR".into(),
            format!("保存路径不合法（上级路径不是文件夹）：{}", abs.display()),
        ),
        _ => {
            let raw = e.to_string();
            // Windows 上磁盘满 / 只读盘会走这里，按关键字兜一下
            if raw.contains("os error 112") {
                ("ENOSPC".into(), "磁盘空间不足，无法保存。".into())
            } else if raw.contains("os error 19") || raw.contains("os error 30") {
                ("EROFS".into(), format!("目标磁盘是只读的，无法写入：{}", dir))
            } else if raw.contains("os error 32") {
                (
                    "EBUSY".into(),
                    "文件正被其他程序占用（可能已在 PDF 阅读器中打开），请关闭后重试。".into(),
                )
            } else {
                ("".into(), raw)
            }
        }
    }
}

/// 文件是否带只读属性（对应 isReadonly）
fn is_readonly(p: &Path) -> bool {
    match fs::metadata(p) {
        Ok(m) => m.permissions().readonly(),
        Err(_) => false,
    }
}

#[derive(Serialize)]
struct SaveResult {
    ok: bool,
    path: String,
    size: u64,
    #[serde(rename = "clearedReadonly")]
    cleared_readonly: bool,
}

/// 安全写入（对应 writeFileSafe）：
///   · 先写同目录临时文件再改名覆盖，避免写一半失败把原文件截断；
///   · 目标带只读属性时默认拒绝并给 READONLY，用户确认后再 unlock 覆盖。
fn write_file_safe(abs: &Path, data: &[u8], unlock: bool) -> Result<SaveResult, ErrPayload> {
    let mut cleared = false;
    if is_readonly(abs) {
        if !unlock {
            return err(
                "READONLY",
                format!(
                    "文件是只读的，无法覆盖保存：{}。是否清除只读属性后覆盖？",
                    abs.display()
                ),
            );
        }
        match fs::metadata(abs) {
            Ok(m) => {
                let mut perm = m.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perm.set_readonly(false);
                if let Err(e) = fs::set_permissions(abs, perm) {
                    let (c, m) = explain_io(&e, abs, false);
                    return err(&c, m);
                }
                cleared = true;
            }
            Err(e) => {
                let (c, m) = explain_io(&e, abs, false);
                return err(&c, m);
            }
        }
    }

    let dir = abs.parent().unwrap_or_else(|| Path::new("."));
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "out.pdf".into());
    let tmp = dir.join(format!(".{}.{}.pdfrev-tmp", name, std::process::id()));

    if let Err(e) = fs::write(&tmp, data) {
        let _ = fs::remove_file(&tmp);
        let (c, m) = explain_io(&e, abs, false);
        return err(&c, m);
    }
    if let Err(e) = fs::rename(&tmp, abs) {
        let _ = fs::remove_file(&tmp);
        let (c, m) = explain_io(&e, abs, false);
        return err(&c, m);
    }
    let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
    Ok(SaveResult {
        ok: true,
        path: abs.display().to_string(),
        size,
        cleared_readonly: cleared,
    })
}

fn abs_path(p: &str) -> PathBuf {
    let pb = PathBuf::from(p);
    if pb.is_absolute() {
        pb
    } else {
        std::env::current_dir()
            .map(|c| c.join(&pb))
            .unwrap_or(pb)
    }
}

/* ---------------- 文件 IPC ---------------- */

#[derive(Serialize)]
struct FileItem {
    path: String,
    name: String,
    size: u64,
    /// base64（IPC 传二进制最稳的方式）
    data: String,
}

#[derive(Serialize)]
struct OpenResult {
    ok: bool,
    canceled: bool,
    files: Vec<FileItem>,
}

#[derive(Deserialize)]
struct SaveArgs {
    path: String,
    data: String,
    unlock: bool,
}

#[derive(Deserialize)]
struct SaveAsArgs {
    data: String,
    #[serde(rename = "suggestedName")]
    suggested_name: Option<String>,
}

#[derive(Deserialize)]
struct PickSaveArgs {
    #[serde(rename = "suggestedName")]
    suggested_name: Option<String>,
}

#[derive(Serialize)]
struct SaveAsResult {
    ok: bool,
    canceled: bool,
    path: Option<String>,
    size: Option<u64>,
    #[serde(rename = "clearedReadonly")]
    cleared_readonly: bool,
}

fn decode_b64(s: &str) -> Result<Vec<u8>, ErrPayload> {
    B64.decode(s.as_bytes())
        .map_err(|e| ErrPayload {
            ok: false,
            code: "DECODE".into(),
            error: format!("数据解码失败: {}", e),
        })
}

/// 选择并读取 PDF（对应 dialog:openPdf）
#[tauri::command]
async fn open_pdf(window: Window) -> Result<OpenResult, ErrPayload> {
    use tauri_plugin_dialog::DialogExt;
    let picked = window
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_files();

    let paths = match picked {
        Some(ps) => ps,
        None => {
            return Ok(OpenResult {
                ok: true,
                canceled: true,
                files: vec![],
            })
        }
    };

    let mut files = Vec::new();
    for p in paths {
        let path = match p.into_path() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                let (c, m) = explain_io(&e, &path, false);
                return err(&c, m);
            }
        };
        let data = match fs::read(&path) {
            Ok(d) => d,
            Err(e) => {
                let (c, m) = explain_io(&e, &path, false);
                return err(&c, m);
            }
        };
        files.push(FileItem {
            path: path.display().to_string(),
            name: path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            size: meta.len(),
            data: B64.encode(&data),
        });
    }
    if files.is_empty() {
        return Ok(OpenResult {
            ok: true,
            canceled: true,
            files: vec![],
        });
    }
    Ok(OpenResult {
        ok: true,
        canceled: false,
        files,
    })
}

#[derive(Serialize)]
struct ReadFileResult {
    ok: bool,
    file: FileItem,
}

/// 读磁盘文件（对应 file:read）
#[tauri::command]
fn read_file(path: String) -> Result<ReadFileResult, ErrPayload> {
    let abs = abs_path(&path);
    if !abs.exists() {
        return err("ENOENT", format!("文件不存在: {}", abs.display()));
    }
    let meta = fs::metadata(&abs).map_err(|e| {
        let (c, m) = explain_io(&e, &abs, false);
        ErrPayload { ok: false, code: c, error: m }
    })?;
    let data = fs::read(&abs).map_err(|e| {
        let (c, m) = explain_io(&e, &abs, false);
        ErrPayload { ok: false, code: c, error: m }
    })?;
    Ok(ReadFileResult {
        ok: true,
        file: FileItem {
            path: abs.display().to_string(),
            name: abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            size: meta.len(),
            data: B64.encode(&data),
        },
    })
}

/// 保存到指定路径（对应 file:save）
#[tauri::command]
fn save(args: SaveArgs) -> Result<SaveResult, ErrPayload> {
    let abs = abs_path(&args.path);
    if let Some(dir) = abs.parent() {
        if let Err(e) = fs::create_dir_all(dir) {
            let (c, m) = explain_io(&e, &abs, false);
            return err(&c, m);
        }
    }
    let data = decode_b64(&args.data)?;
    write_file_safe(&abs, &data, args.unlock)
}

#[derive(Serialize)]
struct StatResult {
    ok: bool,
    stat: StatInfo,
}

#[derive(Serialize)]
struct StatInfo {
    path: String,
    name: String,
    size: u64,
    created: u64,
    modified: u64,
    accessed: u64,
}

fn ms_of(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 取文件创建 / 修改时间（对应 file:stat）
#[tauri::command]
fn stat(path: String) -> Result<StatResult, ErrPayload> {
    let abs = abs_path(&path);
    let m = fs::metadata(&abs).map_err(|e| {
        let (c, msg) = explain_io(&e, &abs, false);
        ErrPayload { ok: false, code: c, error: msg }
    })?;
    Ok(StatResult {
        ok: true,
        stat: StatInfo {
            path: abs.display().to_string(),
            name: abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            size: m.len(),
            created: ms_of(m.created()),
            modified: ms_of(m.modified()),
            accessed: ms_of(m.accessed()),
        },
    })
}

/// 另存为（对应 file:saveAs）
#[tauri::command]
async fn save_as(window: Window, args: SaveAsArgs) -> Result<SaveAsResult, ErrPayload> {
    use tauri_plugin_dialog::DialogExt;
    let default = args.suggested_name.unwrap_or_else(|| "output.pdf".into());
    let picked = window
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(&default)
        .blocking_save_file();

    let path = match picked.and_then(|p| p.into_path().ok()) {
        Some(p) => p,
        None => {
            return Ok(SaveAsResult {
                ok: true,
                canceled: true,
                path: None,
                size: None,
                cleared_readonly: false,
            })
        }
    };
    if let Some(dir) = path.parent() {
        if let Err(e) = fs::create_dir_all(dir) {
            let (c, m) = explain_io(&e, &path, false);
            return err(&c, m);
        }
    }
    let data = decode_b64(&args.data)?;
    // 用户在对话框里已经确认过路径，这里直接允许解除只读
    let r = write_file_safe(&path, &data, true)?;
    Ok(SaveAsResult {
        ok: true,
        canceled: false,
        path: Some(r.path),
        size: Some(r.size),
        cleared_readonly: r.cleared_readonly,
    })
}

#[derive(Serialize)]
struct PickSaveResult {
    ok: bool,
    canceled: bool,
    path: Option<String>,
}

/// 选择保存位置（对应 dialog:pickSavePath）
#[tauri::command]
async fn pick_save_path(window: Window, args: PickSaveArgs) -> Result<PickSaveResult, ErrPayload> {
    use tauri_plugin_dialog::DialogExt;
    let default = args.suggested_name.unwrap_or_else(|| "output.pdf".into());
    let picked = window
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(&default)
        .blocking_save_file();
    match picked.and_then(|p| p.into_path().ok()) {
        Some(p) => Ok(PickSaveResult {
            ok: true,
            canceled: false,
            path: Some(p.display().to_string()),
        }),
        None => Ok(PickSaveResult {
            ok: true,
            canceled: true,
            path: None,
        }),
    }
}

/* ---------------- PDF IPC ---------------- */

#[derive(Deserialize)]
struct DataArgs {
    data: String,
}

#[derive(Serialize)]
struct InfoResult {
    ok: bool,
    info: InfoPayload,
}

#[derive(Serialize)]
struct InfoPayload {
    pages: usize,
    title: String,
    author: String,
    producer: String,
    version: String,
}

/// 文档信息（对应 pdf:info）
#[tauri::command]
fn pdf_info(args: DataArgs) -> Result<InfoResult, ErrPayload> {
    let bytes = decode_b64(&args.data)?;
    let (pages, title, author) =
        pdfops::pdf_info(&bytes).map_err(|e| ErrPayload { ok: false, code: "PDF".into(), error: e })?;
    let version = pdfops::doc_version(&bytes).unwrap_or_default();
    Ok(InfoResult {
        ok: true,
        info: InfoPayload {
            pages,
            title,
            author,
            producer: String::new(),
            version,
        },
    })
}

#[derive(Deserialize)]
struct OpArgs {
    op: String,
    data: String,
    /// 各操作的参数包（如 { pages: "2,4" } / { order: "3,1" } / { angle: 90 }）
    params: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct OpResult {
    ok: bool,
    data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<Vec<usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    appended: Option<Vec<usize>>,
}

fn jstr(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// 页面操作（对应 pdf:op）
#[tauri::command]
fn pdf_op(args: OpArgs) -> Result<OpResult, ErrPayload> {
    let bytes = decode_b64(&args.data)?;
    let a = args.params.unwrap_or(serde_json::Value::Null);
    let map = |e: String| ErrPayload { ok: false, code: "PDF".into(), error: e };

    match args.op.as_str() {
        "delete" => {
            let pages = jstr(&a, "pages").unwrap_or_default();
            let out = pdfops::delete_pages(&bytes, &pages).map_err(map)?;
            Ok(OpResult { ok: true, data: B64.encode(out), order: None, appended: None })
        }
        "reorder" => {
            let order = jstr(&a, "order").unwrap_or_default();
            let (out, o, rest) = pdfops::reorder_pages(&bytes, &order).map_err(map)?;
            Ok(OpResult {
                ok: true,
                data: B64.encode(out),
                order: Some(o),
                appended: Some(rest),
            })
        }
        "extract" => {
            let pages = jstr(&a, "pages").unwrap_or_default();
            let out = pdfops::extract_pages(&bytes, &pages).map_err(map)?;
            Ok(OpResult { ok: true, data: B64.encode(out), order: None, appended: None })
        }
        "rotate" => {
            let pages = jstr(&a, "pages").unwrap_or_else(|| "all".into());
            let angle = a.get("angle").and_then(|v| v.as_i64()).unwrap_or(0);
            let out = pdfops::rotate_pages(&bytes, &pages, angle).map_err(map)?;
            Ok(OpResult { ok: true, data: B64.encode(out), order: None, appended: None })
        }
        "insert" => {
            let at = jstr(&a, "at")
                .or_else(|| jstr(&a, "position"))
                .unwrap_or_else(|| "tail".into());
            let ins = jstr(&a, "insertPages");
            // 待插入内容可以来自内存（data）也可以来自磁盘（pdfPath）
            let add = match jstr(&a, "data") {
                Some(d) => decode_b64(&d)?,
                None => {
                    let p = jstr(&a, "pdfPath").unwrap_or_default();
                    let abs = abs_path(&p);
                    fs::read(&abs).map_err(|e| {
                        let (c, m) = explain_io(&e, &abs, false);
                        ErrPayload { ok: false, code: c, error: m }
                    })?
                }
            };
            let out = pdfops::insert_pdf(&bytes, &add, &at, ins.as_deref()).map_err(map)?;
            Ok(OpResult { ok: true, data: B64.encode(out), order: None, appended: None })
        }
        other => err("OP", format!("未知操作: {}", other)),
    }
}

/// 写剪贴板（对应 clipboard:write）
#[tauri::command]
fn copy_text(app: tauri::AppHandle, text: String) -> Result<serde_json::Value, ErrPayload> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| ErrPayload {
            ok: false,
            code: "CLIP".into(),
            error: format!("写剪贴板失败: {}", e),
        })?;
    Ok(serde_json::json!({ "ok": true }))
}

/// 在资源管理器里显示文件（对应 shell:showItem）
#[tauri::command]
fn show_item(path: String) -> Result<serde_json::Value, ErrPayload> {
    let abs = abs_path(&path);
    #[cfg(target_os = "windows")]
    {
        let arg = if abs.is_dir() {
            abs.display().to_string()
        } else {
            format!("/select,{}", abs.display())
        };
        std::process::Command::new("explorer")
            .arg(arg)
            .spawn()
            .map_err(|e| ErrPayload {
                ok: false,
                code: "SHELL".into(),
                error: format!("无法打开资源管理器: {}", e),
            })?;
    }
    Ok(serde_json::json!({ "ok": true }))
}

/* ---------------- 自检支持 ---------------- */

/// 自检报告与临时目录（WebView2 拿不到 stdout，只能写文件）
fn selfcheck_path() -> PathBuf {
    std::env::temp_dir().join("pdfrev-tauri-selfcheck.txt")
}

/// 前端查询「是否自检模式」。
///
/// 不能用 window.eval 注入开关：前端为了还原「首次启动」状态会 location.reload()，
/// reload 后新 document 里那个全局变量就没了，自检会静默不跑（踩过）。
/// 改成前端每次加载都来问一句，reload 也照样能拿到。
#[tauri::command]
fn selfcheck_enabled(state: tauri::State<'_, SelfCheckFlag>) -> bool {
    state.0
}

/// 自检模式标记（在 run() 里从命令行参数读出来）
struct SelfCheckFlag(bool);

/// 自检脚本写一个临时 PDF 用的目录（顺手清掉上次的残留）
#[tauri::command]
fn selfcheck_dir() -> Result<String, ErrPayload> {
    let d = std::env::temp_dir().join("pdfrev-tauri-selfcheck");
    if d.exists() {
        let _ = fs::remove_dir_all(&d);
    }
    fs::create_dir_all(&d).map_err(|e| ErrPayload {
        ok: false,
        code: "IO".into(),
        error: format!("无法创建自检目录: {}", e),
    })?;
    Ok(d.display().to_string())
}

/// 把窗口置前（外部截屏脚本用；自检跑完想让界面留在最前面时调它）
#[tauri::command]
fn selfcheck_front(app: tauri::AppHandle) -> Result<String, ErrPayload> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| ErrPayload { ok: false, code: "SHOT".into(), error: "没有主窗口".into() })?;
    let _ = w.set_focus();
    let size = w.outer_size().map_err(|e| ErrPayload {
        ok: false,
        code: "SHOT".into(),
        error: format!("取窗口尺寸失败: {}", e),
    })?;
    Ok(format!("{}x{}", size.width, size.height))
}

/// 接收前端自检进度并落盘；`done` 为 true 时写结尾标记（供外部轮询判断跑完）
///
/// 写入策略：先写同目录下的临时文件再改名覆盖。
/// 外部的轮询脚本（tools/selfcheck.ps1）会反复读这个报告，直接 fs::write
/// 目标文件时两边会撞上，报 os error 32（另一个程序正在使用此文件）。
/// 改名是原子替换，读方要么看到旧版要么看到新版，不会看到半个文件。
#[tauri::command]
fn selfcheck_report(text: String, done: bool) -> Result<serde_json::Value, ErrPayload> {
    // 前端每出一条结论就落一次盘，这些调用是并发的；不加锁的话
    // 多个线程会同时写同一个临时文件，反而制造出新的 os error 32。
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let path = selfcheck_path();
    let tmp = path.with_extension("txt.tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| ErrPayload {
        ok: false,
        code: "IO".into(),
        error: format!("写自检报告失败: {}", e),
    })?;
    // 目标被占用时改名可能失败，重试几次（读方是毫秒级的一次读，很快就放开）
    let mut last = None;
    for _ in 0..10 {
        match fs::rename(&tmp, &path) {
            Ok(_) => {
                return Ok(serde_json::json!({ "ok": true, "done": done }));
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(ErrPayload {
        ok: false,
        code: "IO".into(),
        error: format!("写自检报告失败: {}", last.unwrap()),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // --selfcheck：让前端跑自检并把结果写文件（默认启动不受影响）
    let selfcheck = std::env::args().any(|a| a == "--selfcheck");
    if selfcheck {
        let _ = fs::remove_file(selfcheck_path());
    }

    tauri::Builder::default()
        .manage(SelfCheckFlag(selfcheck))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            open_pdf,
            read_file,
            save,
            save_as,
            pick_save_path,
            stat,
            pdf_info,
            pdf_op,
            copy_text,
            show_item,
            selfcheck_dir,
            selfcheck_report,
            selfcheck_enabled,
            selfcheck_front
        ])
        .setup(|app| {
            // 开发期把窗口显示出来（配置文件里 visible=false 避免白屏闪烁）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.eval("void 0;"); // 自检开关改由 selfcheck_enabled 命令提供
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PDFRev 启动失败");
}
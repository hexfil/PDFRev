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
///   { ok: true, ... }  或  { ok: false, code, error, ekey?, eargs? }
///
/// 关于多语言：Rust 侧不再生产「中文文案」，只给语言无关的
///   ekey  —— 稳定键（如 "io.eacces"），前端按当前界面语言翻译
///   eargs —— 占位符实参（如 { path: "C:\\a.pdf" }）
/// error 仍然保留，作为没有 ekey 时的原始兜底文本（老行为）。
/// 这样加语言只要改前端 src/i18n.js，不用动 Rust 也不用重编译。
#[derive(Serialize)]
struct ErrPayload {
    ok: bool,
    code: String,
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ekey: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eargs: Option<serde_json::Value>,
}

impl ErrPayload {
    /// 无翻译键的兜底错误（error 直接显示）
    fn raw(code: &str, msg: impl Into<String>) -> Self {
        ErrPayload {
            ok: false,
            code: code.to_string(),
            error: msg.into(),
            ekey: None,
            eargs: None,
        }
    }

    /// explain_io 出来的一组值 -> ErrPayload（ekey 为空则退化成 raw）
    fn keyed_or_raw(code: String, ekey: String, eargs: serde_json::Value, en: String) -> Self {
        if ekey.is_empty() {
            ErrPayload::raw(&code, en)
        } else {
            ErrPayload::keyed(&code, &ekey, eargs, en)
        }
    }

    /// 带翻译键的错误
    fn keyed(
        code: &str,
        ekey: &str,
        eargs: serde_json::Value,
        en: impl Into<String>,
    ) -> Self {
        ErrPayload {
            ok: false,
            code: code.to_string(),
            error: en.into(),
            ekey: Some(ekey.to_string()),
            eargs: Some(eargs),
        }
    }
}

/// 把 pdfops 的语言无关错误原样搬进 IPC 返回（键与实参一起给前端）
impl From<pdfops::PdfErr> for ErrPayload {
    fn from(e: pdfops::PdfErr) -> Self {
        ErrPayload {
            ok: false,
            code: "PDF".into(),
            error: e.describe(),
            ekey: Some(e.key),
            eargs: Some(e.args),
        }
    }
}


/// 没有 ekey 时前端会退回 error 原文，所以这里给一句能懂的英文兜底
fn err_keyed<T: Serialize>(
    code: &str,
    ekey: &str,
    eargs: serde_json::Value,
    en: &str,
) -> Result<T, ErrPayload> {
    Err(ErrPayload::keyed(code, ekey, eargs, en))
}

/// 把 std::io::Error 归类成语言无关的 (code, ekey, eargs, en)
/// （对应桌面版的 explainFsError；文案本身在前端 i18n 词典里）
fn explain_io(e: &std::io::Error, abs: &Path, adding: bool) -> (String, String, serde_json::Value, String) {
    let dir = abs
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let path = abs.display().to_string();
    let act = if adding { "create" } else { "saveTo" };
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => (
            "EACCES".into(),
            "io.eacces".into(),
            serde_json::json!({ "act": act, "path": path }),
            format!("no write permission, cannot {} {}", act, path),
        ),
        std::io::ErrorKind::NotFound => (
            "ENOENT".into(),
            "io.enotfound".into(),
            serde_json::json!({ "dir": dir }),
            format!("target directory does not exist: {}", dir),
        ),
        std::io::ErrorKind::AlreadyExists => (
            "ENOTDIR".into(),
            "io.enotdir".into(),
            serde_json::json!({ "path": path }),
            format!("invalid save path (a parent path is not a folder): {}", path),
        ),
        _ => {
            let raw = e.to_string();
            // Windows 上磁盘满 / 只读盘会走这里，按关键字兜一下
            if raw.contains("os error 112") {
                (
                    "ENOSPC".into(),
                    "io.enospc".into(),
                    serde_json::json!({}),
                    "not enough disk space to save".into(),
                )
            } else if raw.contains("os error 19") || raw.contains("os error 30") {
                (
                    "EROFS".into(),
                    "io.erofs".into(),
                    serde_json::json!({ "dir": dir }),
                    format!("the target disk is read-only, cannot write: {}", dir),
                )
            } else if raw.contains("os error 32") {
                (
                    "EBUSY".into(),
                    "io.ebusy".into(),
                    serde_json::json!({}),
                    "the file is in use by another program".into(),
                )
            } else {
                ("".into(), "".into(), serde_json::json!({}), raw)
            }
        }
    }
}

/// explain_io 之后统一造 ErrPayload（ekey 为空表示只能用原始文本）
fn io_err<T: Serialize>(
    code: &str,
    ekey: &str,
    eargs: serde_json::Value,
    en: &str,
) -> Result<T, ErrPayload> {
    if ekey.is_empty() {
        Err(ErrPayload::raw(code, en))
    } else {
        Err(ErrPayload::keyed(code, ekey, eargs, en))
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
            return err_keyed(
                "READONLY",
                "readonly.ask",
                serde_json::json!({ "path": abs.display().to_string() }),
                &format!("the file is read-only and cannot be overwritten: {}. Clear the read-only flag and overwrite?", abs.display()),
            );
        }
        match fs::metadata(abs) {
            Ok(m) => {
                let mut perm = m.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perm.set_readonly(false);
                if let Err(e) = fs::set_permissions(abs, perm) {
                    let (c, k, a, m) = explain_io(&e, abs, false);
                    return io_err(&c, &k, a, &m);
                }
                cleared = true;
            }
            Err(e) => {
                let (c, k, a, m) = explain_io(&e, abs, false);
                return io_err(&c, &k, a, &m);
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
        let (c, k, a, m) = explain_io(&e, abs, false);
        return io_err(&c, &k, a, &m);
    }
    if let Err(e) = fs::rename(&tmp, abs) {
        let _ = fs::remove_file(&tmp);
        let (c, k, a, m) = explain_io(&e, abs, false);
        return io_err(&c, &k, a, &m);
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
        .map_err(|e| {
            ErrPayload::keyed(
                "DECODE",
                "pdf.b64",
                serde_json::json!({ "msg": e.to_string() }),
                &format!("data decoding failed: {}", e),
            )
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
                let (c, k, a, m) = explain_io(&e, &path, false);
                return io_err(&c, &k, a, &m);
            }
        };
        let data = match fs::read(&path) {
            Ok(d) => d,
            Err(e) => {
                let (c, k, a, m) = explain_io(&e, &path, false);
                return io_err(&c, &k, a, &m);
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
        return err_keyed("ENOENT", "file.notfound", serde_json::json!({ "path": abs.display().to_string() }), &format!("file does not exist: {}", abs.display()));
    }
    let meta = fs::metadata(&abs).map_err(|e| {
        let (c, k, a, m) = explain_io(&e, &abs, false);
        ErrPayload::keyed_or_raw(c, k, a, m)
    })?;
    let data = fs::read(&abs).map_err(|e| {
        let (c, k, a, m) = explain_io(&e, &abs, false);
        ErrPayload::keyed_or_raw(c, k, a, m)
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
            let (c, k, a, m) = explain_io(&e, &abs, false);
            return io_err(&c, &k, a, &m);
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
        let (c, k, a, msg) = explain_io(&e, &abs, false);
        ErrPayload::keyed_or_raw(c, k, a, msg)
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
            let (c, k, a, m) = explain_io(&e, &path, false);
            return io_err(&c, &k, a, &m);
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
        pdfops::pdf_info(&bytes).map_err(ErrPayload::from)?;
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
    let map = ErrPayload::from;

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
                        let (c, k, a, m) = explain_io(&e, &abs, false);
                        ErrPayload::keyed_or_raw(c, k, a, m)
                    })?
                }
            };
            let out = pdfops::insert_pdf(&bytes, &add, &at, ins.as_deref()).map_err(map)?;
            Ok(OpResult { ok: true, data: B64.encode(out), order: None, appended: None })
        }
        other => err_keyed(
            "OP",
            "pdf.unknownOp",
            serde_json::json!({ "op": other }),
            &format!("unknown operation: {}", other),
        ),
    }
}

/// 写剪贴板（对应 clipboard:write）
#[tauri::command]
fn copy_text(app: tauri::AppHandle, text: String) -> Result<serde_json::Value, ErrPayload> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| {
            ErrPayload::keyed(
                "CLIP",
                "clip.fail",
                serde_json::json!({ "msg": e.to_string() }),
                &format!("failed to write to the clipboard: {}", e),
            )
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
            .map_err(|e| {
                ErrPayload::keyed(
                    "SHELL",
                    "shell.fail",
                    serde_json::json!({ "msg": e.to_string() }),
                    &format!("could not open File Explorer: {}", e),
                )
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
    fs::create_dir_all(&d).map_err(|e| {
        ErrPayload::keyed(
            "IO",
            "selfcheck.dir",
            serde_json::json!({ "msg": e.to_string() }),
            &format!("could not create the self-check directory: {}", e),
        )
    })?;
    Ok(d.display().to_string())
}

/// 设置原生窗口标题（界面语言切换时调；Rust 侧不做翻译，标题文本由前端给）
///
/// 为什么要绕一圈：`tauri.conf.json` 的 title 只在启动时生效，
/// 用户在界面里换语言后任务栏 / 标题栏还留着旧语言。前端调这个命令同步。
#[tauri::command]
fn set_window_title(app: tauri::AppHandle, title: String) -> Result<serde_json::Value, ErrPayload> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| ErrPayload::keyed("WIN", "app.noWindow", serde_json::json!({}), "no main window"))?;
    w.set_title(&title).map_err(|e| {
        ErrPayload::keyed(
            "WIN",
            "app.titleFail",
            serde_json::json!({ "msg": e.to_string() }),
            &format!("could not set the window title: {}", e),
        )
    })?;
    Ok(serde_json::json!({ "ok": true }))
}
/// 把窗口置前（外部截屏脚本用；自检跑完想让界面留在最前面时调它）
#[tauri::command]
fn selfcheck_front(app: tauri::AppHandle) -> Result<String, ErrPayload> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| ErrPayload::keyed("SHOT", "app.noWindow", serde_json::json!({}), "no main window"))?;
    let _ = w.set_focus();
    let size = w.outer_size().map_err(|e| {
        ErrPayload::keyed(
            "SHOT",
            "shot.size",
            serde_json::json!({ "msg": e.to_string() }),
            &format!("failed to get the window size: {}", e),
        )
    })?;
    Ok(format!("{}x{}", size.width, size.height))
}

/// 读回原生窗口标题（自检用）。
///
/// 为什么要专门开一个：`set_window_title` 只是「发出去了」，
/// 前端看不到操作系统的窗口属性到底改没改。自检里断言
/// 「窗口标题 === 当前语言的 app.title」才算真的验证了任务栏文案。
#[tauri::command]
fn selfcheck_window_title(app: tauri::AppHandle) -> Result<String, ErrPayload> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| ErrPayload::keyed("SHOT", "app.noWindow", serde_json::json!({}), "no main window"))?;
    w.title().map_err(|e| {
        ErrPayload::keyed(
            "SHOT",
            "selfcheck.title",
            serde_json::json!({ "msg": e.to_string() }),
            &format!("could not read the window title: {}", e),
        )
    })
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
    fs::write(&tmp, text.as_bytes()).map_err(|e| {
        ErrPayload::keyed(
            "IO",
            "selfcheck.write",
            serde_json::json!({ "msg": e.to_string() }),
            &format!("failed to write the self-check report: {}", e),
        )
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
    Err(ErrPayload::keyed(
        "IO",
        "selfcheck.write",
        serde_json::json!({ "msg": last.unwrap().to_string() }),
        "failed to write the self-check report",
    ))
}

/* ---------------- 版本号与命令行参数 ---------------- */

/// 版本号唯一来源：`src-tauri/Cargo.toml` 的 `version`。
///
/// 界面（版权页）和 `--version` 都读它，不再各写一份 —— 否则发版时
/// 很容易出现「exe 属性写 0.12.0，界面显示 0.1.0」这种不一致。
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 项目主页（版权页要显示、也要能点开）
pub const APP_REPO_URL: &str = "https://github.com/woxii88/PDFRev_Tauri";

/// 往控制台打一行字。
///
/// 为什么需要这个：`main.rs` 用了 `windows_subsystem = "windows"`（双击不弹黑框），
/// 代价是 GUI 子系统进程默认没有 stdout —— 直接 `println!` 会石沉大海。
/// 所以这里分两种情况：
///   1. stdout 已经有效（被重定向到文件 / 管道，或 debug 构建）→ 照常写；
///   2. 否则附着到父进程的控制台，写给 `CONOUT$`。
/// 不引入 windows-sys 依赖：只用到 kernel32 的两个函数，本地声明即可。
#[cfg(windows)]
fn console_out(text: &str) {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
        fn GetStdHandle(n_std_handle: u32) -> isize;
        fn WriteFile(
            h_file: isize,
            lp_buffer: *const u8,
            n_number_of_bytes_to_write: u32,
            lp_number_of_bytes_written: *mut u32,
            lp_overlapped: *mut core::ffi::c_void,
        ) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // (DWORD)-11
    const INVALID_HANDLE_VALUE: isize = -1;

    let mut line = String::from(text);
    if !line.ends_with('\n') {
        line.push('\n');
    }
    let bytes = line.as_bytes();

    // 关键是直接用 WriteFile 写句柄，而不是走 std::io::stdout()：
    // PowerShell 捕获输出时给的是管道句柄，Rust 那套缓冲/控制台探测在这种
    // 组合下会写成空（实测 `$v = & PDFRev.exe --version` 拿不到东西），
    // 裸 WriteFile 对「控制台 / 管道 / 重定向到文件」三种情况都成立。
    let mut handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if handle == 0 || handle == INVALID_HANDLE_VALUE {
        // GUI 子系统进程默认没有控制台，附着到父进程的（从 cmd 里跑就是这种情况）
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
        handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    }
    if handle == 0 || handle == INVALID_HANDLE_VALUE {
        // 最后兜底：直接开 CONOUT$（纯双击场景其实不会走到这里，参数分支不会进）
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
            use std::io::Write;
            let _ = f.write_all(bytes);
            let _ = f.flush();
        }
        return;
    }

    let mut written: u32 = 0;
    unsafe {
        WriteFile(
            handle,
            bytes.as_ptr(),
            bytes.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        );
    }
}
#[cfg(not(windows))]
fn console_out(text: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stdout(), "{}", text);
}

/// `--version` 的输出文本
fn version_text() -> String {
    format!("PDFRev {} ({})", APP_VERSION, APP_REPO_URL)
}

/// `--help` 的输出文本
///
/// 说明清楚：这个 exe 的正文功能都在图形界面里，命令行只提供版本/帮助 ——
/// 真正改 PDF 的命令行是 Electron 版那条 `pdfrev` 命令（见界面里的「命令行等价」）。
fn help_text() -> String {
    format!(
        "PDFRev {} - PDF page editor (Tauri 2)\n\
         \n\
         Usage:\n\
         \x20 PDFRev.exe                  launch the GUI\n\
         \x20 PDFRev.exe --version, -V    print the version and exit\n\
         \x20 PDFRev.exe --help,    -h    print this help and exit\n\
         \x20 PDFRev.exe --selfcheck     run the built-in UI self-check\n\
         \n\
         All editing happens in the GUI.  The equivalent pdfrev commands for\n\
         whatever you do are shown in the \"Command line equivalent\" panel.\n\
         \n\
         Repository: {}",
        APP_VERSION, APP_REPO_URL
    )
}

/// 版本号（版权页显示用）
#[tauri::command]
fn app_version() -> String {
    APP_VERSION.to_string()
}

/// 项目主页地址（版权页显示用）
#[tauri::command]
fn app_repo_url() -> String {
    APP_REPO_URL.to_string()
}

/// 用系统默认浏览器打开链接。
///
/// 不用 tauri-plugin-shell / opener：这里只需要「在默认浏览器里打开一个 https 地址」，
/// 走 `rundll32 url.dll,FileProtocolHandler` 是 Windows 上最标准的做法，
/// 而且不用多装一个 crate（和已有的 `show_item` 用 explorer 是同一个思路）。
///
/// 只放行 http/https —— 这个命令被前端调用，不能让它变成任意程序启动器。
#[tauri::command]
fn open_url(url: String) -> Result<serde_json::Value, ErrPayload> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ErrPayload::keyed(
            "URL",
            "app.badUrl",
            serde_json::json!({ "url": url }),
            "only http/https links can be opened",
        ));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| {
                ErrPayload::keyed(
                    "URL",
                    "app.openUrlFail",
                    serde_json::json!({ "msg": e.to_string() }),
                    &format!("could not open the link: {}", e),
                )
            })?;
    }
    Ok(serde_json::json!({ "ok": true }))
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 纯命令行参数（--version / --help）在起窗口之前就处理掉并退出，
    // 否则会「弹一下窗口再退出」，脚本里很难用。
    for a in std::env::args().skip(1) {
        match a.as_str() {
            "--version" | "-V" => {
                console_out(&version_text());
                return;
            }
            "--help" | "-h" => {
                console_out(&help_text());
                return;
            }
            _ => {}
        }
    }

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
            selfcheck_front,
            selfcheck_window_title,
            set_window_title,
            app_version,
            app_repo_url,
            open_url
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
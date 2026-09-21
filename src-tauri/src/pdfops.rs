//! PDF 页面操作核心（对应桌面版的 `src/pdfops.js`）。
//!
//! 全部函数以 `Vec<u8>` 进出，便于走 IPC 传递。
//! 用 lopdf 重建文档，保留来源 PDF 的 Title / Author / Subject / Keywords / Creator。

use lopdf::{dictionary, Document, Object, ObjectId, StringFormat};

/// 页码表达式解析成功的统一错误类型（映射成前端能看的字符串）
pub type Res<T> = Result<T, String>;

/// 生成 [a, b] 的整数数组
fn range(a: usize, b: usize) -> Vec<usize> {
    (a..=b).collect()
}

fn check_page(n: usize, total: usize) -> Res<usize> {
    if n < 1 || n > total {
        return Err(format!("页码 {} 超出范围（文档共 {} 页）", n, total));
    }
    Ok(n)
}

/// 把用户输入里的全角标点、空白统一成半角分隔符，便于后续按分隔符切分
fn normalize_seps(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '，' | '、' => ',',
            '；' => ';',
            '～' | '—' => '~',
            _ => c,
        })
        .collect()
}

/// 是不是「全部页」的写法
fn is_all(s: &str) -> bool {
    let l = s.to_lowercase();
    l == "all" || l == "*" || s == "全部"
}

/// 是不是「结束 / 末页」的写法
fn is_end_word(s: &str) -> bool {
    let l = s.to_lowercase();
    l == "end" || l == "last" || s == "末" || s == "最后"
}

/// 尝试把 `a-b` 形式拆成两端；`sep` 允许 `-` `~` `至` `到`
fn split_pair(s: &str) -> Option<(String, String)> {
    for sep in ["-", "~", "至", "到"] {
        if let Some(i) = s.find(sep) {
            let (a, b) = s.split_at(i);
            let b = &b[sep.len()..];
            if !a.is_empty() && !b.is_empty() {
                return Some((a.trim().to_string(), b.trim().to_string()));
            }
        }
    }
    None
}

fn parse_usize(s: &str) -> Option<usize> {
    let t = s.trim();
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse::<usize>().ok()
}

/// 解析页码表达式 -> 升序去重的 1 基页码数组（对应 parsePageSpec）
pub fn parse_page_spec(spec: &str, total: usize) -> Res<Vec<usize>> {
    let raw = spec.trim();
    if raw.is_empty() {
        return Err("页码参数为空".into());
    }
    if is_all(raw) {
        return Ok(range(1, total));
    }

    let norm = normalize_seps(raw);
    let mut out: Vec<usize> = Vec::new();
    for piece in norm.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let p = piece.trim();
        if p.is_empty() {
            continue;
        }
        if let Some((a, b)) = split_pair(p) {
            if is_end_word(&b) {
                let a = parse_usize(&a).ok_or_else(|| format!("无法识别的页码写法: \"{}\"", p))?;
                out.extend(range(a, total));
                continue;
            }
            let (mut a, mut b) = match (parse_usize(&a), parse_usize(&b)) {
                (Some(a), Some(b)) => (a, b),
                _ => return Err(format!("无法识别的页码写法: \"{}\"", p)),
            };
            if a > b {
                std::mem::swap(&mut a, &mut b);
            }
            out.extend(range(a, b));
            continue;
        }
        match parse_usize(p) {
            Some(n) => out.push(n),
            None => return Err(format!("无法识别的页码写法: \"{}\"", p)),
        }
    }

    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        return Err("页码参数没有解析出任何页".into());
    }
    for n in &out {
        check_page(*n, total)?;
    }
    Ok(out)
}

/// 解析顺序表达式 -> 保持书写顺序的 1 基页码数组（对应 parseOrderSpec）
pub fn parse_order_spec(spec: &str, total: usize) -> Res<Vec<usize>> {
    let raw = spec.trim();
    if raw.is_empty() {
        return Err("页码参数为空".into());
    }
    if is_all(raw) {
        return Ok(range(1, total));
    }

    let norm = normalize_seps(raw);
    let mut out: Vec<usize> = Vec::new();
    let push = |n: usize, out: &mut Vec<usize>| {
        if !out.contains(&n) {
            out.push(n);
        }
    };

    for piece in norm.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let p = piece.trim();
        if p.is_empty() {
            continue;
        }
        if let Some((a, b)) = split_pair(p) {
            if is_end_word(&b) {
                let a = parse_usize(&a).ok_or_else(|| format!("无法识别的页码写法: \"{}\"", p))?;
                for n in range(a, total) {
                    push(n, &mut out);
                }
                continue;
            }
            let (a, b) = match (parse_usize(&a), parse_usize(&b)) {
                (Some(a), Some(b)) => (a, b),
                _ => return Err(format!("无法识别的页码写法: \"{}\"", p)),
            };
            // 与桌面版一致：允许降序范围（5-3 得到 5,4,3）
            if a <= b {
                for n in a..=b {
                    push(n, &mut out);
                }
            } else {
                for n in (b..=a).rev() {
                    push(n, &mut out);
                }
            }
            continue;
        }
        match parse_usize(p) {
            Some(n) => push(n, &mut out),
            None => return Err(format!("无法识别的页码写法: \"{}\"", p)),
        }
    }

    if out.is_empty() {
        return Err("页码参数没有解析出任何页".into());
    }
    for n in &out {
        check_page(*n, total)?;
    }
    Ok(out)
}

/// 插入位置
#[derive(Debug, Clone, PartialEq)]
pub enum Position {
    Head,
    Tail,
    Before(usize),
    After(usize),
}

/// 解析插入位置：head / tail / before:3 / after:4（对应 parsePosition）
pub fn parse_position(pos: &str, total: usize) -> Res<Position> {
    let s = pos.trim();
    if s.is_empty() {
        return Err("缺少插入位置".into());
    }
    let l = s.to_lowercase();
    if l == "head" || l == "top" || s == "首页" || s == "开头" {
        return Ok(Position::Head);
    }
    if l == "tail" || l == "end" || s == "尾页" || s == "末尾" || s == "最后" {
        return Ok(Position::Tail);
    }
    // before:3 / 前3 / 第3页前
    for (kw, is_before) in [("before", true), ("after", false), ("前", true), ("后", false)] {
        if let Some(rest) = l.strip_prefix(kw).or_else(|| {
            if kw == "前" || kw == "后" {
                s.strip_prefix(kw)
            } else {
                None
            }
        }) {
            let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
            if let Some(n) = parse_usize(&digits) {
                let n = check_page(n, total)?;
                return Ok(if is_before { Position::Before(n) } else { Position::After(n) });
            }
        }
    }
    if parse_usize(s).is_some() {
        return Err(format!("位置 \"{}\" 有歧义，请写成 before:{} 或 after:{}", s, s, s));
    }
    Err(format!("无法识别的插入位置: \"{}\"", s))
}

/* ---------------- 文档读写 ---------------- */

/// 载入 PDF；失败时给出可读的中文提示
pub fn load_doc(bytes: &[u8], label: &str) -> Res<Document> {
    Document::load_mem(bytes).map_err(|e| {
        format!(
            "{} 无法解析（可能是加密或损坏文件）: {}",
            label, e
        )
    })
}

/// 文档页数
pub fn page_count(doc: &Document) -> usize {
    doc.get_pages().len()
}

/// 当前文档的 1 基页码 -> ObjectId 映射（按页码升序）
fn pages_sorted(doc: &Document) -> Vec<ObjectId> {
    let mut v: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    v.sort_by_key(|(n, _)| *n);
    v.into_iter().map(|(_, id)| id).collect()
}

/// 把 PDF 里的字符串字节解成 Rust String。
///
/// PDF 元数据的字符串有三种常见形态，必须都认：
///   1. UTF-16BE 带 BOM（FE FF）—— 中文标题最常见；
///   2. UTF-16BE 不带 BOM —— 有些生成器（如扫描仪软件）会这样写，
///      只能靠「偶数长度 + 奇数位大量 0x00」来判断；
///   3. 单字节 PDFDocEncoding / ASCII —— 直接按 UTF-8 宽松解。
///
/// 不处理的话中文标题会显示成 `EMMS~…` 这样的乱码。
fn decode_pdf_string(b: &[u8]) -> String {
    if b.len() >= 2 && b[0] == 0xFE && b[1] == 0xFF {
        return utf16_to_string(&b[2..], true);
    }
    if b.len() >= 2 && b[0] == 0xFF && b[1] == 0xFE {
        return utf16_to_string(&b[2..], false);
    }
    // 无 BOM：偶数长度且奇数位基本是 0，按 UTF-16BE 处理
    if b.len() >= 4 && b.len() % 2 == 0 {
        let zeros = b.iter().skip(1).step_by(2).filter(|c| **c == 0).count();
        if zeros * 2 >= b.len() / 2 {
            return utf16_to_string(b, true);
        }
    }
    String::from_utf8_lossy(b).to_string()
}

fn utf16_to_string(b: &[u8], big_endian: bool) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|c| {
            if big_endian {
                u16::from_be_bytes([c[0], c[1]])
            } else {
                u16::from_le_bytes([c[0], c[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// 取字符串型元数据（容错：拿不到就返回空）
fn meta_str(doc: &Document, key: &[u8]) -> Option<String> {
    let info = doc.trailer.get(b"Info").ok().and_then(|o| doc.dereference(o).ok())?;
    let dict = info.1.as_dict().ok()?;
    let obj = dict.get(key).ok()?;
    let s = match obj {
        Object::String(b, _) => decode_pdf_string(b),
        _ => return None,
    };
    // 去掉 PDF 字符串可能带的尾部 NUL
    let s = s.trim_end_matches('\0').trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 写元数据时统一用 UTF-16BE + BOM，保证中文在任何阅读器里都正常
fn pdf_string(s: &str) -> Object {
    let mut v = vec![0xFEu8, 0xFF];
    for u in s.encode_utf16() {
        v.extend_from_slice(&u.to_be_bytes());
    }
    Object::String(v, StringFormat::Literal)
}

/// 生成 Info 字典：带上来源文档的元数据（对应 copyMeta）
fn build_info(src: &Document) -> Object {
    let mut d = dictionary! {};
    for (k, key) in [
        (b"Title".as_slice(), b"Title".as_slice()),
        (b"Author".as_slice(), b"Author".as_slice()),
        (b"Subject".as_slice(), b"Subject".as_slice()),
        (b"Keywords".as_slice(), b"Keywords".as_slice()),
    ] {
        if let Some(v) = meta_str(src, key) {
            d.set(k.to_vec(), pdf_string(&v));
        }
    }
    // Creator：来源有就透传，没有则标记为 PDFRev
    let creator = meta_str(src, b"Creator").unwrap_or_else(|| "PDFRev".to_string());
    d.set(b"Creator".to_vec(), pdf_string(&creator));
    Object::Dictionary(d)
}

/// 按给定 1 基页码顺序重建文档（对应 rebuild）
fn rebuild(src: &Document, order: &[usize]) -> Res<Document> {
    let mut out = Document::with_version("1.5");
    let src_pages = pages_sorted(src);
    let mut ids: Vec<ObjectId> = Vec::with_capacity(order.len());
    for n in order {
        let id = *src_pages
            .get(n - 1)
            .ok_or_else(|| format!("页码 {} 超出范围（文档共 {} 页）", n, src_pages.len()))?;
        ids.push(id);
    }
    // 深拷贝页面及其引用到的资源，避免两个文档共享对象编号导致内容错乱
    out.objects = src.objects.clone();
    out.max_id = src.max_id;
    let _ = ids;

    // 重建页面树：所有页做成扁平的孩子列表
    let pages_id = out.new_object_id();
    let mut kids: Vec<Object> = Vec::new();
    for n in order {
        let old = *src_pages.get(n - 1).unwrap();
        let mut page = out
            .get_object(old)
            .and_then(|o| o.as_dict())
            .cloned()
            .map_err(|e| format!("读取页面对象失败: {}", e))?;
        // 页面对象放进新文档时统一给新编号，避免和旧文档的编号体系冲突
        let new_id = out.new_object_id();
        page.set("Parent", Object::Reference(pages_id));
        out.set_object(new_id, Object::Dictionary(page));
        kids.push(Object::Reference(new_id));
    }

    let count = kids.len() as i64;
    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Count" => count,
        "Kids" => Object::Array(kids),
    };
    out.set_object(pages_id, Object::Dictionary(pages_dict));

    // Root 必须是「引用」，lopdf 的 catalog() 只会沿着 Reference 走
    let root_id = out.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    out.trailer.set("Root", Object::Reference(root_id));
    out.trailer.set("Info", build_info(src));
    Ok(out)
}

/// 序列化（对应 toBytes：不用对象流，便于外部工具读取）
fn to_bytes(mut doc: Document) -> Res<Vec<u8>> {
    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| format!("生成 PDF 失败: {}", e))?;
    Ok(buf)
}

/* ---------------- 页面操作 ---------------- */

/// 删除页面（对应 deletePages）
pub fn delete_pages(base: &[u8], spec: &str) -> Res<Vec<u8>> {
    let src = load_doc(base, "PDF")?;
    let total = page_count(&src);
    let del = parse_page_spec(spec, total)?;
    let keep: Vec<usize> = range(1, total).into_iter().filter(|n| !del.contains(n)).collect();
    if keep.is_empty() {
        return Err("不能删除全部页面，结果 PDF 会没有任何页".into());
    }
    to_bytes(rebuild(&src, &keep)?)
}

/// 重新排序；未列出的页自动追加到末尾（对应 reorderPages）
pub fn reorder_pages(base: &[u8], spec: &str) -> Res<(Vec<u8>, Vec<usize>, Vec<usize>)> {
    let src = load_doc(base, "PDF")?;
    let total = page_count(&src);
    let given = parse_order_spec(spec, total)?;
    if given.len() < 2 {
        return Err("排序至少需要 2 页".into());
    }
    let rest: Vec<usize> = range(1, total)
        .into_iter()
        .filter(|n| !given.contains(n))
        .collect();
    let order: Vec<usize> = given.iter().copied().chain(rest.iter().copied()).collect();
    let bytes = to_bytes(rebuild(&src, &order)?)?;
    Ok((bytes, order, rest))
}

/// 提取指定页为新 PDF（对应 extractPages）
pub fn extract_pages(base: &[u8], spec: &str) -> Res<Vec<u8>> {
    let src = load_doc(base, "PDF")?;
    let total = page_count(&src);
    let pages = parse_page_spec(spec, total)?;
    to_bytes(rebuild(&src, &pages)?)
}

/// 旋转页面：相对当前角度累加（对应 rotatePages）
pub fn rotate_pages(base: &[u8], spec: &str, angle: i64) -> Res<Vec<u8>> {
    let a = ((angle % 360) + 360) % 360;
    if a != 90 && a != 180 && a != 270 {
        return Err("旋转角度只能是 90 / 180 / 270".into());
    }
    let src = load_doc(base, "PDF")?;
    let total = page_count(&src);
    let set = parse_page_spec(spec, total)?;
    let all = range(1, total);
    let mut out = rebuild(&src, &all)?;

    // rebuild 之后页码顺序与 all 一一对应，直接按序改 Rotation
    let ids = pages_sorted(&out);
    for (i, id) in ids.iter().enumerate() {
        if !set.contains(&(i + 1)) {
            continue;
        }
        let cur = out
            .get_object(*id)
            .and_then(|o| o.as_dict())
            .ok()
            .and_then(|d| d.get(b"Rotate").ok())
            .and_then(|o| o.as_i64().ok())
            .unwrap_or(0);
        let next = (((cur + a) % 360) + 360) % 360;
        if let Ok(dict) = out.get_object_mut(*id).and_then(|o| o.as_dict_mut()) {
            dict.set("Rotate", next);
        }
    }
    to_bytes(out)
}

/// 插入另一个 PDF 到指定位置（对应 insertPdf）
pub fn insert_pdf(base: &[u8], add: &[u8], pos: &str, insert_pages: Option<&str>) -> Res<Vec<u8>> {
    let src = load_doc(base, "目标 PDF")?;
    let ins = load_doc(add, "待插入 PDF")?;
    let total = page_count(&src);
    let position = parse_position(pos, total)?;

    let add_total = page_count(&ins);
    let pick: Vec<usize> = match insert_pages {
        Some(s) if !s.trim().is_empty() => parse_page_spec(s, add_total)?,
        _ => range(1, add_total),
    };
    if pick.is_empty() {
        return Err("待插入 PDF 没有可插入的页".into());
    }

    // 目标文档先整体重建，再把待插页按顺序拼进去
    let base_all = range(1, total);
    let mut out = rebuild(&src, &base_all)?;

    // 把插入文档的页面对象拷进 out（新编号），并记录顺序
    let add_pages = pages_sorted(&ins);
    let mut add_ids: Vec<ObjectId> = Vec::new();
    for n in &pick {
        let old = *add_pages
            .get(n - 1)
            .ok_or_else(|| format!("页码 {} 超出范围（文档共 {} 页）", n, add_pages.len()))?;
        let mut page = ins
            .get_object(old)
            .and_then(|o| o.as_dict())
            .cloned()
            .map_err(|e| format!("读取待插入页面失败: {}", e))?;
        // 插入页引用到的资源（字体、图片、内容流）也要一起带过来
        copy_referenced(&ins, &mut out, &mut page)?;
        let new_id = out.new_object_id();
        out.set_object(new_id, Object::Dictionary(page));
        add_ids.push(new_id);
    }

    // 找到页面树，按位置把新页插进 Kids
    // trailer.get 返回 Result，逐级手动拆开，避免 Option / Result 混用
    let pages_id = match out.trailer.get(b"Root").and_then(|o| o.as_reference()) {
        Ok(root) => {
            let pages_ref = out
                .get_object(root)
                .and_then(|o| o.as_dict())
                .and_then(|d| d.get(b"Pages"))
                .and_then(|o| o.as_reference());
            match pages_ref {
                Ok(id) => id,
                Err(_) => return Err("重建后的 PDF 缺少页面树".into()),
            }
        }
        Err(_) => return Err("重建后的 PDF 缺少 Catalog".into()),
    };

    let mut kids: Vec<Object> = out
        .get_object(pages_id)
        .and_then(|o| o.as_dict())
        .ok()
        .and_then(|d| d.get(b"Kids").ok())
        .and_then(|o| o.as_array().ok())
        .cloned()
        .unwrap_or_default();

    let at = match position {
        Position::Head => 0,
        Position::Tail => kids.len(),
        Position::Before(p) => p - 1,
        Position::After(p) => p,
    };
    let at = at.min(kids.len());
    for (i, id) in add_ids.iter().enumerate() {
        kids.insert(at + i, Object::Reference(*id));
    }

    let count = kids.len() as i64;
    if let Ok(dict) = out.get_object_mut(pages_id).and_then(|o| o.as_dict_mut()) {
        dict.set("Kids", Object::Array(kids));
        dict.set("Count", count);
    }
    to_bytes(out)
}

/// 把一个页面字典里引用到的对象也复制到目标文档（递归一层，够覆盖常见 PDF）
fn copy_referenced(src: &Document, dst: &mut Document, page: &mut lopdf::Dictionary) -> Res<()> {
    let ids: Vec<ObjectId> = page
        .iter()
        .filter_map(|(_, v)| v.as_reference().ok())
        .collect();
    for id in ids {
        if let Ok(obj) = src.get_object(id) {
            let obj = obj.clone();
            if dst.get_object(id).is_err() {
                dst.objects.insert(id, obj);
                if id.0 > dst.max_id {
                    dst.max_id = id.0;
                }
            }
        }
    }
    Ok(())
}

/// 文档信息（对应 pdfInfo）
pub fn pdf_info(bytes: &[u8]) -> Res<(usize, String, String)> {
    let doc = load_doc(bytes, "PDF")?;
    let pages = page_count(&doc);
    let title = meta_str(&doc, b"Title").unwrap_or_default();
    let author = meta_str(&doc, b"Author").unwrap_or_default();
    Ok((pages, title, author))
}

/// 文档版本号（顶栏展示用，便于确认 lopdf 真读到了文件）
pub fn doc_version(bytes: &[u8]) -> Res<String> {
    let doc = load_doc(bytes, "PDF")?;
    Ok(doc.version.clone())
}
/* ---------------- 单元测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成一个 n 页的测试 PDF（每页写上 P1 / P2 …，便于按内容校验页序）
    pub fn make_pdf(n: usize) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        // 用内置的 Helvetica 字体，避免嵌入任何外部文件
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources = dictionary! {
            "Font" => dictionary! { "F1" => Object::Reference(font_id) },
        };
        let mut kids: Vec<Object> = Vec::new();
        for i in 1..=n {
            let content = format!("BT /F1 32 Tf 40 700 Td (PAGE {}) Tj ET", i);
            let cid = doc.add_object(lopdf::Stream::new(dictionary! {}, content.into_bytes()));
            let pid = doc.new_object_id();
            doc.set_object(
                pid,
                dictionary! {
                    "Type" => "Page",
                    "Parent" => Object::Reference(pages_id),
                    "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                    "Resources" => resources.clone(),
                    "Contents" => Object::Reference(cid),
                },
            );
            kids.push(Object::Reference(pid));
        }
        let count = kids.len() as i64;
        doc.set_object(
            pages_id,
            dictionary! {
                "Type" => "Pages",
                "Count" => count,
                "Kids" => Object::Array(kids),
            },
        );
        let root = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", root);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    /// 读出每页内容流里的 PAGE 编号，用来验证页序
    pub fn page_seq(bytes: &[u8]) -> Vec<String> {
        let doc = Document::load_mem(bytes).unwrap();
        let ids = pages_sorted(&doc);
        ids.iter()
            .map(|id| {
                let content = doc.get_page_content(*id);
                let s = String::from_utf8_lossy(&content).to_string();
                let i = s.find("PAGE ").map(|k| k + 5).unwrap_or(0);
                let rest = &s[i.min(s.len())..];
                let d: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                d
            })
            .collect()
    }

    #[test]
    fn parse_page_spec_basic() {
        assert_eq!(parse_page_spec("2", 10).unwrap(), vec![2]);
        assert_eq!(parse_page_spec("3,5,8", 10).unwrap(), vec![3, 5, 8]);
        assert_eq!(parse_page_spec("3-5", 10).unwrap(), vec![3, 4, 5]);
        assert_eq!(parse_page_spec("5,3,3", 10).unwrap(), vec![3, 5]);
        assert_eq!(parse_page_spec("7-end", 9).unwrap(), vec![7, 8, 9]);
        assert_eq!(parse_page_spec("all", 3).unwrap(), vec![1, 2, 3]);
        // 中文写法
        assert_eq!(parse_page_spec("3至5", 10).unwrap(), vec![3, 4, 5]);
        assert_eq!(parse_page_spec("3，5", 10).unwrap(), vec![3, 5]);
    }

    #[test]
    fn parse_page_spec_errors() {
        assert!(parse_page_spec("99", 5).unwrap_err().contains("超出范围"));
        assert!(parse_page_spec("abc", 5).unwrap_err().contains("无法识别"));
        assert!(parse_page_spec("", 5).is_err());
    }

    #[test]
    fn parse_order_spec_keeps_written_order() {
        assert_eq!(parse_order_spec("3,1,2", 6).unwrap(), vec![3, 1, 2]);
        assert_eq!(parse_order_spec("5-3", 6).unwrap(), vec![5, 4, 3]);
        assert_eq!(parse_order_spec("2,2,3", 6).unwrap(), vec![2, 3]);
    }

    #[test]
    fn parse_position_variants() {
        assert_eq!(parse_position("head", 5).unwrap(), Position::Head);
        assert_eq!(parse_position("尾页", 5).unwrap(), Position::Tail);
        assert_eq!(parse_position("before:3", 5).unwrap(), Position::Before(3));
        assert_eq!(parse_position("after:4", 5).unwrap(), Position::After(4));
        assert!(parse_position("3", 5).unwrap_err().contains("歧义"));
    }

    #[test]
    fn delete_keeps_expected_pages() {
        let pdf = make_pdf(6);
        let out = delete_pages(&pdf, "2,4").unwrap();
        assert_eq!(page_seq(&out), vec!["1", "3", "5", "6"]);
    }

    #[test]
    fn delete_all_is_rejected() {
        let pdf = make_pdf(3);
        assert!(delete_pages(&pdf, "all").unwrap_err().contains("不能删除全部页面"));
    }

    #[test]
    fn reorder_appends_unlisted() {
        let pdf = make_pdf(5);
        let (out, order, rest) = reorder_pages(&pdf, "3,1").unwrap();
        assert_eq!(order, vec![3, 1, 2, 4, 5]);
        assert_eq!(rest, vec![2, 4, 5]);
        assert_eq!(page_seq(&out), vec!["3", "1", "2", "4", "5"]);
    }

    #[test]
    fn extract_picks_pages() {
        let pdf = make_pdf(5);
        let out = extract_pages(&pdf, "2,4").unwrap();
        assert_eq!(page_seq(&out), vec!["2", "4"]);
    }

    #[test]
    fn rotate_accumulates() {
        let pdf = make_pdf(3);
        let out = rotate_pages(&pdf, "1,3", 90).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let ids = pages_sorted(&doc);
        let rot = |i: usize| -> i64 {
            doc.get_object(ids[i])
                .and_then(|o| o.as_dict())
                .ok()
                .and_then(|d| d.get(b"Rotate").ok())
                .and_then(|o| o.as_i64().ok())
                .unwrap_or(0)
        };
        assert_eq!(rot(0), 90);
        assert_eq!(rot(1), 0);
        assert_eq!(rot(2), 90);
        // 再转 270 应该回到 0
        let out2 = rotate_pages(&out, "1", 270).unwrap();
        let doc2 = Document::load_mem(&out2).unwrap();
        let ids2 = pages_sorted(&doc2);
        let r = doc2
            .get_object(ids2[0])
            .and_then(|o| o.as_dict())
            .ok()
            .and_then(|d| d.get(b"Rotate").ok())
            .and_then(|o| o.as_i64().ok())
            .unwrap_or(0);
        assert_eq!(r, 0);
    }

    #[test]
    fn rotate_rejects_bad_angle() {
        let pdf = make_pdf(2);
        assert!(rotate_pages(&pdf, "1", 45).is_err());
    }

    #[test]
    fn insert_at_positions() {
        let base = make_pdf(4);
        let add = make_pdf(2);

        let head = insert_pdf(&base, &add, "head", None).unwrap();
        assert_eq!(page_seq(&head), vec!["1", "2", "1", "2", "3", "4"]);

        let tail = insert_pdf(&base, &add, "tail", None).unwrap();
        assert_eq!(page_seq(&tail), vec!["1", "2", "3", "4", "1", "2"]);

        let before = insert_pdf(&base, &add, "before:3", None).unwrap();
        assert_eq!(page_seq(&before), vec!["1", "2", "1", "2", "3", "4"]);

        let after = insert_pdf(&base, &add, "after:1", None).unwrap();
        assert_eq!(page_seq(&after), vec!["1", "1", "2", "2", "3", "4"]);

        // 只插入一部分页
        let partial = insert_pdf(&base, &add, "tail", Some("2")).unwrap();
        assert_eq!(page_seq(&partial), vec!["1", "2", "3", "4", "2"]);
    }

    #[test]
    fn metadata_is_preserved() {
        let pdf = make_pdf(3);
        // 先给源文档写上 Title / Author
        let mut doc = Document::load_mem(&pdf).unwrap();
        doc.trailer.set(
            "Info",
            dictionary! {
                "Title" => Object::String("保留我".as_bytes().to_vec(), StringFormat::Literal),
                "Author" => Object::String("作者A".as_bytes().to_vec(), StringFormat::Literal),
                "Creator" => Object::String("我的扫描仪".as_bytes().to_vec(), StringFormat::Literal),
            },
        );
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();

        let out = delete_pages(&buf, "2").unwrap();
        let got = Document::load_mem(&out).unwrap();
        assert_eq!(meta_str(&got, b"Title").unwrap(), "保留我");
        assert_eq!(meta_str(&got, b"Author").unwrap(), "作者A");
        assert_eq!(meta_str(&got, b"Creator").unwrap(), "我的扫描仪");
        assert_eq!(page_count(&got), 2);
    }

    #[test]
    fn info_reports_pages() {
        let pdf = make_pdf(7);
        let (pages, _, _) = pdf_info(&pdf).unwrap();
        assert_eq!(pages, 7);
    }

    #[test]
    fn delete_then_reload_is_stable() {
        // 反复重建不应该让页数漂移或丢内容
        let mut pdf = make_pdf(6);
        for _ in 0..3 {
            pdf = delete_pages(&pdf, "1").unwrap();
        }
        assert_eq!(page_count(&Document::load_mem(&pdf).unwrap()), 3);
        assert_eq!(page_seq(&pdf), vec!["4", "5", "6"]);
    }
}
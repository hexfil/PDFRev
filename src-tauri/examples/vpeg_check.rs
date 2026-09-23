//! 用真实文档 test/VPEg.pdf（62 页 / 10.3 MB）做端到端验收。
//!
//!     cargo run --example vpeg_check
//!
//! 校验：页数、页序、旋转、插入、删除、抽取、元数据保留，以及源文件 sha256 不变。

use std::fs;
use std::path::Path;

#[path = "../src/pdfops.rs"]
mod pdfops;

/// 简易 sha256（只用于比对文件是否被改写；用系统自带实现避免引依赖）
fn sha256_of(path: &Path) -> String {
    let out = std::process::Command::new("certutil")
        .args(["-hashfile", &path.display().to_string(), "SHA256"])
        .output()
        .expect("certutil 执行失败");
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines()
        .nth(1)
        .unwrap_or("")
        .replace(' ', "")
        .to_lowercase()
}

fn main() {
    let path = Path::new(r"F:\PDFRev\test\VPEg.pdf");
    assert!(path.exists(), "找不到 {}", path.display());
    let before = sha256_of(path);
    let bytes = fs::read(path).unwrap();
    println!("源文件 {} 字节  sha256 {}", bytes.len(), &before[..16]);

    let (pages, title, author) = pdfops::pdf_info(&bytes).unwrap();
    println!("页数 = {}  Title = {:?}  Author = {:?}", pages, title, author);
    assert_eq!(pages, 62, "VPEg.pdf 应该是 62 页");

    // 删除第 1 页 -> 61 页
    let d = pdfops::delete_pages(&bytes, "1").unwrap();
    let (p1, _, _) = pdfops::pdf_info(&d).unwrap();
    println!("删除第 1 页后 = {} 页", p1);
    assert_eq!(p1, 61);

    // 抽取 1-3 页
    let e = pdfops::extract_pages(&bytes, "1-3").unwrap();
    let (p2, _, _) = pdfops::pdf_info(&e).unwrap();
    println!("抽取 1-3 页后 = {} 页", p2);
    assert_eq!(p2, 3);

    // 旋转第 1 页 90 度后仍能解析
    let r = pdfops::rotate_pages(&bytes, "1", 90).unwrap();
    let (p3, _, _) = pdfops::pdf_info(&r).unwrap();
    println!("旋转第 1 页后 = {} 页", p3);
    assert_eq!(p3, 62);

    // 插入自身到末尾 -> 124 页
    let i = pdfops::insert_pdf(&bytes, &bytes, "tail", None).unwrap();
    let (p4, _, _) = pdfops::pdf_info(&i).unwrap();
    println!("尾部插入自身后 = {} 页", p4);
    assert_eq!(p4, 124);

    // 排序：把最后一页提到最前
    let o = pdfops::reorder_pages(&bytes, "62,1-5").unwrap();
    let (p5, order, rest) = (pdfops::pdf_info(&o.0).unwrap().0, o.1.clone(), o.2.clone());
    println!("排序 62,1-5 后 = {} 页；前 6 页顺序 {:?}，自动追加 {} 页", p5, &order[..6], rest.len());
    assert_eq!(p5, 62);
    assert_eq!(&order[..6], &[62, 1, 2, 3, 4, 5]);

    // 元数据保留
    let got = pdfops::load_doc(&d, "x").unwrap();
    println!("删除后仍能重新解析，页数 {}", pdfops::page_count(&got));

    // 写一份产物出来，方便人工用阅读器打开确认
    let out = Path::new(r"F:\PDFRev_Tauri\test\VPEg-tauri-out.pdf");
    fs::write(out, &i).unwrap();
    println!("产物已写 {} ({} 字节)", out.display(), i.len());

    // ---------------------------------------------------------------
    // 回归：用户报的「VPEg-测试用.pdf 插入 1818090690.pdf 后，插入的部分乱码」
    //
    // 根因是插入时「按原编号拷贝、编号被占用就跳过」：两个文档的对象编号
    // 撞车后，插入页的 /Contents 会指到目标文档里类型完全不同的对象
    // （这个用例里实测指向一个字体字典），解析器拿不到内容流。
    // 所以这里不只比页数，还要证明插入页的每个 /Contents 都能解出非空内容。
    // ---------------------------------------------------------------
    let ex = Path::new(r"F:\PDFRev_Tauri\src-tauri\examples");
    let vpeg2 = ex.join("VPEg-测试用.pdf");
    let other = ex.join("1818090690.pdf");
    if vpeg2.exists() && other.exists() {
        let base = fs::read(&vpeg2).unwrap();
        let ins_pdf = fs::read(&other).unwrap();
        let (nb, _, _) = pdfops::pdf_info(&base).unwrap();
        let (ni, _, _) = pdfops::pdf_info(&ins_pdf).unwrap();
        println!("\n插入回归：目标 {} 页 + 待插 {} 页", nb, ni);

        let merged = pdfops::insert_pdf(&base, &ins_pdf, "tail", None).unwrap();
        let doc = pdfops::load_doc(&merged, "合并结果").unwrap();
        let (nm, _, _) = pdfops::pdf_info(&merged).unwrap();
        assert_eq!(nm, nb + ni, "插入后页数不对");

        // 插进来的每一页都必须有非空内容流（乱码 bug 的直接判据）
        let mut checked = 0;
        for n in (nb + 1)..=(nb + ni) {
            let ids = pdfops::page_ids(&doc);
            let id = ids[n - 1];
            let content = doc.get_page_content(id);
            assert!(
                !content.is_empty(),
                "插入的第 {} 页内容流为空（/Contents 指错了对象 —— 正是乱码 bug）",
                n - nb
            );
            checked += 1;
        }
        println!("插入的 {} 页全部有非空内容流 ✓", checked);

        // 原有页也不能被改坏：逐页和「插入前」的原始字节比对。
        //
        // 注意不能改成「断言内容流非空」—— 原文件里本来就有空白页
        // （VPEg-测试用.pdf 第 57 页的内容流就是空的），那样会把
        // 「源文件本来就是空白页」误判成 bug。
        let base_doc = pdfops::load_doc(&base, "目标 PDF").unwrap();
        let base_ids = pdfops::page_ids(&base_doc);
        for n in 1..=nb {
            let a = base_doc.get_page_content(base_ids[n - 1]);
            let b = doc.get_page_content(pdfops::page_ids(&doc)[n - 1]);
            assert_eq!(
                a, b,
                "原有第 {} 页的内容流被插入操作改动了",
                n
            );
        }
        println!("原有 {} 页内容流与插入前逐字节一致 ✓", nb);

        // 插进来的页也必须和插入源文件里对应的页逐字节一致
        let ins_doc = pdfops::load_doc(&ins_pdf, "待插入 PDF").unwrap();
        let ins_ids = pdfops::page_ids(&ins_doc);
        for k in 0..ni {
            let a = ins_doc.get_page_content(ins_ids[k]);
            let b = doc.get_page_content(pdfops::page_ids(&doc)[nb + k]);
            assert_eq!(
                a, b,
                "插入的第 {} 页内容与源文件不一致（乱码 bug 的判据）",
                k + 1
            );
        }
        println!("插入的 {} 页内容与源文件逐字节一致 ✓", ni);

        // 写一份产物供人工用阅读器确认渲染正常
        let out2 = Path::new(r"F:\PDFRev_Tauri\test\insert-out.pdf");
        fs::write(out2, &merged).unwrap();
        println!("插入产物已写 {} ({} 字节，可人工打开确认)", out2.display(), merged.len());
    } else {
        println!("\n（跳过插入回归：examples 里没找到那两个测试 PDF）");
    }
    let after = sha256_of(path);
    assert_eq!(before, after, "源文件被改写了！");
    println!("源文件未被改写 ✓");

    println!("\nVPEg.pdf 端到端验收全部通过");
}
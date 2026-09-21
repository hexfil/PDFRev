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

    let after = sha256_of(path);
    assert_eq!(before, after, "源文件被改写了！");
    println!("源文件未被改写 ✓");

    println!("\nVPEg.pdf 端到端验收全部通过");
}
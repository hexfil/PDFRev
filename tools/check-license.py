#!/usr/bin/env python3
r"""校验界面里的 MIT 许可全文与根目录 LICENSE 文件逐字一致。

用法（在 F:\PDFRev_Tauri 下）：
    python tools/check-license.py

为什么要这一步：版权页把 MIT 全文内嵌在 src/app.js 的 COPYRIGHT_FULL 里
（前端资源是编译期嵌进 exe 的，没法在运行时读磁盘上的 LICENSE 文件）。
两份文本一旦漂移，界面展示的就不是真正的 MIT 条款了，所以必须能自动校验。
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JS = os.path.join(ROOT, 'src', 'app.js')
LICENSE = os.path.join(ROOT, 'LICENSE')


def from_js():
    """把 app.js 里 COPYRIGHT_FULL 那个字符串数组还原成文本。"""
    src = open(APP_JS, encoding='utf-8').read()
    m = re.search(r"const COPYRIGHT_FULL = \[(.*?)\]\.join", src, re.S)
    if not m:
        raise SystemExit('app.js 里找不到 COPYRIGHT_FULL 数组')
    out = []
    for raw in m.group(1).split('\n'):
        s = raw.strip()
        if not s.endswith(','):
            continue
        s = s[:-1].strip()
        if s == "''":
            out.append('')
            continue
        if len(s) >= 2 and s.startswith("'") and s.endswith("'"):
            out.append(s[1:-1])
    return '\n'.join(out)


def norm(text):
    return text.replace('\r\n', '\n').replace('\r', '\n').strip()


def main():
    js = norm(from_js())
    lic = norm(open(LICENSE, encoding='utf-8').read())
    js_lines = js.split('\n')
    lic_lines = lic.split('\n')
    print('界面 COPYRIGHT_FULL: %d 行 / %d 字节' % (len(js_lines), len(js)))
    print('根目录 LICENSE     : %d 行 / %d 字节' % (len(lic_lines), len(lic)))
    if js_lines != lic_lines:
        print('不一致，逐行差异：')
        import difflib
        for line in difflib.unified_diff(lic_lines, js_lines, 'LICENSE', 'app.js', lineterm=''):
            print(line)
        return 1
    # MIT 必须有的关键片段，防止整篇被替换成别的东西
    for key in ('MIT License', 'Permission is hereby granted',
                'WITHOUT WARRANTY OF ANY KIND', 'He Xianfeng'):
        if key not in js:
            print('缺少 MIT 关键片段: %s' % key)
            return 1
    print('通过：界面许可全文与 LICENSE 逐字一致，且含 MIT 关键条款。')
    return 0


if __name__ == '__main__':
    sys.exit(main())

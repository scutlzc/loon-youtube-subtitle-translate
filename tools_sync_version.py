#!/usr/bin/env python3
"""把脚本里的 PLUGIN_VERSION 同步到三份插件的 [Argument] about 参数 + 更新 README 安装链接。"""
import re, sys, glob, pathlib

root = pathlib.Path(__file__).resolve().parent
js = (root / 'scripts/yt-subtitle-translate.js').read_text(encoding='utf-8')
ver = re.search(r"var PLUGIN_VERSION = '([^']+)'", js).group(1)          # 2026.11.22.14
tag = 'v' + ver

for f in sorted(root.glob('YouTube-Subtitle-Translate*.plugin')):
    s = f.read_text(encoding='utf-8')
    legacy = 'legacy' in f.name
    label = 'v' + ver + ' · 当前版本'
    if legacy:
        decl = f'about = input,"{label}",tag=关于/版本,desc=这里就是插件版本号 通知里也会带 方便确认有没有更新成功'
    else:
        decl = f'about = input,"{label}",type=string,tag=关于/版本,desc=这里就是插件版本号 通知里也会带 方便确认有没有更新成功'
    if re.search(r'^about = ', s, re.M):
        s = re.sub(r'^about = .*$', decl, s, count=1, flags=re.M)
    else:
        s = s.replace('[Script]', decl + '\n\n[Script]', 1)
    # date / loon_version 保持；脚本参数一律不含 about（它只是展示位）
    f.write_text(s, encoding='utf-8')
    print(f.name, 'about ->', label)

readme = root / 'README.md'
rs = readme.read_text(encoding='utf-8')
rs = re.sub(r'/v\d{4}\.\d{2}\.\d{2}(?:\.\d+)?/', f'/{tag}/', rs)
readme.write_text(rs, encoding='utf-8')
print('README tag ->', tag)

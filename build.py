"""把 src/ 下的三份源码内联成仓库根目录的 index.html（GitHub Pages 直接用它）。"""
from pathlib import Path

root = Path(__file__).resolve().parent
src = root / "src"
html = (src / "template.html").read_text(encoding="utf-8")
parts = {
    "/*__CSS__*/": (src / "style.css").read_text(encoding="utf-8"),
    "/*__CORE__*/": (src / "core.js").read_text(encoding="utf-8"),
    "/*__APP__*/": (src / "app.js").read_text(encoding="utf-8"),
}
for mark, body in parts.items():
    assert html.count(mark) == 1, mark
    assert "</script" not in body.lower(), f"{mark} 里出现了 </script，会截断内联脚本"
    html = html.replace(mark, body)
out = root / "index.html"
out.write_text(html, encoding="utf-8")
print(f"{out} {len(html.encode('utf-8')) / 1024:.1f} KB")

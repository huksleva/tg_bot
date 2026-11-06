"""Рисует аватарку и приветственную картинку для «Отрока Батракана»."""
import math
import subprocess
from pathlib import Path

OUT = Path(__file__).parent
RED, RED_D, GOLD, GOLD_D = "#9e1b14", "#5a0c08", "#e8b84a", "#b07d1e"
SKIN, SKIN_S, HAIR, HAIR_D = "#f3cfa6", "#e3ab80", "#e0a53a", "#a8701c"
LINEN, LINEN_S, INK = "#f6eedb", "#dccfae", "#3b2414"


def rhombus(cx, cy, w, h, fill, extra=""):
    return (f'<path d="M{cx} {cy-h} L{cx+w} {cy} L{cx} {cy+h} L{cx-w} {cy} Z" '
            f'fill="{fill}" {extra}/>')


def ring(cx, cy, r_out, r_in, n=36):
    """Кольцо-оберег с ромбами между двух золотых окружностей."""
    parts = [
        f'<circle cx="{cx}" cy="{cy}" r="{r_out}" fill="none" stroke="{GOLD}" stroke-width="9"/>',
        f'<circle cx="{cx}" cy="{cy}" r="{r_in}" fill="none" stroke="{GOLD}" stroke-width="5"/>',
    ]
    rm = (r_out + r_in) / 2
    for i in range(n):
        a = 2 * math.pi * i / n
        x, y = cx + rm * math.cos(a), cy + rm * math.sin(a)
        deg = math.degrees(a)
        parts.append(f'<g transform="rotate({deg + 90:.2f} {x:.2f} {y:.2f})">'
                     f'{rhombus(x, y, 9, 12, GOLD)}{rhombus(x, y, 3.5, 5, RED_D)}</g>')
        a2 = a + math.pi / n
        parts.append(f'<circle cx="{cx + rm*math.cos(a2):.2f}" cy="{cy + rm*math.sin(a2):.2f}" '
                     f'r="3.5" fill="{GOLD}"/>')
    return "\n".join(parts)


def embroidery_band(x0, y0, x1, y1, w):
    """Вышитая полоса (ворот/планка) по прямой."""
    L = math.hypot(x1 - x0, y1 - y0)
    ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
    out = [f'<g transform="translate({x0} {y0}) rotate({ang:.2f})">',
           f'<rect x="0" y="{-w/2}" width="{L:.1f}" height="{w}" rx="3" fill="{RED}"/>']
    step = w * 0.95
    k = int(L // step)
    for i in range(k):
        cx = step / 2 + i * step + (L - k * step) / 2
        out.append(rhombus(cx, 0, w * 0.32, w * 0.32, GOLD))
        out.append(rhombus(cx, 0, w * 0.12, w * 0.12, RED_D))
    out.append("</g>")
    return "\n".join(out)


def character():
    """Отрок: стрижка «под горшок», вышитая косоворотка. Координаты под холст 1024."""
    fringe = "M374 402 " + " ".join(
        f"L{374 + i*23:.0f} {402 + (14 if i % 2 else 0)}" for i in range(1, 13)) + " L650 402"
    return f"""
  <!-- рубаха -->
  <path d="M170 1024 C180 830 320 735 468 700 L556 700 C704 735 844 830 854 1024 Z" fill="{LINEN}"/>
  <path d="M300 790 C340 860 350 950 345 1024" stroke="{LINEN_S}" stroke-width="6" fill="none"/>
  <path d="M724 790 C684 860 674 950 679 1024" stroke="{LINEN_S}" stroke-width="6" fill="none"/>
  <!-- шея -->
  <rect x="468" y="610" width="88" height="100" fill="{SKIN}"/>
  <path d="M468 640 Q512 680 556 640 L556 660 Q512 700 468 660 Z" fill="{SKIN_S}" opacity=".7"/>
  <!-- ворот и планка с вышивкой -->
  <path d="M456 700 Q512 742 568 700" fill="none" stroke="{RED}" stroke-width="30" stroke-linecap="round"/>
  <path d="M456 700 Q512 742 568 700" fill="none" stroke="{GOLD}" stroke-width="5" stroke-dasharray="2 12" stroke-linecap="round"/>
  {embroidery_band(560, 722, 560, 900, 30)}
  <circle cx="584" cy="760" r="7" fill="{GOLD}"/><circle cx="584" cy="810" r="7" fill="{GOLD}"/>
  <circle cx="584" cy="860" r="7" fill="{GOLD}"/>
  <!-- уши -->
  <ellipse cx="362" cy="492" rx="27" ry="42" fill="{SKIN}"/>
  <ellipse cx="662" cy="492" rx="27" ry="42" fill="{SKIN}"/>
  <ellipse cx="364" cy="494" rx="11" ry="22" fill="{SKIN_S}"/>
  <ellipse cx="660" cy="494" rx="11" ry="22" fill="{SKIN_S}"/>
  <!-- лицо -->
  <ellipse cx="512" cy="480" rx="150" ry="178" fill="{SKIN}"/>
  <!-- волосы «под горшок» -->
  <path d="M332 470 C326 300 418 222 512 222 C606 222 698 300 692 470
           L656 470 L652 402 L372 402 L368 470 Z" fill="{HAIR}"/>
  <path d="{fringe} L650 380 L374 380 Z" fill="{HAIR}"/>
  <g stroke="{HAIR_D}" stroke-width="5" fill="none" stroke-linecap="round" opacity=".75">
    <path d="M512 232 C500 300 470 350 452 398"/><path d="M512 232 C524 300 554 350 572 398"/>
    <path d="M470 240 C430 290 405 340 400 398"/><path d="M554 240 C594 290 619 340 624 398"/>
    <path d="M420 262 C380 310 360 380 352 462"/><path d="M604 262 C644 310 664 380 672 462"/>
    <path d="M512 232 L512 400"/>
  </g>
  <!-- брови, глаза -->
  <path d="M430 448 Q456 434 482 446" stroke="{HAIR_D}" stroke-width="8" fill="none" stroke-linecap="round"/>
  <path d="M542 446 Q568 434 594 448" stroke="{HAIR_D}" stroke-width="8" fill="none" stroke-linecap="round"/>
  <ellipse cx="456" cy="484" rx="14" ry="17" fill="{INK}"/><circle cx="461" cy="478" r="5" fill="#fff"/>
  <ellipse cx="568" cy="484" rx="14" ry="17" fill="{INK}"/><circle cx="573" cy="478" r="5" fill="#fff"/>
  <!-- нос, румянец, улыбка -->
  <path d="M514 500 Q526 538 506 546" stroke="{SKIN_S}" stroke-width="7" fill="none" stroke-linecap="round"/>
  <ellipse cx="428" cy="548" rx="34" ry="20" fill="#e0675a" opacity=".38"/>
  <ellipse cx="596" cy="548" rx="34" ry="20" fill="#e0675a" opacity=".38"/>
  <path d="M474 584 Q512 618 550 584" stroke="#93402c" stroke-width="8" fill="none" stroke-linecap="round"/>
"""


def avatar_svg(square_bg=True):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <radialGradient id="bg" cx="50%" cy="42%" r="60%">
    <stop offset="0" stop-color="#c8342a"/><stop offset=".7" stop-color="{RED}"/><stop offset="1" stop-color="{RED_D}"/>
  </radialGradient>
  <clipPath id="inner"><circle cx="512" cy="512" r="436"/></clipPath>
</defs>
{f'<rect width="1024" height="1024" fill="{RED_D}"/>' if square_bg else f'<circle cx="512" cy="512" r="500" fill="{RED_D}"/>'}
<circle cx="512" cy="512" r="436" fill="url(#bg)"/>
<g clip-path="url(#inner)">
  <g fill="{GOLD}" opacity=".12">
    {"".join(rhombus(x, y, 22, 30, GOLD) for x in range(64, 1024, 128) for y in range(80, 1024, 160))}
  </g>
  {character()}
</g>
{ring(512, 512, 488, 442)}
</svg>"""


def band(y, width, h=44):
    """Горизонтальная орнаментальная полоса."""
    parts = [f'<rect x="0" y="{y}" width="{width}" height="{h}" fill="{RED_D}"/>',
             f'<rect x="0" y="{y+4}" width="{width}" height="3" fill="{GOLD}"/>',
             f'<rect x="0" y="{y+h-7}" width="{width}" height="3" fill="{GOLD}"/>']
    for x in range(20, width, 40):
        parts.append(rhombus(x, y + h / 2, 13, 11, GOLD))
        parts.append(rhombus(x, y + h / 2, 5, 4, RED))
        parts.append(f'<circle cx="{x+20}" cy="{y+h/2}" r="3" fill="{GOLD}"/>')
    return "\n".join(parts)


def welcome_svg():
    W, H = 1280, 720
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
  <radialGradient id="parch" cx="62%" cy="50%" r="75%">
    <stop offset="0" stop-color="#f8edd2"/><stop offset=".75" stop-color="#ead6a8"/><stop offset="1" stop-color="#c9a86a"/>
  </radialGradient>
</defs>
<rect width="{W}" height="{H}" fill="url(#parch)"/>
{band(0, W)}
{band(H-44, W)}
<!-- медальон с отроком -->
<g transform="translate(70 100) scale(0.508)">
  {avatar_svg(square_bg=False).split('>', 1)[1].rsplit('</svg>', 1)[0]}
</g>
<!-- надписи -->
<g font-family="Ruslan Display" text-anchor="middle">
  <text x="880" y="250" font-size="78" fill="{RED_D}" opacity=".25" dx="4" dy="4">Отрок</text>
  <text x="880" y="250" font-size="78" fill="{RED}">Отрок</text>
  <text x="880" y="350" font-size="78" fill="{RED_D}" opacity=".25" dx="4" dy="4">Батракан</text>
  <text x="880" y="350" font-size="78" fill="{RED}">Батракан</text>
</g>
<g transform="translate(880 400)">
  <rect x="-170" y="-2" width="340" height="3" fill="{GOLD_D}"/>
  {rhombus(0, 0, 16, 14, GOLD_D)}{rhombus(0, 0, 6, 5, RED)}
  {rhombus(-190, 0, 8, 7, GOLD_D)}{rhombus(190, 0, 8, 7, GOLD_D)}
</g>
<g font-family="Kurale" text-anchor="middle" fill="{INK}">
  <text x="880" y="470" font-size="40">Здрав буди, господине!</text>
  <text x="880" y="530" font-size="30" fill="#6b4a2a">Служу верно, урок справляю споро</text>
</g>
</svg>"""


for name, svg in [("avatar", avatar_svg()), ("welcome", welcome_svg())]:
    (OUT / f"{name}.svg").write_text(svg, encoding="utf-8")
    subprocess.run(["rsvg-convert", str(OUT / f"{name}.svg"), "-o", str(OUT / f"{name}.png")], check=True)
    print("ok", name)

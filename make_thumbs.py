"""Kpop Baby 큐텐 대표이미지 자동 생성.

리스팅관리 시트 '대표이미지_작업' 탭을 읽어, 대표이미지URL(G)이 비어 있는 줄마다
800x800 이미지를 만들어 img/<코드>.jpg 로 저장하고 G·H열을 채운다.
마지막에 '자동화_상태' 4행을 갱신한다.

필요한 환경변수: GOOGLE_SA_JSON (구글 서비스 계정 키 JSON 전체)
선택: SHEET_ID, PAGES_BASE, DRY_RUN=1 (시트에 쓰지 않음)
"""
import io
import json
import os
import re
import sys
import traceback
from datetime import datetime, timedelta, timezone

import requests
from PIL import Image, ImageDraw, ImageFont

SHEET_ID = os.environ.get("SHEET_ID", "13ZYdAxgHANOLGPnoi5biB-QdE5M25wFuEQmL8QzKNZo")
TAB = "대표이미지_작업"
STATUS_TAB = "자동화_상태"
PAGES_BASE = os.environ.get("PAGES_BASE", "https://loveisallinc-lang.github.io/kb-thumb/img")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "img")
KST = timezone(timedelta(hours=9))

# ---- 디자인 틀 (사장님 샘플 3장 기준, 2026-11-20) ----
# 위쪽 흰 띠: KPOP BABY 로고(왼쪽) + HANTEO·CIRCLE CHART 로고(오른쪽) = assets/header.png
# 가운데: 연회색 둥근 판 위에 앨범 사진 (cover면 판을 꽉 채움, contain이면 여백 두고 가운데)
# 오른쪽 위: 분홍 라벨 줄들 → 보라 라벨 줄들 (오른쪽 끝에 붙고, 글자 길이만큼)
# 왼쪽 아래: 보라 톱니 '+Online 特典' 배지 = assets/badge.png
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
SIZE = 800
BG = (255, 255, 255)
PANEL = (242, 242, 242)
PANEL_BOX = (19, 92, 785, 787)   # 왼, 위, 오른, 아래
PANEL_R = 14
PHOTO_PAD = 40                   # contain일 때 판 안쪽 여백
PINK = (255, 0, 165)
PURPLE = (221, 0, 255)
TEXT = (255, 255, 255)
LABEL_TOP = 94
LABEL_H = 40
LABEL_PITCH = 46
LABEL_PAD_X = 5
LABEL_FONT = 31
LABEL_MAX_W = 560
BADGE_POS = (8, 582)
# 세로로 아주 긴 상세페이지 이미지면 맨 위(표지 구성 부분)만 잘라 씀
LONG_RATIO = 1.6       # 세로/가로가 이보다 크면 긴 이미지로 봄
TOP_CROP_RATIO = 1.15  # 위에서 가로의 1.15배 높이만큼 사용

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]


def font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size)


def lines(cell):
    return [s.strip() for s in (cell or "").splitlines() if s.strip()]


def fit_font(draw, text, max_w, size):
    while size > 14:
        f = font(size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 1
    return font(size)


def draw_label(draw, y, text, color):
    f = fit_font(draw, text, LABEL_MAX_W - 2 * LABEL_PAD_X, LABEL_FONT)
    w = int(draw.textlength(text, font=f)) + 2 * LABEL_PAD_X
    x = SIZE - w
    draw.rectangle([x, y, SIZE, y + LABEL_H], fill=color)
    draw.text((x + LABEL_PAD_X, y + LABEL_H / 2 + 1), text, font=f, fill=TEXT, anchor="lm",
              stroke_width=0)


def compose(photo, pink, purple, badge, fit):
    canvas = Image.new("RGB", (SIZE, SIZE), BG)
    l, t, r, b = PANEL_BOX
    pw_, ph_ = r - l, b - t
    panel = Image.new("RGB", (pw_, ph_), PANEL)
    photo = photo.convert("RGBA")
    w, h = photo.size
    if h / w > LONG_RATIO:
        photo = photo.crop((0, 0, w, round(w * TOP_CROP_RATIO)))
        w, h = photo.size
    if fit == "cover":
        s = max(pw_ / w, ph_ / h)
        nw, nh = round(w * s), round(h * s)
        im = photo.resize((nw, nh), Image.LANCZOS)
        cx, cy = (nw - pw_) // 2, (nh - ph_) // 2
        im = im.crop((cx, cy, cx + pw_, cy + ph_))
        panel.paste(im, (0, 0), im)
    else:
        aw, ah = pw_ - 2 * PHOTO_PAD, ph_ - 2 * PHOTO_PAD
        s = min(aw / w, ah / h)
        nw, nh = round(w * s), round(h * s)
        im = photo.resize((nw, nh), Image.LANCZOS)
        panel.paste(im, ((pw_ - nw) // 2, (ph_ - nh) // 2), im)
    rmask = Image.new("L", (pw_, ph_), 0)
    ImageDraw.Draw(rmask).rounded_rectangle([0, 0, pw_ - 1, ph_ - 1], radius=PANEL_R, fill=255)
    canvas.paste(panel, (l, t), rmask)

    header = Image.open(os.path.join(ASSETS, "header.png")).convert("RGB")
    canvas.paste(header, (0, 0))

    d = ImageDraw.Draw(canvas)
    y = LABEL_TOP
    for txt in pink:
        draw_label(d, y, txt, PINK)
        y += LABEL_PITCH
    for txt in purple:
        draw_label(d, y, txt, PURPLE)
        y += LABEL_PITCH

    if badge:
        bimg = Image.open(os.path.join(ASSETS, "badge.png")).convert("RGBA")
        canvas.paste(bimg, BADGE_POS, bimg)
    return canvas


# ---- 구글 시트 ----
class Sheets:
    def __init__(self):
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request

        info = json.loads(os.environ["GOOGLE_SA_JSON"])
        self.creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/spreadsheets"])
        self.creds.refresh(Request())
        self.base = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values"

    def _h(self):
        return {"Authorization": f"Bearer {self.creds.token}"}

    def get(self, rng):
        r = requests.get(f"{self.base}/{requests.utils.quote(rng)}", headers=self._h(), timeout=30)
        r.raise_for_status()
        return r.json().get("values", [])

    def put(self, rng, values):
        if os.environ.get("DRY_RUN"):
            print("DRY_RUN put", rng, values)
            return
        r = requests.put(f"{self.base}/{requests.utils.quote(rng)}", headers=self._h(),
                         params={"valueInputOption": "USER_ENTERED"}, json={"values": values}, timeout=30)
        r.raise_for_status()


UA = {"User-Agent": "Mozilla/5.0 kb-thumb"}


def resolve_source(url):
    """애플뮤직 상품 페이지 주소면 그 상품의 대표 사진(정사각 표지) 주소로 바꿔 준다."""
    if "applemusic.co.kr" in url and "shopdetail" in url:
        r = requests.get(url, timeout=30, headers=UA)
        r.raise_for_status()
        m = re.search(r"/shopimages/applemusic/(\d{8,})\.jpg", r.text)
        if not m:
            raise ValueError("애플뮤직 상품 페이지에서 대표 사진을 못 찾음")
        return f"https://www.applemusic.co.kr/shopimages/applemusic/{m.group(1)}.jpg"
    return url


def fetch_image(url):
    r = requests.get(resolve_source(url), timeout=30, headers=UA)
    r.raise_for_status()
    return Image.open(io.BytesIO(r.content))


def safe_name(code):
    return "".join(c for c in code if c.isalnum() or c in "-_") or "noname"


def test_mode(url):
    """시트를 건드리지 않고 한 장만 만들어 보기 (img/_test.jpg)."""
    print("source:", resolve_source(url))
    img = compose(fetch_image(url), ["TEST LABEL"], ["特典選択 TEST"], True, "contain")
    os.makedirs(OUT_DIR, exist_ok=True)
    img.save(os.path.join(OUT_DIR, "_test.jpg"), "JPEG", quality=92)
    print("OK _test.jpg")
    return 0


def main():
    if os.environ.get("TEST_URL"):
        return test_mode(os.environ["TEST_URL"])
    sh = Sheets()
    rows = sh.get(f"{TAB}!A2:I")
    now = datetime.now(KST)
    stamp = now.strftime("%Y-%m-%d %H:%M")
    done, failed, errors = 0, 0, []
    os.makedirs(OUT_DIR, exist_ok=True)
    for i, row in enumerate(rows, start=2):
        row = row + [""] * (9 - len(row))
        code, src, pink, purple, badge, fit, out_url = (c.strip() for c in row[:7])
        if not code or not src or out_url:
            continue
        try:
            img = compose(fetch_image(src), lines(row[2]), lines(row[3]),
                          badge.upper() == "TRUE", (fit or "contain").lower())
            name = safe_name(code) + ".jpg"
            img.save(os.path.join(OUT_DIR, name), "JPEG", quality=92)
            url = f"{PAGES_BASE}/{name}?v={now.strftime('%Y%m%d%H%M')}"
            sh.put(f"{TAB}!G{i}:H{i}", [[url, f"완료 {stamp}"]])
            done += 1
            print("OK", code, url)
        except Exception as e:  # 한 줄 실패해도 나머지는 계속
            failed += 1
            msg = f"{type(e).__name__}: {e}"[:200]
            errors.append(f"{code}: {msg}")
            sh.put(f"{TAB}!H{i}", [[f"오류 {stamp} — {msg}"]])
            traceback.print_exc()

    result = f"생성 {done}건, 실패 {failed}건" if (done or failed) else "새로 만들 이미지 없음"
    todo = ("실패한 줄은 앨범사진 주소를 확인해 주세요: " + "; ".join(errors)) if errors else ""
    sh.put(f"{STATUS_TAB}!B4:D4", [[stamp, result, todo]])
    print(result)
    # 새 이미지가 Pages에 올라가기 전에 주소가 먼저 적히지만, 같은 실행에서 바로 커밋·배포되므로 1~2분 뒤 열림
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""오케이포스 현재고 → 매장 시트 '현재고' 탭 자동 채우기.

깃헙 Actions에서 매일 실행된다.
필수 비밀값: OKPOS_ID, OKPOS_PW (사장님이 직접 입력), GOOGLE_SA_JSON
선택: STORE_SHEET_ID, DRY_RUN=1 (시트에 쓰지 않고 개수만 출력)

이 저장소는 공개라서 로그에는 개수·결과만 찍고 상품 정보는 찍지 않는다.
"""
import datetime as dt
import json
import os
import sys
import time

import requests

STORE_SHEET_ID = os.environ.get("STORE_SHEET_ID", "1vWFB4rsdSX222ZPdiBlGNmLFVdezURCq8EEhxTJwNyM")
LISTING_SHEET_ID = "13ZYdAxgHANOLGPnoi5biB-QdE5M25wFuEQmL8QzKNZo"
TAB = "현재고"
BASE = "https://nice.okpos.co.kr"
PAGE_SIZE = 5000          # 오케이포스 조회줄수 최대값
WRITE_COLS = 25           # 현재고 탭 A~Y 만 쓴다 (Z 이후는 수식)
KST = dt.timezone(dt.timedelta(hours=9))

# 시트 칸 이름 → 오케이포스 표 칸 이름(없으면 시트 이름 그대로 찾음)
ALIAS = {"구분": "대분류"}
NUM_COLS = {"현재고", "재고금액", "사입입고", "사입반품", "매장판매", "폐기", "조정", "세트생성", "매장판매가"}
DATE_COLS = {"최초입고일", "최종입고일", "최초판매일", "최종판매일"}


def log(*a):
    print(*a, flush=True)


# ---- 구글 시트 ----
class Sheets:
    def __init__(self):
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request

        info = json.loads(os.environ["GOOGLE_SA_JSON"])
        self.creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/spreadsheets"])
        self.creds.refresh(Request())

    def _u(self, sid, rng=""):
        base = f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values"
        return f"{base}/{requests.utils.quote(rng)}" if rng else base

    def _h(self):
        return {"Authorization": f"Bearer {self.creds.token}"}

    def get(self, sid, rng, render="FORMATTED_VALUE"):
        r = requests.get(self._u(sid, rng), headers=self._h(),
                         params={"valueRenderOption": render}, timeout=60)
        r.raise_for_status()
        return r.json().get("values", [])

    def put(self, sid, rng, values, mode="RAW"):
        if os.environ.get("DRY_RUN"):
            log(f"DRY_RUN put {rng} ({len(values)}행)")
            return
        r = requests.put(self._u(sid, rng), headers=self._h(),
                         params={"valueInputOption": mode}, json={"values": values}, timeout=120)
        r.raise_for_status()

    def clear(self, sid, rng):
        if os.environ.get("DRY_RUN"):
            log(f"DRY_RUN clear {rng}")
            return
        r = requests.post(self._u(sid, rng) + ":clear", headers=self._h(), timeout=60)
        r.raise_for_status()


# ---- 오케이포스 ----
def fetch_okpos():
    """로그인 → 현재고현황 조회 → 표 전체를 [헤더, 행...] 으로 돌려준다(화면에 보이는 글자 그대로)."""
    from playwright.sync_api import sync_playwright

    uid, pwd = os.environ.get("OKPOS_ID"), os.environ.get("OKPOS_PW")
    if not uid or not pwd:
        raise SystemExit("OKPOS_ID / OKPOS_PW 비밀값이 없습니다.")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(locale="ko-KR", viewport={"width": 1400, "height": 900})
        # 오케이포스는 alert/confirm/팝업을 자주 띄운다 → 전부 자동 확인
        ctx.on("page", lambda pg: pg.on("dialog", lambda d: d.accept()))
        page = ctx.new_page()
        page.on("dialog", lambda d: d.accept())

        for attempt in range(3):
            try:
                page.goto(f"{BASE}/login/login_form.jsp", wait_until="domcontentloaded", timeout=90000)
                break
            except Exception:
                log(f"로그인 화면 접속 실패 {attempt + 1}/3")
                if attempt == 2:
                    raise SystemExit("오케이포스 로그인 화면에 접속하지 못했습니다(깃헙 서버에서 접속이 막혔을 수 있음).")
                time.sleep(10)
        page.wait_for_selector("[name=user_id]", timeout=30000)
        page.fill("[name=user_id]", uid)
        page.fill("[name=user_pwd]", pwd)
        page.press("[name=user_pwd]", "Enter")
        try:
            page.wait_for_url("**/top_frame.jsp*", timeout=60000)
        except Exception:
            raise SystemExit("로그인 실패: 아이디/비밀번호 또는 로그인 화면이 바뀌었는지 확인 필요")
        log("로그인 성공")

        page.goto(f"{BASE}/stock/stock/cur010.jsp", wait_until="domcontentloaded")
        frame = None
        for _ in range(60):
            frame = next((f for f in page.frames if "cur011" in f.url), None)
            if frame:
                try:
                    if frame.evaluate("typeof fnSearch === 'function' && !!window.mySheet1"):
                        break
                except Exception:
                    pass
            time.sleep(1)
        else:
            raise SystemExit("현재고현황 화면을 찾지 못했습니다(메뉴 주소가 바뀌었을 수 있음).")

        frame.evaluate(
            """(n) => {
                document.querySelector('[name=ss_PAGE_SIZE]').value = String(n);
                ['ss_STOCK_EXCP','ss_STOCK_EXCP2','ss_SAFE_STOCK'].forEach(k => {
                    const e = document.querySelector('[name='+k+']'); if (e && e.type==='checkbox') e.checked = false; });
                setTimeout(() => fnSearch(), 0);
            }""", PAGE_SIZE)

        # 행 수가 3초 동안 안 바뀌면 조회 완료로 본다
        last, stable = -1, 0
        for _ in range(180):
            time.sleep(1)
            n = frame.evaluate("window.mySheet1.RowCount ? mySheet1.RowCount() : 0")
            stable = stable + 1 if (n == last and n > 0) else 0
            last = n
            if stable >= 3:
                break
        if last <= 0:
            raise SystemExit("조회 결과가 0건입니다.")

        data = frame.evaluate(
            """() => {
                const s = mySheet1, hr = s.HeaderRows(), lc = s.LastCol(), lr = s.LastRow();
                const head = []; for (let c = 0; c <= lc; c++) head.push(String(s.GetCellText(hr-1, c)).trim());
                const rows = [];
                for (let r = hr; r <= lr; r++) {
                    const row = []; for (let c = 0; c <= lc; c++) row.push(String(s.GetCellText(r, c)));
                    rows.push(row);
                }
                return [head, rows];
            }""")
        browser.close()
    head, rows = data
    # 합계 줄 제외
    rows = [r for r in rows if any(x.strip() for x in r) and r[0].strip() not in ("합계", "")]
    log(f"오케이포스 조회 {len(rows)}건")
    return head, rows


def to_num(s):
    s = (s or "").replace(",", "").strip()
    if s == "":
        return ""
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return s


def to_date_serial(s):
    s = (s or "").strip().replace("-", "").replace(".", "").replace("/", "")
    if len(s) != 8 or not s.isdigit():
        return ""
    d = dt.date(int(s[:4]), int(s[4:6]), int(s[6:]))
    return (d - dt.date(1899, 12, 30)).days


def build_rows(sheet_head, ok_head, ok_rows, old_rows):
    """시트 칸 이름 기준으로 오케이포스 값을 옮긴다. 오케이포스에 없는 칸은 바코드로 예전 값을 이어 붙인다."""
    idx = {}
    for i, h in enumerate(ok_head):
        idx.setdefault(h, i)
    bar_i = idx.get("바코드")
    if bar_i is None:
        raise SystemExit("오케이포스 표에 바코드 칸이 없습니다.")

    try:
        sheet_bar = sheet_head.index("바코드")
    except ValueError:
        raise SystemExit("현재고 탭 1행에 바코드 칸이 없습니다.")
    old_by_bar = {}
    for r in old_rows:
        if len(r) > sheet_bar and r[sheet_bar]:
            old_by_bar.setdefault(r[sheet_bar], r)

    missing = [h for h in sheet_head if h and ALIAS.get(h, h) not in idx]
    if missing:
        log("오케이포스 표에 없어 예전 값을 바코드로 이어 붙이는 칸:", ", ".join(missing))

    out = []
    for r in ok_rows:
        bar = r[bar_i].strip()
        old = old_by_bar.get(bar, [])
        row = []
        for j, h in enumerate(sheet_head):
            src = ALIAS.get(h, h)
            if src in idx:
                v = r[idx[src]].strip()
                if h in NUM_COLS:
                    v = to_num(v)
                elif h in DATE_COLS:
                    v = to_date_serial(v)
                elif h == "상품코드":
                    v = v.lstrip("0") or v
            else:
                v = old[j] if j < len(old) else ""
                if h in NUM_COLS:
                    v = to_num(v)
            row.append(v)
        out.append(row)
    return out


def col_letter(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def set_status(sh, text, todo):
    """리스팅관리 '자동화_상태' 5행에 결과를 남긴다(실패해도 본 작업엔 영향 없음)."""
    try:
        now = dt.datetime.now(KST).strftime("%Y-%m-%d %H:%M")
        sh.put(LISTING_SHEET_ID, "'자동화_상태'!A5:D5", [["오케이포스 현재고", now, text, todo]], mode="USER_ENTERED")
    except Exception as e:  # noqa: BLE001
        log("상태 기록 실패:", type(e).__name__)


def main():
    sh = Sheets()
    try:
        ok_head, ok_rows = fetch_okpos()
    except SystemExit as e:
        set_status(sh, f"실패: {e}", "사장님 확인 필요")
        raise

    last_col = col_letter(WRITE_COLS)
    sheet_head = (sh.get(STORE_SHEET_ID, f"'{TAB}'!A1:{last_col}1") or [[]])[0]
    sheet_head += [""] * (WRITE_COLS - len(sheet_head))
    old = sh.get(STORE_SHEET_ID, f"'{TAB}'!A2:{last_col}")
    old_n = sum(1 for r in old if any(str(x).strip() for x in r))

    rows = build_rows(sheet_head, ok_head, ok_rows, old)
    if old_n and len(rows) < old_n * 0.5:
        msg = f"새 조회 {len(rows)}건이 기존 {old_n}건의 절반도 안 돼서 덮어쓰지 않음"
        set_status(sh, msg, "오케이포스 조회 확인 필요")
        raise SystemExit(msg)

    n = len(rows)
    sh.put(STORE_SHEET_ID, f"'{TAB}'!A2:{last_col}{n + 1}", rows)
    if len(old) > n:
        sh.clear(STORE_SHEET_ID, f"'{TAB}'!A{n + 2}:{last_col}{len(old) + 1}")

    # Z열(이카운트 연결)은 줄마다 들어간 수식 → 새로 늘어난 줄에도 채운다
    z = sh.get(STORE_SHEET_ID, f"'{TAB}'!Z2:Z{n + 1}", render="FORMULA")
    z_rows = []
    for i in range(n):
        cur = z[i][0] if i < len(z) and z[i] else ""
        z_rows.append([cur or f"=XLOOKUP(H{i + 2}, '이카운트'!G:G, '이카운트'!A:A, \"없음\")"])
    sh.put(STORE_SHEET_ID, f"'{TAB}'!Z2:Z{n + 1}", z_rows, mode="USER_ENTERED")

    total = sum(r[sheet_head.index("현재고")] or 0 for r in rows
                if "현재고" in sheet_head and isinstance(r[sheet_head.index("현재고")], (int, float)))
    log(f"현재고 탭 {n}행 갱신 (이전 {old_n}행), 현재고 합계 {total}")
    set_status(sh, f"성공: {n}개 상품 갱신 (현재고 합계 {total})", "없음")


if __name__ == "__main__":
    main()

// 오케이포스 현재고 → 매장 시트 '현재고' 탭 (사장님 PC에서 실행)
// 깃헙(해외 서버)에서는 오케이포스 접속이 막혀서, 한국에 있는 PC에서 돌린다.
// 윈도우 작업 스케줄러가 로그인할 때 + 1시간마다 실행 → 오늘 이미 성공했으면 바로 끝낸다.
//
// 같은 폴더에 필요한 것
//   cred.dat : '비밀번호_저장.bat' 로 사장님이 직접 저장 (이 PC 이 계정에서만 풀 수 있게 암호화)
//   sa.json  : 구글 서비스 계정 키 (kb-thumb@kpopbaby-thumb)
// 선택: 명령줄에 --dry 를 붙이면 시트에 쓰지 않음, --force 는 오늘 성공했어도 다시 실행
import { chromium } from "playwright-core";
import { GoogleAuth } from "google-auth-library";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE_SHEET_ID = "1vWFB4rsdSX222ZPdiBlGNmLFVdezURCq8EEhxTJwNyM";
const LISTING_SHEET_ID = "13ZYdAxgHANOLGPnoi5biB-QdE5M25wFuEQmL8QzKNZo";
const TAB = "현재고";
const BASE = "https://nice.okpos.co.kr";
const PAGE_SIZE = 5000;
const WRITE_COLS = 25; // A~Y (Z 이후는 수식)
const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const STATE = path.join(DIR, "last_success.txt");
const LOG = path.join(DIR, "log.txt");

const ALIAS = { "구분": "대분류" };
const NUM_COLS = new Set(["현재고", "재고금액", "사입입고", "사입반품", "매장판매", "폐기", "조정", "세트생성", "매장판매가"]);
const DATE_COLS = new Set(["최초입고일", "최종입고일", "최초판매일", "최종판매일"]);

const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
const today = () => kstNow().slice(0, 10);
function log(...a) {
  const line = `[${kstNow()}] ${a.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\r\n"); } catch {}
}

function readCred() {
  const f = path.join(DIR, "cred.dat");
  if (!fs.existsSync(f)) throw new Error("cred.dat 없음 → '비밀번호_저장.bat'을 먼저 실행해 주세요");
  const ps = `$l = Get-Content -LiteralPath '${f}'; ` +
    `$u = $l[0]; $s = ConvertTo-SecureString $l[1]; ` +
    `$p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)); ` +
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $u; Write-Output $p`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).split(/\r?\n/);
  return { uid: out[0].trim(), pwd: out[1] };
}

// ---- 구글 시트 ----
const auth = new GoogleAuth({ keyFile: path.join(DIR, "sa.json"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
async function api(method, sid, rng, { params = {}, body } = {}) {
  const client = await auth.getClient();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(rng)}${method === "CLEAR" ? ":clear" : ""}`;
  const res = await client.request({ url, method: method === "CLEAR" ? "POST" : method, params, data: body });
  return res.data;
}
const getVals = async (sid, rng, render = "FORMATTED_VALUE") =>
  (await api("GET", sid, rng, { params: { valueRenderOption: render } })).values || [];
async function putVals(sid, rng, values, mode = "RAW") {
  if (DRY) return log(`DRY put ${rng} (${values.length}행)`);
  await api("PUT", sid, rng, { params: { valueInputOption: mode }, body: { values } });
}
async function clearVals(sid, rng) {
  if (DRY) return log(`DRY clear ${rng}`);
  await api("CLEAR", sid, rng);
}
async function setStatus(text, todo) {
  try {
    await putVals(LISTING_SHEET_ID, "'자동화_상태'!A5:E5",
      [["오케이포스 현재고", kstNow(), text, todo, "사장님 PC 로그인 시 + 1시간마다 (하루 1회 성공하면 멈춤)"]], "USER_ENTERED");
  } catch (e) { log("상태 기록 실패", e.message); }
}

// ---- 오케이포스 ----
async function fetchOkpos() {
  const { uid, pwd } = readCred();
  let browser;
  for (const channel of ["msedge", "chrome"]) {
    try { browser = await chromium.launch({ channel, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error("Edge/Chrome 실행 실패");
  try {
    const ctx = await browser.newContext({ locale: "ko-KR", viewport: { width: 1400, height: 900 } });
    ctx.on("page", (pg) => pg.on("dialog", (d) => d.accept().catch(() => {})));
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept().catch(() => {}));

    await page.goto(`${BASE}/login/login_form.jsp`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("[name=user_id]", { timeout: 30000 });
    await page.fill("[name=user_id]", uid);
    await page.fill("[name=user_pwd]", pwd);
    await page.press("[name=user_pwd]", "Enter");
    try { await page.waitForURL("**/top_frame.jsp*", { timeout: 60000 }); }
    catch { throw new Error("로그인 실패(아이디/비밀번호 확인 → '비밀번호_저장.bat' 다시 실행)"); }
    log("로그인 성공");

    // 현재고현황은 반드시 top_frame 안에서 메뉴로 연다.
    // (cur010.jsp 주소로 바로 가면 상위 창 함수·토큰이 없어 '검색중입니다'에서 멈춤)
    await page.waitForTimeout(3000);
    const clickText = async (text) => {
      for (const f of page.frames()) {
        try {
          const loc = f.locator(`text="${text}"`).first();
          if (await loc.count()) { await loc.click({ timeout: 5000, force: true }); return true; }
        } catch {}
      }
      return false;
    };
    let opened = false;
    for (let i = 0; i < 3 && !opened; i++) {
      await clickText("재고관리"); await page.waitForTimeout(1000);
      await clickText("재고현황"); await page.waitForTimeout(1000);
      await clickText("현재고현황"); await page.waitForTimeout(3000);
      opened = page.frames().some((f) => f.url().includes("cur011"));
    }
    if (!opened) {
      log("메뉴로 열기 실패 → 주소로 직접 열기 시도");
      await page.goto(`${BASE}/stock/stock/cur010.jsp`, { waitUntil: "domcontentloaded" });
    }
    let frame = null;
    for (let i = 0; i < 60; i++) {
      frame = page.frames().find((f) => f.url().includes("cur011"));
      if (frame) {
        try { if (await frame.evaluate("typeof fnSearch === 'function' && !!window.mySheet1")) break; } catch {}
      }
      frame = null;
      await page.waitForTimeout(1000);
    }
    if (!frame) throw new Error("현재고현황 화면을 찾지 못함");

    await frame.evaluate((n) => {
      document.querySelector("[name=ss_PAGE_SIZE]").value = String(n);
      for (const k of ["ss_STOCK_EXCP", "ss_STOCK_EXCP2", "ss_SAFE_STOCK"]) {
        const e = document.querySelector(`[name=${k}]`);
        if (e && e.type === "checkbox") e.checked = false;
      }
      setTimeout(() => fnSearch(), 0);
    }, PAGE_SIZE);

    let last = -1, stable = 0;
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(1000);
      const n = await frame.evaluate("window.mySheet1.RowCount ? mySheet1.RowCount() : 0");
      stable = n === last && n > 0 ? stable + 1 : 0;
      last = n;
      if (stable >= 3) break;
    }
    if (last <= 0) throw new Error("조회 결과 0건");

    const [head, rows] = await frame.evaluate(() => {
      const s = mySheet1, hr = s.HeaderRows(), lc = s.LastCol(), lr = s.LastRow();
      const head = []; for (let c = 0; c <= lc; c++) head.push(String(s.GetCellText(hr - 1, c)).trim());
      const rows = [];
      for (let r = hr; r <= lr; r++) {
        const row = []; for (let c = 0; c <= lc; c++) row.push(String(s.GetCellText(r, c)));
        rows.push(row);
      }
      return [head, rows];
    });
    const clean = rows.filter((r) => r.some((x) => x.trim()) && !["합계", ""].includes(r[0].trim()));
    log(`오케이포스 조회 ${clean.length}건`);
    return { head, rows: clean };
  } finally {
    await browser.close();
  }
}

function toNum(s) {
  s = String(s ?? "").replace(/,/g, "").trim();
  if (s === "") return "";
  const f = Number(s);
  return Number.isFinite(f) ? f : s;
}
function toSerial(s) {
  s = String(s ?? "").replace(/[-./]/g, "").trim();
  if (!/^\d{8}$/.test(s)) return "";
  const d = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((d - Date.UTC(1899, 11, 30)) / 86400e3);
}
function colLetter(n) { let s = ""; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

function buildRows(sheetHead, okHead, okRows, oldRows) {
  const idx = {};
  okHead.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  if (!("바코드" in idx)) throw new Error("오케이포스 표에 바코드 칸 없음");
  const sb = sheetHead.indexOf("바코드");
  if (sb < 0) throw new Error("현재고 탭 1행에 바코드 칸 없음");
  const oldBy = {};
  for (const r of oldRows) if (r[sb] && !(r[sb] in oldBy)) oldBy[r[sb]] = r;
  return okRows.map((r) => {
    const old = oldBy[r[idx["바코드"]].trim()] || [];
    return sheetHead.map((h, j) => {
      const src = ALIAS[h] || h;
      if (h && src in idx) {
        let v = r[idx[src]].trim();
        if (NUM_COLS.has(h)) return toNum(v);
        if (DATE_COLS.has(h)) return toSerial(v);
        if (h === "상품코드") return v.replace(/^0+/, "") || v;
        return v;
      }
      const v = old[j] ?? "";
      return NUM_COLS.has(h) ? toNum(v) : v;
    });
  });
}

async function main() {
  if (!FORCE && !DRY && fs.existsSync(STATE) && fs.readFileSync(STATE, "utf8").trim() === today()) {
    return; // 오늘 이미 성공
  }
  let data;
  try { data = await fetchOkpos(); }
  catch (e) { log("실패:", e.message); await setStatus(`실패: ${e.message}`, "PC 켤 때 다시 시도함 / 계속 실패하면 확인 필요"); process.exitCode = 1; return; }

  const L = colLetter(WRITE_COLS);
  const sheetHead = ((await getVals(STORE_SHEET_ID, `'${TAB}'!A1:${L}1`))[0] || []).concat(Array(WRITE_COLS).fill("")).slice(0, WRITE_COLS);
  const old = await getVals(STORE_SHEET_ID, `'${TAB}'!A2:${L}`);
  const oldN = old.filter((r) => r.some((x) => String(x).trim())).length;
  const rows = buildRows(sheetHead, data.head, data.rows, old);
  if (oldN && rows.length < oldN * 0.5) {
    const msg = `새 조회 ${rows.length}건이 기존 ${oldN}건의 절반도 안 돼서 덮어쓰지 않음`;
    log(msg); await setStatus(msg, "오케이포스 조회 확인 필요"); process.exitCode = 1; return;
  }
  const n = rows.length;
  await putVals(STORE_SHEET_ID, `'${TAB}'!A2:${L}${n + 1}`, rows);
  if (old.length > n) await clearVals(STORE_SHEET_ID, `'${TAB}'!A${n + 2}:${L}${old.length + 1}`);

  // Z열 줄별 수식(이카운트 연결)을 늘어난 줄에도 채움
  const z = await getVals(STORE_SHEET_ID, `'${TAB}'!Z2:Z${n + 1}`, "FORMULA");
  const zRows = [];
  for (let i = 0; i < n; i++) zRows.push([(z[i] && z[i][0]) || `=XLOOKUP(H${i + 2}, '이카운트'!G:G, '이카운트'!A:A, "없음")`]);
  await putVals(STORE_SHEET_ID, `'${TAB}'!Z2:Z${n + 1}`, zRows, "USER_ENTERED");

  const ki = sheetHead.indexOf("현재고");
  const total = rows.reduce((a, r) => a + (typeof r[ki] === "number" ? r[ki] : 0), 0);
  log(`현재고 탭 ${n}행 갱신 (이전 ${oldN}행), 현재고 합계 ${total}`);
  await setStatus(`성공: ${n}개 상품 갱신 (현재고 합계 ${total})`, "없음");
  if (!DRY) fs.writeFileSync(STATE, today());
}

main().catch(async (e) => { log("오류:", e.message); await setStatus(`오류: ${e.message}`, "확인 필요"); process.exitCode = 1; });

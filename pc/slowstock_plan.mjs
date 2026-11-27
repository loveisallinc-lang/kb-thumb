// 매장 악성재고 → 큐텐 매일 계획표
// 현재고 가져오기(okpos_stock.mjs)가 성공한 뒤 실행된다.
// 하는 일: '악성재고 판매가변경' 탭에서 대상 상품을 고르고, 판매수량(매장 재고 50% 내림)을 정한 뒤,
//          리스팅관리 '큐텐' 탭에서 이미 올라간 리스팅을 찾아 할 일(수량 변경/판매중지/새 리스팅/확인 필요)을
//          '악성재고_큐텐' 탭에 쓴다. 큐텐 사이트에는 아무것도 반영하지 않는다(사장님 확인 후 반영).
// 사용: node slowstock_plan.mjs [--dry]
import { GoogleAuth } from "google-auth-library";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE = "1vWFB4rsdSX222ZPdiBlGNmLFVdezURCq8EEhxTJwNyM";
const LISTING = "13ZYdAxgHANOLGPnoi5biB-QdE5M25wFuEQmL8QzKNZo";
const ORDER = "1tHVsLvcuaU3m5-wJfbuqeWTKsXa6OIk5fZWHGw87Btk";
const PLAN_TAB = "악성재고_큐텐";
const MIN_STOCK = 5; // 매장 재고 이 개수 미만이면 큐텐에 올리지 않음
const HEAD = ["날짜", "바코드", "상품명", "구분", "등급", "매장재고", "판매수량", "큐텐 코드", "큐텐 행", "이전 판매수량", "할 일", "상태", "메모"];
const DRY = process.argv.includes("--dry");
const EXCLUDE = /탑로더|카드홀더|건전지|밧데리|배터리/;
// 사장님 규칙(2026-11-27): 악성재고는 음반과 MD(케이팝 굿즈)만. 문구(캐릭터 스티커·카드 등)와 응원봉은 올리지 않음
const STATIONERY = /커비|다마고치|산리오|포켓몬|미피|바비|모프샌드|에스더버니|케로로|티니핑|하츄핑|스누피|블루록|흐리멍텅|폼폼푸린|쿠로미|헬로키티|시나모롤|포차코|마이멜로디|한교동/;
const LOG = path.join(DIR, "log.txt");

const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
const today = () => kstNow().slice(0, 10);
function log(...a) {
  const line = `[${kstNow()}] [계획] ${a.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\r\n"); } catch {}
}

const auth = new GoogleAuth({ keyFile: path.join(DIR, "sa.json"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
async function req(opts) { const c = await auth.getClient(); return (await c.request(opts)).data; }
const vurl = (sid, rng, suf = "") => `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(rng)}${suf}`;
const getVals = async (sid, rng) => (await req({ url: vurl(sid, rng) })).values || [];
async function putVals(sid, rng, values, mode = "RAW") {
  if (DRY) return log(`DRY put ${rng} (${values.length}행)`);
  await req({ url: vurl(sid, rng), method: "PUT", params: { valueInputOption: mode }, data: { values } });
}
async function clearVals(sid, rng) { if (!DRY) await req({ url: vurl(sid, rng, ":clear"), method: "POST" }); }
async function ensureTab(sid, title) {
  const meta = await req({ url: `https://sheets.googleapis.com/v4/spreadsheets/${sid}`, params: { fields: "sheets.properties.title" } });
  if (meta.sheets.some((s) => s.properties.title === title)) return false;
  if (DRY) { log(`DRY 탭 만들기 ${title}`); return true; }
  await req({ url: `https://sheets.googleapis.com/v4/spreadsheets/${sid}:batchUpdate`, method: "POST",
    data: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] } });
  return true;
}

const s = (x) => String(x ?? "").trim();
const num = (x) => { const n = Number(s(x).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const normBc = (b) => s(b).replace(/\s/g, "");

async function main() {
  const day = today();

  // 1) 대상 상품
  const src = await getVals(STORE, "'악성재고 판매가변경'!B3:O");
  const items = new Map(); // 바코드 → {name, kind, grade, stock, price}
  for (const r of src) {
    const bc = normBc(r[0]); if (!bc) continue;
    const it = items.get(bc) || { bc, name: s(r[1]), kind: s(r[2]), grade: s(r[3]), stock: 0, price: s(r[13]) };
    it.stock += num(r[4]);
    items.set(bc, it);
  }
  const eligible = (it) => {
    if (EXCLUDE.test(it.name)) return false;
    if (it.kind === "음반") return it.grade === "악성";
    if (it.kind === "굿즈") return !STATIONERY.test(it.name) && ["악성", "주의", "과재고"].includes(it.grade);
    return false;
  };
  const target = new Map();
  for (const it of items.values()) if (eligible(it)) target.set(it.bc, { ...it, qty: Math.floor(it.stock / 2) });

  // 매장 현재고(대상에서 빠진 상품의 메모용)
  const stockRows = await getVals(STORE, "'현재고'!A2:K");
  const storeStock = new Map();
  for (const r of stockRows) { const bc = normBc(r[7]); if (bc) storeStock.set(bc, (storeStock.get(bc) || 0) + num(r[10])); }

  // 2) 큐텐 탭 색인
  const qa = await getVals(LISTING, "'큐텐'!A1:C");
  const qbd = await getVals(LISTING, "'큐텐'!BD1:BD");
  const byCode = new Map();      // 코드 → 행
  const byOpt = new Map();       // 바코드 → {row, code, stock}
  const dmRows = [];             // 매장 리스팅(DM) 행
  for (let i = 0; i < qa.length; i++) {
    const code = s(qa[i][1]); if (!code) continue;
    const row = i + 1;
    if (!byCode.has(code)) byCode.set(code, row);
    const bd = s(qbd[i] && qbd[i][0]);
    const isDM = /^DM/.test(code) || /^A\d+A$/.test(code);
    if (isDM) dmRows.push({ row, code, name: s(qa[i][2]), bd });
    if (isDM && bd) {
      for (const part of bd.replace(/\r?\n/g, "").split("$$")) {
        const f = part.split("||*");
        if (f.length < 5) continue;
        const ob = normBc(f[f.length - 1]);
        if (!byOpt.has(ob)) byOpt.set(ob, { row, code, stock: s(f[f.length - 2]) });
      }
    }
  }

  // 음반 일반 리스팅: 신보 탭 바코드(Q) → 상품코드(R)
  const sinbo = await getVals(ORDER, "'신보'!Q2:R");
  const albumCode = new Map();
  for (const r of sinbo) { const bc = normBc(r[0]), c = s(r[1]); if (bc && c && !albumCode.has(bc)) albumCode.set(bc, c); }

  // 3) 기존 계획표(이전 반영 수량)
  const created = await ensureTab(LISTING, PLAN_TAB);
  const old = created ? [] : await getVals(LISTING, `'${PLAN_TAB}'!A2:M`);
  const lastDone = new Map(); // 바코드 → 마지막 반영완료 판매수량
  for (const r of old) if (s(r[11]) === "반영완료" && s(r[1])) lastDone.set(normBc(r[1]), s(r[6]));
  const prevOf = (bc, opt) => lastDone.has(bc) ? lastDone.get(bc) : (opt && opt.stock !== "" ? opt.stock : "모름");

  // 4) 할 일 정하기
  const out = [];
  const seen = new Set();
  for (const t of target.values()) {
    let code = "", row = "", prev = "", act = "", memo = "";
    const opt = byOpt.get(t.bc);
    if (byCode.has("DM" + t.bc)) { code = "DM" + t.bc; row = byCode.get(code); }
    else if (/^A\d+A$/.test(t.bc) && byCode.has(t.bc)) { code = t.bc; row = byCode.get(code); }
    else if (opt) { code = opt.code; row = opt.row; }
    else if (/^A\d{8,14}A$/.test(t.bc) && byCode.has("DM" + t.bc.slice(1, -1))) { code = "DM" + t.bc.slice(1, -1); row = byCode.get(code); memo = "러비솔 바코드 → 같은 상품 리스팅"; }
    if (code) {
      seen.add(t.bc); if (/^A\d+A$/.test(t.bc)) seen.add(t.bc.slice(1, -1));
      prev = prevOf(t.bc, opt);
      if (t.qty === 0) act = prev === "0" ? "유지" : "판매중지";
      else act = String(t.qty) === prev ? "유지" : "수량 변경";
      if (opt && code === opt.code) memo = "묶음 리스팅 옵션";
      if (prev === "모름") memo = (memo ? memo + ", " : "") + "현재 큐텐 수량 모름";
    } else if (byCode.has(t.bc)) {
      code = t.bc; row = byCode.get(code); prev = "모름";
      act = "확인 필요"; memo = "바코드를 코드로 쓴 일반 리스팅이 있음 → 이걸로 수량만 바꿀지 확인";
    } else if (t.kind === "음반" && albumCode.has(t.bc) && byCode.has(albumCode.get(t.bc))) {
      code = albumCode.get(t.bc); row = byCode.get(code); prev = "모름";
      act = "확인 필요"; memo = "신보로 올린 일반 리스팅이 있음 → 매장 재고분을 따로 올릴지/수량만 바꿀지 확인";
    } else if (t.qty > 0) {
      act = "새 리스팅"; memo = `매장가 ${t.price}`;
    } else continue; // 판매수량 0이고 리스팅도 없음
    // 사장님 규칙(2026-11-27): 악성재고는 매장 재고 5개 이상일 때만 큐텐에 올린다.
    if (t.stock < MIN_STOCK) {
      if (!code) continue; // 새 리스팅 안 함
      act = "5개 미만"; memo = `매장 재고 ${t.stock}개(5개 미만) → 수량 안 바꿈. 이미 있는 리스팅은 사장님 확인`;
    }
    if (act === "유지") continue;
    out.push([day, t.bc, t.name, t.kind, t.grade, t.stock, t.qty, code, row, prev, act, "대기", memo]);
  }

  // 대상에서 빠졌는데 큐텐에 남아 있는 매장 리스팅 → 판매중지
  const stopBc = (bc, code, row, name, opt) => {
    if (seen.has(bc) || target.has(bc)) return;
    seen.add(bc);
    const prev = prevOf(bc, opt);
    if (prev === "0") return;
    const it = items.get(bc);
    const st = storeStock.has(bc) ? storeStock.get(bc) : "";
    if (!it && st !== "" && st >= 2) {
      // 악성재고 목록에서 빠졌지만 매장에 재고가 있음 → 판매 계속(50%)할지 사장님 확인
      const q = Math.floor(st / 2);
      if (String(q) === prev) return;
      out.push([day, bc, name, "", "", st, q, code, row, prev, "확인 필요", "대기",
        `악성재고 목록에서 빠졌지만 매장 재고 ${st} → 판매수량 ${q}로 계속 팔지, 판매중지할지 확인`]);
      return;
    }
    const why = it ? `대상 아님(${it.kind}/${it.grade || "등급 없음"})` : "악성재고 목록에서 빠짐";
    out.push([day, bc, it ? it.name : name, it ? it.kind : "", it ? it.grade : "", st, 0, code, row, prev, "판매중지", "대기", `${why}, 매장 재고 ${st === "" ? "모름" : st}`]);
  };
  for (const d of dmRows) {
    if (d.bd) {
      for (const part of d.bd.replace(/\r?\n/g, "").split("$$")) {
        const f = part.split("||*"); if (f.length < 5) continue;
        const ob = normBc(f[f.length - 1]);
        stopBc(ob, d.code, d.row, `${d.name} / ${f[1]}`, { stock: s(f[f.length - 2]) });
      }
    } else {
      const bc = d.code.replace(/^DM/, "");
      if (/^\d{8,14}$/.test(bc) || /^A\d+A$/.test(bc)) stopBc(bc, d.code, d.row, d.name, null);
    }
  }

  // 5) 쓰기: 오늘 '대기' 행은 새로 계산한 것으로 바꾼다
  const keep = old.filter((r) => !(s(r[0]) === day && s(r[11]) === "대기"));
  const all = [HEAD, ...keep.map((r) => HEAD.map((_, i) => r[i] ?? "")), ...out];
  await putVals(LISTING, `'${PLAN_TAB}'!A1:M${all.length}`, all);
  if (old.length + 1 > all.length) await clearVals(LISTING, `'${PLAN_TAB}'!A${all.length + 1}:M${old.length + 1}`);

  const cnt = (a) => out.filter((r) => r[10] === a).length;
  const summary = `수량 변경 ${cnt("수량 변경")} / 5개 미만 ${cnt("5개 미만")} / 판매중지 ${cnt("판매중지")} / 새 리스팅 ${cnt("새 리스팅")} / 확인 필요 ${cnt("확인 필요")}`;
  log(`대상 ${target.size}개, ${summary}`);
  await putVals(LISTING, "'자동화_상태'!A6:E6", [["악성재고 → 큐텐 계획", kstNow(), summary,
    out.length ? "계획표('악성재고_큐텐' 탭) 확인 후 '반영'이라고 말하기" : "없음",
    "현재고 가져오기 성공 직후 PC에서 자동 (큐텐 반영은 사장님 OK 후)"]], "USER_ENTERED");
  if (DRY) {
    const pick = process.argv.find((a) => a.startsWith("--show="));
    const want = pick ? pick.slice(7) : "";
    for (const r of out.filter((r) => !want || r[10] === want).slice(0, 60)) console.log(r.join(" | "));
  }
}

main().catch(async (e) => {
  log("오류:", e.message);
  try { await putVals(LISTING, "'자동화_상태'!A6:E6", [["악성재고 → 큐텐 계획", kstNow(), `오류: ${e.message}`, "확인 필요", ""]], "USER_ENTERED"); } catch {}
  process.exitCode = 1;
});

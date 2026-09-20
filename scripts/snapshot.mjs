/**
 * 법령 스냅샷 수집기 — 국가법령정보 OPEN API 판
 *
 * 하는 일
 *   1) laws.json에 적힌 법령을 lawSearch.do로 찾아 법령일련번호(MST)를 얻는다
 *   2) lawService.do로 각 조문의 원문을 받는다
 *   3) 도구가 전제한 기준 문구(expect)가 원문에 아직 그대로 있는지 대조한다
 *   4) 결과를 public/snapshot.json으로 저장한다
 *
 * 설계 원칙
 *   - 판정을 바꾸지 않는다. 이 스크립트는 "검증"만 한다.
 *     법이 바뀌면 값을 몰래 고치는 대신 verified=false로 내려 사람에게 알린다.
 *     법률 데이터를 자동으로 덮어쓰는 것이 조용히 틀리는 가장 빠른 길이기 때문이다.
 *   - 일부가 실패해도 전체를 중단하지 않는다 (부분 성공 허용)
 *   - 전부 실패하면 기존 snapshot.json을 그대로 둔다 (빈 파일로 덮어쓰지 않음)
 *   - 실패는 snapshot.json 안에 남긴다 (조용한 실패 금지)
 *   - API 응답의 키 이름에 최소한으로만 의존한다. 스키마가 조금 바뀌어도
 *     트리를 훑어 필요한 값을 찾는다.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = process.cwd();
const REGISTRY = path.join(ROOT, "laws.json");
const OUT_DIR = path.join(ROOT, "public");
const OUT = path.join(OUT_DIR, "snapshot.json");

const OC = process.env.LAW_OC;            // 국가법령정보 OPEN API 신청 ID
const BASE = process.env.LAW_BASE || "https://www.law.go.kr/DRF";  // 테스트용으로만 교체
const TIMEOUT_MS = 20000;
const PAUSE_MS = 700;                      // 서버 예의

if (!OC) {
  console.error("환경변수 LAW_OC가 없습니다. GitHub Secrets에 LAW_OC를 등록하세요.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 공통 ---------- */

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "Accept-Language": "ko", "User-Agent": "RuleCheck-Snapshot/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const head = body.slice(0, 200).trim();
    if (!head.startsWith("{") && !head.startsWith("[")) {
      // JSON이 아니면 대개 OC 오류나 차단 안내 페이지다
      throw new Error(`JSON이 아닌 응답: ${head.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

/** 하위의 모든 문자열 값 */
function leaves(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const v of node) leaves(v, out); return out; }
  if (typeof node === "object") { for (const v of Object.values(node)) leaves(v, out); return out; }
  if (typeof node === "string" || typeof node === "number") out.push(String(node));
  return out;
}

/** 트리 전체를 훑어 키 이름이 re에 맞는 문자열 값을 모은다 */
function collect(node, re, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const v of node) collect(v, re, out); return out; }
  if (typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node)) {
    if (re.test(k)) {
      if (typeof v === "string" || typeof v === "number") out.push(String(v));
      else leaves(v, out);        // 키는 맞는데 값이 객체/배열이면 그 안의 문자열을 전부
    } else {
      collect(v, re, out);        // 중복 수집을 막으려고 맞은 가지는 다시 파지 않는다
    }
  }
  return out;
}

/** 트리에서 키 이름이 re에 맞는 첫 문자열 값 */
function first(node, re) {
  const all = collect(node, re);
  return all.length ? all[0] : null;
}

function clean(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- 1단계: 법령명 → MST ---------- */

async function resolveLaw(spec) {
  const url =
    `${BASE}/lawSearch.do?OC=${encodeURIComponent(OC)}&target=law&type=JSON` +
    `&display=20&query=${encodeURIComponent(spec.search)}`;
  const data = await getJson(url);

  // 검색 결과 배열을 찾는다 (LawSearch.law 가 보통이지만 형태를 가정하지 않는다)
  let rows = [];
  (function dig(n) {
    if (Array.isArray(n)) {
      if (n.some((x) => x && typeof x === "object" && first(x, /법령명/))) rows = rows.concat(n);
      n.forEach(dig);
      return;
    }
    if (n && typeof n === "object") {
      // 결과가 1건이면 배열이 아니라 객체로 온다
      if (first(n, /법령명/) && first(n, /법령일련번호|법령ID/)) rows.push(n);
      Object.values(n).forEach(dig);
    }
  })(data);

  if (!rows.length) throw new Error(`검색 결과 없음: ${spec.search}`);

  // 현행 법률 중 이름이 가장 잘 맞는 것
  const scored = rows
    .map((r) => {
      const name = clean(first(r, /법령명/));
      const mst = first(r, /법령일련번호/) || first(r, /법령ID/);
      const kind = clean(first(r, /법령구분명|법종구분/) || "");
      let score = 0;
      if (name === spec.search) score += 100;
      if (name.startsWith(spec.search)) score += 50;
      if (/법률/.test(kind)) score += 10;
      if (/시행령|시행규칙/.test(name)) score -= 80;   // 본법을 원한다
      score -= Math.abs(name.length - spec.search.length);
      return { name, mst, kind, score };
    })
    .filter((r) => r.mst)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) throw new Error(`법령일련번호를 찾지 못함: ${spec.search}`);
  const best = scored[0];
  if (spec.exact && best.name !== spec.search) {
    throw new Error(`이름이 정확히 일치하지 않음: 요청 "${spec.search}" / 응답 "${best.name}"`);
  }
  return best;
}

/* ---------- 2단계: 조문 원문 ---------- */

async function fetchArticle(mst, jo) {
  let url = `${BASE}/lawService.do?OC=${encodeURIComponent(OC)}&target=law&type=JSON&MST=${encodeURIComponent(mst)}`;
  if (jo) url += `&JO=${encodeURIComponent(jo)}`;
  const data = await getJson(url);

  const lawName = clean(first(data, /법령명_한글|법령명한글|법령명/));
  const enforced = first(data, /조문시행일자/) || first(data, /^시행일자$/);
  const jono = first(data, /조문번호/);

  // 제목(조문내용)이 먼저, 그 다음 항·호·목 본문 순서로 이어붙인다
  const head = collect(data, /조문내용/).map(clean).filter(Boolean);
  const body = collect(data, /항내용|호내용|목내용/).map(clean).filter(Boolean);
  const text = head.concat(body).join(" ").replace(/\s+/g, " ").trim();

  if (!text) throw new Error("조문 본문을 찾지 못했습니다 (응답 구조 변경 의심)");
  return { lawName, enforced, jono, text };
}

/* ---------- 본 작업 ---------- */

async function main() {
  const reg = JSON.parse(await readFile(REGISTRY, "utf8"));
  const items = reg.items || [];
  if (!items.length) {
    console.error("laws.json에 항목이 없습니다.");
    process.exit(1);
  }

  let prev = null;
  if (existsSync(OUT)) {
    try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch { /* 무시 */ }
  }
  const prevById = {};
  (prev?.items || []).forEach((x) => { prevById[x.id] = x; });

  // 법령별 MST를 한 번씩만 조회
  const resolved = {};
  for (const [key, spec] of Object.entries(reg.laws || {})) {
    try {
      resolved[key] = await resolveLaw(spec);
      console.log(`법령 확인  ${key} → ${resolved[key].name} (MST ${resolved[key].mst})`);
    } catch (e) {
      resolved[key] = { error: String(e.message || e) };
      console.log(`법령 실패  ${key} — ${resolved[key].error}`);
    }
    await sleep(PAUSE_MS);
  }

  // 같은 조문을 두 항목이 함께 보는 경우가 있으므로 조문 단위로 캐시
  const artCache = new Map();
  async function article(lawKey, jo) {
    const k = `${lawKey}|${jo || "ALL"}`;
    if (artCache.has(k)) return artCache.get(k);
    const law = resolved[lawKey];
    if (!law || law.error) throw new Error(law?.error || `등록되지 않은 법령: ${lawKey}`);
    const a = await fetchArticle(law.mst, jo);
    artCache.set(k, a);
    await sleep(PAUSE_MS);
    return a;
  }

  console.log(`\n조문 ${items.length}건 대조 시작`);
  const results = [];

  for (const it of items) {
    const before = prevById[it.id];

    if (it.manual) {
      results.push({
        id: it.id, law: it.label, ok: true, verified: false, manual: true,
        note: it.manual, checked_at: new Date().toISOString(),
      });
      console.log(`  수동   ${it.id} ${it.label}`);
      continue;
    }

    try {
      const a = await article(it.law, it.jo);
      const missing = (it.expect || []).filter((w) => !a.text.includes(w));
      const hash = createHash("sha256").update(a.text).digest("hex").slice(0, 16);
      const changed = !!(before && before.hash && before.hash !== hash);

      results.push({
        id: it.id,
        law: it.label,
        ok: true,
        verified: missing.length === 0,
        changed,
        missing,
        hash,
        enforced: a.enforced || null,
        length: a.text.length,
        text: a.text.slice(0, 1500),
        checked_at: new Date().toISOString(),
      });

      if (missing.length) {
        console.log(`  기준값 없음 ${it.id} ${it.label} — 원문에서 사라진 문구: ${missing.join(", ")}`);
      } else if (changed) {
        console.log(`  본문 변경 ${it.id} ${it.label} — 기준값은 유지됨`);
      } else {
        console.log(`  OK     ${it.id} ${it.label}`);
      }
    } catch (e) {
      results.push({
        id: it.id, law: it.label, ok: false, verified: false,
        error: String(e.message || e),
        // 실패했다고 직전 검증 결과까지 버리지는 않는다
        hash: before?.hash || null,
        checked_at: new Date().toISOString(),
      });
      console.log(`  실패   ${it.id} ${it.label} — ${String(e.message || e)}`);
    }
  }

  const okCount = results.filter((r) => r.ok && !r.manual).length;
  if (okCount === 0) {
    console.error("\n전부 실패했습니다. 기존 스냅샷을 유지하고 종료합니다.");
    process.exit(1);
  }

  const snapshot = {
    updated_at: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    source: "국가법령정보 OPEN API (law.go.kr/DRF)",
    method: "조문 원문을 받아 도구가 전제한 기준 문구가 그대로인지 대조합니다. 값을 자동으로 고치지는 않습니다.",
    total: results.length,
    ok: okCount,
    failed: results.filter((r) => !r.ok).length,
    unverified: results.filter((r) => !r.verified).map((r) => r.id),
    changed: results.filter((r) => r.changed).map((r) => r.id),
    items: results,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot, null, 2), "utf8");

  console.log(
    `\n완료: 검증 ${results.filter((r) => r.verified).length} / 미검증 ${snapshot.unverified.length} ` +
    `/ 실패 ${snapshot.failed} / 본문 변경 ${snapshot.changed.length}`
  );
  if (snapshot.unverified.length) {
    console.log(`\n사람이 확인해야 할 항목: ${snapshot.unverified.join(", ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

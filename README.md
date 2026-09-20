# 법령 원문 일일 재확인 키트

취업규칙 법령 점검기가 전제한 **조문 원문이 아직 그대로인지** 매일 새벽 4시에 자동으로 다시 확인합니다.
국가법령정보 OPEN API에서 조문을 직접 받아, 도구가 기준으로 삼은 문구가 원문에서 사라졌는지 대조합니다.

## 이 키트가 하지 않는 것

**법령 값을 자동으로 고치지 않습니다.**
법이 바뀌면 숫자를 몰래 덮어쓰는 대신 그 항목을 **미검증**으로 내리고, 무엇이 사라졌는지 기록합니다.
자동으로 고치면 틀린 값이 조용히 배포되고, 이 도구에서 그건 과태료로 이어집니다.
사람이 확인하고 고치게 만드는 것이 이 설계의 핵심입니다.

## 들어 있는 것

```
laws.json                        점검 항목 15건 ↔ 조문 대응표 (기준 문구 포함)
scripts/snapshot.mjs             수집·대조 스크립트 (의존성 없음, Node 20+)
scripts/_mocktest.mjs            가짜 API 서버 — 스크립트 자체 점검용
.github/workflows/daily-snapshot.yml   매일 04:00(KST) 자동 실행
public/snapshot.json             (실행하면 생김) 점검기가 읽어가는 결과 파일
```

## 설치 — 순서대로

### 1. GitHub 저장소 만들기
github.com → 오른쪽 위 `+` → **New repository** → 이름 아무거나 (예: `rulecheck-laws`) → **Public** → Create.

### 2. 파일 올리기
새 저장소 화면의 **uploading an existing file** 링크 → 이 폴더의 내용물을 통째로 끌어다 놓기 → Commit.
`.github` 폴더가 같이 올라갔는지 꼭 확인하세요. (숨김 폴더라 빠지기 쉽습니다.)

### 3. OPEN API ID를 비밀값으로 넣기
저장소 → **Settings** → 왼쪽 **Secrets and variables** → **Actions** → **New repository secret**

| 항목 | 값 |
|---|---|
| Name | `LAW_OC` |
| Secret | `dine512` |

> 코드에 직접 적지 않고 여기에 넣는 이유: 공개 저장소라 소스가 그대로 읽힙니다.

### 4. 한 번 돌려보기
저장소 → **Actions** 탭 → 초록 버튼으로 Actions 활성화 → 왼쪽에서 **법령 원문 일일 재확인** →
오른쪽 **Run workflow** → 1~2분 뒤 초록 체크.

로그에 이렇게 나오면 성공입니다.

```
법령 확인  근로기준법 → 근로기준법 (MST ...)
조문 15건 대조 시작
  OK     ST-050 근로기준법 제50조
  ...
완료: 검증 14 / 미검증 1 / 실패 0 / 본문 변경 0
사람이 확인해야 할 항목: GS-001
```

`GS-001`(최저임금)은 고용노동부 **고시**라 법령 API 대상이 아닙니다. 매년 8월 초에 직접 확인하세요.
이건 고장이 아니라 설계상 그렇게 표시되는 항목입니다.

### 5. 점검기와 연결하기
`public/snapshot.json` 파일을 열고 → **Raw** 버튼 → 주소창의 URL을 복사합니다.
`https://raw.githubusercontent.com/<아이디>/<저장소>/main/public/snapshot.json` 모양입니다.

점검기 소스에서 이 줄을 찾아 그 URL을 넣으면 끝입니다.

```js
const SNAPSHOT_URL = "";   // ← 여기에 붙여넣기
```

이후 점검기 하단 문구가 이렇게 바뀝니다.
`… OPEN API 조문 원문 자동 재확인 2026-09-21 19:02 UTC · 15건 반영 · 전량 검증`

## 결과 읽는 법

`public/snapshot.json`의 각 항목:

| 값 | 뜻 | 점검기 표시 |
|---|---|---|
| `verified: true` | 기준 문구가 원문에 그대로 있음 | 검증됨 |
| `missing: [...]` | 원문에서 그 문구가 사라짐 → **법이 바뀌었을 가능성** | 미검증 + 사라진 문구 안내 |
| `changed: true` | 조문 본문은 바뀌었으나 기준값은 유지됨 | 검증됨 + 변경 안내 |
| `ok: false` | 수집 실패 (API 장애 등) | 미검증 + 실패 사유 |

`missing`이 뜨면 해당 조문을 법제처에서 직접 읽고, 점검기의 `std[]`/`ams[]` 값을 고친 뒤
`laws.json`의 `expect` 문구도 새 원문에 맞게 갱신하세요.

## 스크립트만 따로 돌려보기

```bash
LAW_OC=dine512 node scripts/snapshot.mjs
```

네트워크 없이 논리만 점검하려면:

```bash
node scripts/_mocktest.mjs &                                  # 가짜 API
LAW_OC=test LAW_BASE=http://127.0.0.1:8731/DRF node scripts/snapshot.mjs
```

## 안전장치

- 일부 조문이 실패해도 나머지는 계속 수집합니다.
- **전부 실패하면** 기존 `snapshot.json`을 덮어쓰지 않고 종료 코드 1로 실패합니다.
  (빈 파일이 배포되어 점검기가 근거를 잃는 상황을 막습니다. Actions 탭에 빨간 X로 남습니다.)
- API 응답의 키 이름이 조금 바뀌어도 트리를 훑어 값을 찾습니다.
  본문을 아예 못 찾으면 그 항목만 실패로 기록합니다.

## 출처

국가법령정보 공동활용 OPEN API — https://open.law.go.kr

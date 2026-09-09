const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ANALYSIS_AT = new Date("2026-08-31T23:59:59+09:00");
const SEED = 20260831;
// Synthetic learning-sample design, not measured industry benchmarks.
// category, total, processing, open, aged, high priority, urgent priority
const DESIGN = [
  ["계정·접근", 72, 11, 5, 8, 20, 5],
  ["가입·온보딩", 46, 5, 3, 2, 6, 0],
  ["결제·환불", 66, 11, 4, 7, 20, 2],
  ["서비스 이용", 80, 9, 5, 4, 12, 0],
  ["오류·장애", 50, 8, 3, 5, 14, 14],
  ["해지·변경", 32, 4, 2, 2, 5, 0],
  ["정책·혜택", 36, 3, 2, 1, 4, 0],
  ["의견·요청", 26, 3, 1, 1, 2, 0],
  ["기타", 12, 2, 1, 0, 1, 0],
];
const categories = DESIGN.map(([category]) => category);
// subcategory, count, description variants, tentative cause tag, operational next action
const TOPICS = {
  "계정·접근": [
    ["로그인 실패", 28, ["비밀번호 입력 후에도 로그인 화면으로 돌아옴", "로그인 시도가 반복 실패해 이용을 시작하지 못함", "정상 계정으로 로그인했지만 접속이 유지되지 않음"], "인증 오류 확인 필요", "인증 상태 및 오류 로그 확인"],
    ["인증 오류", 20, ["인증번호를 입력했지만 인증이 완료되지 않음", "인증번호가 늦게 도착해 입력 시간이 만료됨", "본인 인증 단계에서 다음 화면으로 넘어가지 않음"], "인증 전달 경로 확인 필요", "인증 발송 이력과 만료 조건 확인"],
    ["비밀번호 재설정", 16, ["재설정 링크를 눌러도 다시 로그인 화면으로 이동함", "비밀번호 변경 안내 메일의 유효시간을 문의", "비밀번호를 변경한 뒤 로그인 방법을 다시 확인 요청"], "사용 경로 확인 필요", "재설정 링크와 안내 절차 확인"],
    ["계정 정보 변경", 8, ["계정 정보 수정 메뉴의 위치를 찾지 못함", "연락처 변경 후 다시 인증해야 하는지 문의", "계정에 표시되는 기본 정보 변경 방법을 문의"], "안내 부족 가능성", "정보 변경 경로와 인증 조건 안내"],
  ],
  "가입·온보딩": [
    ["초기 설정", 20, ["가입 완료 후 초기 설정 메뉴 위치를 찾지 못함", "처음 이용할 때 필요한 설정 순서를 문의", "초기 설정을 건너뛰었는데 다시 진행할 수 있는지 문의"], "온보딩 안내 부족 가능성", "초기 설정 도움말 제공 및 노출 위치 검토"],
    ["사용 시작 방법", 12, ["가입 후 서비스를 어디서 시작하는지 문의", "첫 이용에 필요한 준비 사항을 확인 요청", "사용 시작 안내를 다시 볼 수 있는지 문의"], "사용 시작 경로 확인 필요", "첫 이용 가이드와 시작 경로 안내"],
    ["가입 절차", 8, ["가입 신청 후 남은 절차를 확인 요청", "가입 도중 중단한 내용을 이어서 입력할 수 있는지 문의", "가입에 필수인 정보와 선택 정보를 구분해 달라고 요청"], "가입 절차 안내 확인 필요", "가입 단계와 필수 항목 안내"],
    ["인증 완료", 6, ["가입 인증이 완료되었는지 확인 요청", "인증 완료 안내 후 다음 진행 방법을 문의", "가입 인증 확인 메일을 다시 받을 수 있는지 문의"], "완료 상태 노출 확인 필요", "인증 완료 상태와 후속 단계 안내"],
  ],
  "결제·환불": [
    ["환불 기준", 22, ["사용을 시작한 뒤에도 환불할 수 있는지 문의", "환불 신청 기한과 제외 조건을 확인 요청", "환불 가능한 금액이 어떻게 계산되는지 문의"], "환불 안내 부족 가능성", "이용 이력과 환불 기준 확인 후 안내"],
    ["환불 진행상태", 20, ["환불 신청 후 처리 상태를 어디서 확인하는지 문의", "환불 접수 안내를 받았지만 다음 일정이 보이지 않음", "환불 완료 안내와 실제 반영 시점의 차이를 문의"], "진행상태 노출 확인 필요", "환불 진행상태 확인 후 예상 일정 안내"],
    ["결제 실패", 10, ["결제 완료 화면이 나타나지 않아 이용을 진행하지 못함", "승인 실패 안내 후 다시 결제해도 되는지 문의", "결제 시도 후 서비스 이용 권한이 반영되지 않음"], "결제 상태 확인 필요", "승인 내역과 이용 권한 반영 상태 확인"],
    ["중복 결제", 6, ["같은 이용 건에 결제 안내가 두 번 도착함", "재시도 후 승인 내역이 중복으로 보여 확인 요청", "결제 내역에 동일한 금액이 두 건 표시됨"], "중복 승인 여부 확인 필요", "거래 식별값 대조 후 중복 여부 확인"],
    ["결제수단 변경", 8, ["다음 결제부터 다른 결제수단을 사용하고 싶음", "등록된 결제수단을 삭제하는 방법을 문의", "결제수단 변경 내용이 언제 적용되는지 문의"], "결제 설정 경로 확인 필요", "결제수단 변경 경로와 적용 시점 안내"],
  ],
  "서비스 이용": [
    ["기능 사용법", 30, ["주요 기능을 처음 사용하는 순서를 문의", "도움말을 읽었지만 기능 실행 위치를 찾지 못함", "이용 중인 기능의 기본 동작 방식을 확인 요청"], "사용법 안내 부족 가능성", "기능 도움말 제공 및 설명 보완 항목 기록"],
    ["설정 변경", 18, ["변경한 설정이 다음 이용에도 유지되는지 문의", "기본 설정으로 되돌리는 방법을 문의", "설정 변경 후 적용 여부를 어디서 확인하는지 문의"], "설정 안내 경로 확인 필요", "설정 저장 조건과 변경 경로 안내"],
    ["이용 방법", 20, ["이용 이력을 다시 확인하는 방법을 문의", "중단한 작업을 이어서 진행할 수 있는지 문의", "자주 사용하는 메뉴에 빠르게 접근하는 방법을 문의"], "사용 경로 확인 필요", "이용 경로 안내 및 도움말 접근성 검토"],
    ["콘텐츠/기능 접근", 12, ["이용 가능한 기능의 범위를 확인 요청", "일부 콘텐츠의 접근 조건이 궁금하다고 문의", "현재 이용 상태에서 사용할 수 있는 메뉴를 문의"], "접근 조건 안내 확인 필요", "이용 권한과 접근 조건 대조 후 안내"],
  ],
  "오류·장애": [
    ["접속 장애", 18, ["서비스 화면이 열리지 않아 이용을 중단함", "연결이 끊겨 진행 중인 작업을 완료하지 못함", "접속 대기 화면이 계속 표시되어 확인 요청"], "서비스 장애 영향 가능성", "영향 범위 확인 후 장애 처리 담당 연결"],
    ["앱 오류", 12, ["앱 실행 직후 종료되어 이용하지 못함", "앱에서 특정 메뉴를 열면 응답이 멈춤", "앱을 다시 실행해도 같은 오류 안내가 나타남"], "앱 환경 확인 필요", "앱 버전과 발생 환경 확인 후 재현 요청"],
    ["기능 작동 오류", 12, ["저장 버튼을 눌렀지만 변경 내용이 반영되지 않음", "기능 실행 중 오류 안내가 나타나 작업을 멈춤", "반복 실행해도 요청한 작업이 완료되지 않음"], "추가 로그 확인 필요", "발생 시각과 재현 절차 확인 후 담당 이관"],
    ["화면 오류", 8, ["일부 화면의 안내 문구가 겹쳐서 보임", "목록 화면이 빈 상태로 표시되어 확인 요청", "화면을 새로 열어도 이전 정보가 계속 나타남"], "화면 표시 오류 확인 필요", "화면 환경과 데이터 갱신 상태 확인"],
  ],
  "해지·변경": [
    ["구독 해지", 12, ["구독 해지 후 남은 기간에도 이용할 수 있는지 문의", "해지 신청이 정상 접수되었는지 확인 요청", "구독 해지 메뉴로 이동하는 방법을 문의"], "해지 안내 부족 가능성", "해지 상태와 잔여 이용 기간 안내"],
    ["플랜 변경", 8, ["이용 중인 플랜을 변경하면 언제 적용되는지 문의", "플랜 변경에 따른 차액 처리 기준을 문의", "현재 플랜과 다른 플랜의 이용 범위를 확인 요청"], "변경 조건 확인 필요", "플랜 적용 시점과 차액 기준 안내"],
    ["자동결제 해제", 8, ["다음 자동결제를 중지하는 방법을 문의", "자동결제 해제 후 별도 해지 절차가 필요한지 문의", "자동결제 중지 설정이 반영되었는지 확인 요청"], "결제 설정 안내 확인 필요", "자동결제 설정 상태와 다음 예정일 확인"],
    ["서비스 종료 절차", 4, ["이용 종료 전 확인할 항목을 문의", "서비스 종료 시 남은 이용 내역을 확인하고 싶음", "종료 신청을 취소할 수 있는 기간을 문의"], "종료 절차 안내 확인 필요", "종료 절차와 사전 확인 항목 안내"],
  ],
  "정책·혜택": [
    ["프로모션", 10, ["진행 중인 프로모션의 참여 조건을 문의", "프로모션 참여가 정상 반영되었는지 확인 요청", "이전 참여 이력이 있어도 행사에 참여할 수 있는지 문의"], "참여 조건 안내 확인 필요", "프로모션 기간과 대상 조건 확인"],
    ["할인 조건", 10, ["할인 적용 조건과 제외 대상을 문의", "여러 할인 중 함께 적용할 수 있는 항목을 문의", "예상한 할인 금액과 실제 표시 금액이 다름"], "할인 조건 확인 필요", "할인 적용 기준과 중복 조건 대조"],
    ["혜택 적용", 10, ["받은 혜택을 어디에서 사용하는지 문의", "혜택 사용 기한과 잔여 여부를 확인 요청", "혜택을 선택했지만 적용 표시가 나타나지 않음"], "혜택 상태 확인 필요", "혜택 사용 이력과 적용 상태 확인"],
    ["이용 정책", 6, ["이용 정책의 특정 제한 범위를 문의", "정책 변경 안내가 언제 적용되는지 문의", "현재 이용 방식이 정책상 가능한지 확인 요청"], "정책 문구 명확성 확인 필요", "관련 정책 항목과 적용 시점 안내"],
  ],
  "의견·요청": [
    ["기능 개선 요청", 12, ["자주 사용하는 메뉴의 위치를 조정해 달라고 요청", "반복 입력 항목을 줄일 수 있도록 개선 요청", "이용 이력을 더 쉽게 찾을 수 있도록 제안"], "이용 동선 확인 필요", "활용 맥락 기록 후 개선 검토 목록 연결"],
    ["불편 의견", 8, ["안내 문구가 길어 핵심 내용을 찾기 어렵다는 의견", "메뉴 이름이 비슷해 구분하기 어렵다는 의견", "도움말 검색에서 원하는 설명을 찾기 어렵다는 의견"], "탐색 불편 가능성", "불편 발생 경로를 분류해 운영 검토 요청"],
    ["신규 기능 요청", 6, ["이용 현황을 한눈에 확인하는 기능을 제안", "자주 사용하는 설정을 저장하는 기능을 요청", "변경 사항을 미리 안내받는 기능을 제안"], "추가 수요 확인 필요", "요청 목적 기록 및 기존 대안 안내"],
  ],
  "기타": [
    ["분류 필요", 6, ["문의 내용의 담당 부서를 확인해 달라고 요청", "이전 안내의 후속 확인을 요청했으나 유형이 불명확함", "여러 문의를 함께 접수해 세부 분류가 필요함"], "추가 내용 확인 필요", "문의 목적 확인 후 담당 및 세부유형 분류"],
    ["일반 문의", 6, ["고객지원 이용 방법과 운영 시간을 문의", "문의 접수 후 답변 확인 방법을 문의", "이전 문의 내용을 다시 확인하는 경로를 문의"], "지원 경로 안내 확인 필요", "지원 채널과 답변 확인 경로 안내"],
  ],
};

let seed = SEED;
function random() {
  seed |= 0;
  seed = seed + 0x6D2B79F5 | 0;
  let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
  value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}
const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = integer(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const formatSeoul = date => new Date(date.getTime() + 9 * 36e5).toISOString().slice(0, 19).replace("T", " ");
const parseSeoul = value => value ? new Date(value.replace(" ", "T") + "+09:00") : null;
const at = day => new Date(Date.UTC(2026, 7, day, integer(8, 22) - 9, integer(0, 59), integer(0, 59)));
const contexts = ["", " (모바일 이용)", " (웹 이용)", " (첫 이용)", " (재이용)", " (이용 중 확인)", " (안내 확인 후)", " (문의 재접수)", " (설정 화면 확인 중)", " (도움말 확인 후)"];
const channelDeck = shuffle([...Array(168).fill("채팅"), ...Array(105).fill("이메일"), ...Array(84).fill("전화"), ...Array(63).fill("앱 리뷰")]);
const urgentTopics = new Set(["로그인 실패", "인증 오류", "결제 실패", "중복 결제", "접속 장애", "앱 오류", "기능 작동 오류"]);
const rows = [];
let surgeCount = 0;

for (const [category, total, processing, open, aged, high, urgent] of DESIGN) {
  const topics = shuffle(TOPICS[category].flatMap(([subcategory, count, summaries, root, action]) =>
    Array.from({ length: count }, (_, i) => ({ subcategory, summary: summaries[i % summaries.length] + contexts[Math.floor(i / summaries.length)], root, action }))));
  assert.equal(topics.length, total);
  const oldProcessing = Math.ceil(aged * 0.8);
  const oldOpen = aged - oldProcessing;
  const cohorts = shuffle([
    ...Array(total - processing - open).fill("resolved"),
    ...Array(oldProcessing).fill("aged-processing"), ...Array(oldOpen).fill("aged-open"),
    ...Array(processing - oldProcessing).fill("recent-processing"), ...Array(open - oldOpen).fill("recent-open"),
  ]);
  const urgentIndices = new Set(shuffle(topics.map((topic, i) => urgentTopics.has(topic.subcategory) ? i : -1).filter(i => i >= 0)).slice(0, urgent));
  const highIndices = new Set(shuffle(topics.map((_, i) => i).filter(i => !urgentIndices.has(i))).slice(0, high));
  for (let i = 0; i < total; i += 1) {
    const topic = topics[i], cohort = cohorts[i];
    const status = cohort === "resolved" ? "해결" : cohort.endsWith("processing") ? "처리중" : "미처리";
    const priority = urgentIndices.has(i) ? "긴급" : highIndices.has(i) ? "높음" : "일반";
    const channel = channelDeck[rows.length];
    const complex = ["계정·접근", "결제·환불", "오류·장애"].includes(category);
    let responseMinutes = priority === "긴급" ? integer(5, 40) : channel === "앱 리뷰" ? integer(90, 480) : integer(10, 120);
    if (priority !== "긴급" && random() < 0.09) responseMinutes += integer(360, 1080);
    const workHours = (complex ? 5 : 1) + Math.pow(random(), 1.3) * (complex ? 32 : 24) + (random() < 0.10 ? integer(24, 60) : 0);
    // The mid-August access spike is mostly resolved, not a month-long backlog.
    const surge = category === "계정·접근" && ["로그인 실패", "인증 오류"].includes(topic.subcategory) && status === "해결" && surgeCount < 26;
    if (surge) surgeCount += 1;
    let created, first, resolved;
    do {
      const day = surge ? integer(16, 20) : cohort.startsWith("aged") ? integer(23, 29) : cohort.startsWith("recent") ? integer(30, 31) : integer(1, 31);
      created = at(day);
      first = status === "미처리" ? null : new Date(created.getTime() + responseMinutes * 60000);
      resolved = status === "해결" ? new Date(first.getTime() + Math.round(workHours * 3600) * 1000) : null;
    } while ((first && first > ANALYSIS_AT) || (resolved && resolved > ANALYSIS_AT));
    rows.push({
      ticket_id: "CX-202608-" + String(rows.length + 1).padStart(4, "0"),
      created_at: formatSeoul(created), first_response_at: first ? formatSeoul(first) : "", resolved_at: resolved ? formatSeoul(resolved) : "",
      channel, category, subcategory: topic.subcategory, status, priority,
      summary: topic.summary, root_cause_tag: topic.root,
      next_action: status === "해결" ? topic.action + " 결과 기록 및 재문의 여부 확인" : topic.action,
    });
  }
}
rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.ticket_id.localeCompare(b.ticket_id));

function assertData() {
  assert.equal(rows.length, 420);
  assert.equal(new Set(rows.map(row => row.ticket_id)).size, 420);
  assert.equal(new Set(rows.map(row => row.summary)).size, 420);
  for (const row of rows) {
    assert.ok(categories.includes(row.category));
    const created = parseSeoul(row.created_at), first = parseSeoul(row.first_response_at), resolved = parseSeoul(row.resolved_at);
    assert.ok(created >= parseSeoul("2026-08-01 00:00:00") && created <= ANALYSIS_AT);
    assert.ok(!first || (first >= created && first <= ANALYSIS_AT));
    assert.ok(!resolved || (first && resolved >= first && resolved <= ANALYSIS_AT));
    assert.equal(Boolean(first), row.status !== "미처리");
    assert.equal(Boolean(resolved), row.status === "해결");
    if (row.priority === "긴급") assert.ok(urgentTopics.has(row.subcategory));
  }
}
const headers = Object.keys(rows[0]);
const csvCell = value => '"' + String(value).replaceAll('"', '""') + '"';
const toCsv = () => "\uFEFF" + [headers.join(","), ...rows.map(row => headers.map(key => csvCell(row[key])).join(","))].join("\n") + "\n";
if (require.main === module) {
  assertData();
  const output = path.join(__dirname, "..", "data", "cx-tickets-2026-08.csv");
  fs.writeFileSync(output, toCsv(), "utf8");
  process.stdout.write("Generated " + rows.length + " fictional tickets (seed " + SEED + ") at " + output + "\n");
}
module.exports = { ANALYSIS_AT, rows, assertData, toCsv, DESIGN, SEED };

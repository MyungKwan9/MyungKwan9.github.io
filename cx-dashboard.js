(() => {
  "use strict";

  const DATA_URL = "./data/cx-tickets-2026-08.csv";
  const ANALYSIS_AT = new Date("2026-08-31T23:59:59+09:00");
  const MIN_DATE = "2026-08-01";
  const MAX_DATE = "2026-08-31";
  const PAGE_SIZE = 12;
  const CATEGORY_ORDER = ["계정·접근", "가입·온보딩", "결제·환불", "서비스 이용", "오류·장애", "해지·변경", "정책·혜택", "의견·요청", "기타", "계정·로그인", "결제·취소"];
  // Retain the previous CSV categories without mixing them into the new sample.
  const activeCategories = () => CATEGORY_ORDER.filter(category => state.tickets.some(ticket => ticket.category === category));
  const PRIORITY_SCORE = { 긴급: 3, 높음: 2, 일반: 1 };
  const REQUIRED_COLUMNS = ["ticket_id", "created_at", "first_response_at", "resolved_at", "channel", "category", "subcategory", "status", "priority", "summary", "root_cause_tag", "next_action"];
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const state = {
    tickets: [], filtered: [], page: 1, agedOnly: false, loading: false, error: false,
    source: "sample", analysisAt: ANALYSIS_AT, latestAt: ANALYSIS_AT,
    minDate: MIN_DATE, maxDate: MAX_DATE, downloadUrl: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    form: $("#ticketFilters"),
    start: $("#startDate"),
    end: $("#endDate"),
    category: $("#categoryFilter"),
    status: $("#statusFilter"),
    agedOnly: $("#agedOnly"),
    rows: $("#ticketRows"),
    tableScroll: $(".table-scroll"),
    empty: $("#emptyState"),
    error: $("#loadError"),
    pagination: $("#pagination"),
    dialog: $("#ticketDialog"),
    dialogTitle: $("#dialogTitle"),
    dialogContent: $("#dialogContent"),
    file: $("#csvFile"),
    importButton: $("#importCsv"),
    restoreButton: $("#restoreSample"),
    download: $("#downloadCsv"),
    analysisInput: $("#analysisInput"),
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);

  const formatSeoul = (date) => new Date(date.getTime() + 9 * 36e5).toISOString().slice(0, 19).replace("T", " ");
  function parseSeoul(value, column = "분석 기준시각") {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
    const invalid = () => { throw new Error(`${column} 날짜 형식을 확인해 주세요. 예: 2026-09-01 10:00:00 (Asia/Seoul)`); };
    if (!match) return invalid();
    const [, year, month, day, hour, minute, second = "00", zone = "+09:00"] = match;
    const localIso = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    const calendar = new Date(`${localIso}Z`);
    // Date silently rolls invalid days into the next month; compare to reject them.
    if (+year < 1000 || +hour > 23 || +minute > 59 || +second > 59
      || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== localIso) return invalid();
    const parsed = new Date(localIso + zone);
    if (!Number.isFinite(parsed.getTime()) || formatSeoul(parsed).length !== 19) return invalid();
    return parsed;
  }
  const isUnresolved = (ticket) => ticket.status === "미처리" || ticket.status === "처리중";
  const ageHours = (ticket) => (state.analysisAt - ticket.createdAt) / 36e5;
  const isAged = (ticket) => isUnresolved(ticket) && ageHours(ticket) >= 48;
  const resolvedHours = (ticket) => ticket.resolvedAt ? (ticket.resolvedAt - ticket.createdAt) / 36e5 : null;

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, "");
    const records = [];
    let row = [];
    let cell = "";
    let quoted = false;
    let closedQuote = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const next = text[index + 1];
      if (character === '"' && quoted && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        if (quoted) { quoted = false; closedQuote = true; }
        else if (cell === "" && !closedQuote) quoted = true;
        else throw new Error("CSV 따옴표 형식을 확인해 주세요. 템플릿 형식으로 저장해 주세요.");
      } else if (character === "," && !quoted) {
        row.push(cell);
        cell = "";
        closedQuote = false;
      } else if ((character === "\n" || character === "\r") && !quoted) {
        if (character === "\r" && next === "\n") index += 1;
        row.push(cell);
        if (row.some((value) => value.trim() !== "")) records.push(row);
        row = [];
        cell = "";
        closedQuote = false;
      } else {
        if (closedQuote && character.trim()) throw new Error("CSV 닫는 따옴표 뒤의 구분자를 확인해 주세요.");
        cell += character;
      }
    }
    if (quoted) throw new Error("CSV에 닫히지 않은 따옴표가 있습니다.");
    if (cell.trim() || row.length) {
      row.push(cell);
      records.push(row);
    }

    const [rawHeaders, ...dataRows] = records;
    if (!rawHeaders) throw new Error("CSV가 비어 있습니다. 헤더와 데이터 행을 포함해 주세요.");
    const headers = rawHeaders.map((header) => header.trim());
    for (const column of REQUIRED_COLUMNS) {
      if (!headers.includes(column)) throw new Error(`필수 컬럼 \`${column}\`이 없습니다.`);
    }
    if (new Set(headers).size !== headers.length || headers.includes("")) throw new Error("CSV 컬럼명이 중복되었거나 비어 있습니다.");
    if (!dataRows.length) throw new Error("CSV에 데이터 행이 없습니다. 티켓을 한 건 이상 추가해 주세요.");
    if (dataRows.length > 10000) throw new Error("브라우저 분석은 최대 10,000건까지 지원합니다.");
    return dataRows.map((values, index) => {
      if (values.length !== headers.length) throw new Error(`${index + 1}번째 티켓의 컬럼 수가 헤더와 다릅니다. 쉼표와 따옴표를 확인해 주세요.`);
      return Object.fromEntries(headers.map((header, i) => [header, values[i].trim()]));
    });
  }

  function normalizeTicket(row) {
    const createdAt = parseSeoul(row.created_at, "created_at");
    const firstResponseAt = parseSeoul(row.first_response_at, "first_response_at");
    const resolvedAt = parseSeoul(row.resolved_at, "resolved_at");
    return {
      ...row,
      createdAt, firstResponseAt, resolvedAt,
      created_at: createdAt ? formatSeoul(createdAt) : "",
      first_response_at: firstResponseAt ? formatSeoul(firstResponseAt) : "",
      resolved_at: resolvedAt ? formatSeoul(resolvedAt) : "",
    };
  }

  function validateTickets(tickets, analysisAt = null) {
    const required = ["ticket_id", "created_at", "channel", "category", "subcategory", "status", "priority", "summary", "root_cause_tag", "next_action"];
    if (!tickets.length) throw new Error("CSV에 데이터 행이 없습니다.");
    if (new Set(tickets.map((ticket) => ticket.ticket_id)).size !== tickets.length) throw new Error("ticket_id 중복 데이터가 발견되었습니다.");
    tickets.forEach((ticket, index) => {
      const prefix = `${index + 1}번째 티켓: `;
      required.forEach((key) => { if (!ticket[key]) throw new Error(`${prefix}${key} 값이 비어 있습니다.`); });
      if (!["미처리", "처리중", "해결"].includes(ticket.status)) throw new Error(`${prefix}status는 미처리·처리중·해결 중 하나여야 합니다.`);
      if (!CATEGORY_ORDER.includes(ticket.category)) throw new Error(`${prefix}category는 ${CATEGORY_ORDER.join(" / ")} 중 하나여야 합니다.`);
      if (!Object.hasOwn(PRIORITY_SCORE, ticket.priority)) throw new Error(`${prefix}priority는 일반·높음·긴급 중 하나여야 합니다.`);
      if (!["채팅", "이메일", "전화", "앱 리뷰"].includes(ticket.channel)) throw new Error(`${prefix}channel은 채팅·이메일·전화·앱 리뷰 중 하나여야 합니다.`);
      if (analysisAt && [ticket.createdAt, ticket.firstResponseAt, ticket.resolvedAt].some((date) => date && date > analysisAt)) throw new Error(`${prefix}분석 기준시각 이후의 이벤트가 있습니다.`);
      if (ticket.firstResponseAt && ticket.firstResponseAt < ticket.createdAt) throw new Error(`${prefix}first_response_at이 created_at보다 빠릅니다.`);
      if (ticket.resolvedAt && (!ticket.firstResponseAt || ticket.resolvedAt < ticket.firstResponseAt)) throw new Error(`${prefix}resolved_at은 first_response_at 이후여야 합니다.`);
      if (ticket.status === "해결" && (!ticket.firstResponseAt || !ticket.resolvedAt)) throw new Error(`${prefix}해결 상태에는 최초응답·해결 시각이 모두 필요합니다.`);
      if (ticket.status === "미처리" && (ticket.firstResponseAt || ticket.resolvedAt)) throw new Error(`${prefix}미처리 상태는 최초응답·해결 시각을 비워 주세요.`);
      if (ticket.status === "처리중" && (!ticket.firstResponseAt || ticket.resolvedAt)) throw new Error(`${prefix}처리중 상태에는 최초응답 시각만 있어야 합니다.`);
    });
    const received = tickets.map((ticket) => ticket.created_at.slice(0, 10)).sort();
    if ((parseSeoul(`${received.at(-1)} 00:00:00`) - parseSeoul(`${received[0]} 00:00:00`)) / 864e5 > 3660) {
      throw new Error("일별 차트는 접수 기간 10년(3,660일) 이내의 CSV를 지원합니다.");
    }
  }

  function calculateKpis(tickets) {
    const unresolved = tickets.filter(isUnresolved).length;
    const aged = tickets.filter(isAged).length;
    const durations = tickets.map(resolvedHours).filter((hours) => hours !== null).sort((a, b) => a - b);
    let median = null;
    if (durations.length) {
      const middle = Math.floor(durations.length / 2);
      median = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
    }
    return { total: new Set(tickets.map((ticket) => ticket.ticket_id)).size, unresolved, aged, median };
  }

  function getFilteredTickets() {
    const start = elements.start.value;
    const end = elements.end.value;
    const category = elements.category.value;
    const status = elements.status.value;
    return state.tickets.filter((ticket) => {
      const date = ticket.created_at.slice(0, 10);
      return date >= start && date <= end
        && (category === "all" || ticket.category === category)
        && (status === "all" || ticket.status === status)
        && (!state.agedOnly || isAged(ticket));
    });
  }

  function sortForAction(tickets) {
    return [...tickets].sort((a, b) => {
      const unresolvedDifference = Number(isUnresolved(b)) - Number(isUnresolved(a));
      if (unresolvedDifference) return unresolvedDifference;
      const agedDifference = Number(isAged(b)) - Number(isAged(a));
      if (agedDifference) return agedDifference;
      const priorityDifference = PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority];
      if (priorityDifference) return priorityDifference;
      return b.createdAt - a.createdAt;
    });
  }

  function formatHours(hours) {
    if (hours === null || Number.isNaN(hours)) return "—";
    if (hours === 0) return "0시간";
    if (hours < 1 / 60) return "1분 미만";
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}분`;
    const rounded = Math.round(hours * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}시간`;
  }

  function updateKpis(tickets) {
    const kpis = calculateKpis(tickets);
    $("#kpiTotal").textContent = `${kpis.total.toLocaleString("ko-KR")}건`;
    $("#kpiUnresolved").textContent = `${kpis.unresolved.toLocaleString("ko-KR")}건`;
    $("#kpiAged").textContent = `${kpis.aged.toLocaleString("ko-KR")}건`;
    $("#kpiMedian").textContent = kpis.median === null ? "—" : formatHours(kpis.median);
    $("#medianHelp").textContent = kpis.median === null ? "현재 조건에서 해결된 티켓이 없습니다." : "해결 티켓의 달력 기준 경과시간";
    $("#kpiGrid").setAttribute("aria-busy", "false");
  }

  function dateRange(start, end) {
    const dates = [];
    const cursor = new Date(`${start}T00:00:00+09:00`);
    const finish = new Date(`${end}T00:00:00+09:00`);
    while (cursor <= finish) {
      const seoul = new Date(cursor.getTime() + 9 * 60 * 60 * 1000);
      dates.push(seoul.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }

  function renderDailyChart(tickets) {
    const container = $("#dailyChart");
    const dates = dateRange(elements.start.value, elements.end.value);
    const counts = new Map(dates.map((date) => [date, 0]));
    tickets.forEach((ticket) => counts.set(ticket.created_at.slice(0, 10), (counts.get(ticket.created_at.slice(0, 10)) || 0) + 1));
    const values = dates.map((date) => counts.get(date) || 0);
    if (!tickets.length) {
      container.innerHTML = '<div class="chart-empty">현재 조건에서 표시할 일별 문의가 없습니다.</div>';
      container.setAttribute("aria-label", "날짜별 접수 건수: 데이터 없음");
      return;
    }

    const width = 720;
    const height = 275;
    const margin = { top: 28, right: 18, bottom: 38, left: 42 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const maximum = Math.max(...values, 1);
    const ceiling = Math.ceil(maximum / 5) * 5 || 5;
    const x = (index) => margin.left + (dates.length === 1 ? innerWidth / 2 : index * innerWidth / (dates.length - 1));
    const y = (value) => margin.top + innerHeight - (value / ceiling) * innerHeight;
    const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
    const areaPoints = `${margin.left},${margin.top + innerHeight} ${points} ${margin.left + innerWidth},${margin.top + innerHeight}`;
    const peak = values.indexOf(maximum);
    const ticks = [0, 1, 2, 3, 4].map((tick) => Math.round(ceiling * tick / 4));
    const labelStep = Math.max(1, Math.ceil(dates.length / 7));
    const xLabels = dates.map((date, index) => (index % labelStep === 0 || index === dates.length - 1)
      ? `<text class="chart-axis-label" x="${x(index)}" y="${height - 10}" text-anchor="middle">${date.slice(5).replace("-", "/")}</text>` : "").join("");
    const grid = ticks.map((tick) => `<line class="chart-grid-line" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}" /><text class="chart-axis-label" x="${margin.left - 10}" y="${y(tick) + 4}" text-anchor="end">${tick}</text>`).join("");
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false"><defs><linearGradient id="lineArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2563eb" stop-opacity=".24"/><stop offset="100%" stop-color="#2563eb" stop-opacity=".02"/></linearGradient></defs>${grid}<polygon class="chart-area" points="${areaPoints}"/><polyline class="chart-line" points="${points}"/>${values.map((value, index) => `<circle class="chart-dot" cx="${x(index)}" cy="${y(value)}" r="3.5"><title>${dates[index]}: ${value}건</title></circle>`).join("")}<text class="chart-peak" x="${x(peak)}" y="${Math.max(16, y(maximum) - 10)}" text-anchor="middle">${maximum}건</text>${xLabels}</svg>`;
    container.setAttribute("aria-label", `날짜별 접수 건수 추이. 최대 ${dates[peak]} ${maximum}건. 전체 ${tickets.length}건.`);
  }

  function renderCategoryChart(tickets) {
    const container = $("#categoryChart");
    const categories = activeCategories();
    const counts = Object.fromEntries(categories.map((category) => [category, 0]));
    tickets.forEach((ticket) => { counts[ticket.category] = (counts[ticket.category] || 0) + 1; });
    const maximum = Math.max(...Object.values(counts), 0);
    if (!tickets.length) {
      container.innerHTML = '<div class="chart-empty">현재 조건에서 표시할 문의 유형이 없습니다.</div>';
      container.setAttribute("aria-label", "문의 유형별 접수 건수: 데이터 없음");
      return;
    }
    container.innerHTML = categories.map((category) => `<div class="bar-row"><span class="bar-label">${category}</span><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:${maximum ? counts[category] / maximum * 100 : 0}%"></div></div><span class="bar-value">${counts[category]}</span></div>`).join("");
    container.setAttribute("aria-label", `문의 유형별 접수 건수. ${categories.map((category) => `${category} ${counts[category]}건`).join(", ")}.`);
  }

  function statusClass(status) {
    return status === "해결" ? "status-resolved" : status === "처리중" ? "status-progress" : "status-open";
  }
  function priorityClass(priority) {
    return priority === "긴급" ? "priority-urgent" : priority === "높음" ? "priority-high" : "priority-normal";
  }

  function renderTable() {
    const sorted = sortForAction(state.filtered);
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const pageRows = sorted.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const hasRows = pageRows.length > 0;
    elements.tableScroll.hidden = !hasRows || state.error;
    elements.empty.hidden = hasRows || state.error;
    elements.pagination.hidden = !hasRows || totalPages <= 1 || state.error;
    if (!hasRows) {
      elements.rows.innerHTML = "";
      return;
    }
    elements.rows.innerHTML = pageRows.map((ticket) => {
      const elapsed = ticket.resolvedAt ? resolvedHours(ticket) : ageHours(ticket);
      return `<tr><td><span class="ticket-id">${escapeHtml(ticket.ticket_id)}</span></td><td>${escapeHtml(ticket.created_at.slice(5, 10).replace("-", "."))}</td><td>${escapeHtml(ticket.category)}</td><td><span class="status ${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span></td><td><span class="priority ${priorityClass(ticket.priority)}">${escapeHtml(ticket.priority)}</span></td><td class="summary-cell" title="${escapeHtml(ticket.summary)}">${escapeHtml(ticket.summary)}</td><td class="${isAged(ticket) ? "age-aged" : ""}">${formatHours(elapsed)}</td><td class="action-cell" title="${escapeHtml(ticket.next_action)}">${escapeHtml(ticket.next_action)}</td><td><button class="detail-button" type="button" data-ticket="${escapeHtml(ticket.ticket_id)}">상세</button></td></tr>`;
    }).join("");
    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const pages = new Set([1, totalPages, state.page - 1, state.page, state.page + 1]);
    const validPages = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
    let last = 0;
    const middle = validPages.map((page) => {
      const gap = page - last > 1 ? '<span class="page-gap" aria-hidden="true">…</span>' : "";
      last = page;
      return `${gap}<button class="page-button" type="button" data-page="${page}" ${page === state.page ? 'aria-current="page"' : ""} aria-label="${page}페이지">${page}</button>`;
    }).join("");
    elements.pagination.innerHTML = `<button class="page-button" type="button" data-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""} aria-label="이전 페이지">‹</button>${middle}<button class="page-button" type="button" data-page="${state.page + 1}" ${state.page === totalPages ? "disabled" : ""} aria-label="다음 페이지">›</button>`;
  }

  function updateSummary() {
    const parts = [];
    if (elements.category.value !== "all") parts.push(elements.category.value);
    if (elements.status.value !== "all") parts.push(elements.status.value);
    if (state.agedOnly) parts.push("48시간 이상 미해결");
    const context = parts.length ? ` · ${parts.join(" · ")}` : "";
    $("#filterSummary").textContent = `${elements.start.value} ~ ${elements.end.value}${context} · ${state.filtered.length.toLocaleString("ko-KR")}건`;
  }

  function updateDashboard() {
    if (!state.tickets.length) return;
    state.page = 1;
    state.filtered = getFilteredTickets();
    updateKpis(state.filtered);
    renderDailyChart(state.filtered);
    renderCategoryChart(state.filtered);
    renderTable();
    updateSummary();
  }

  function renderEvidence() {
    const payment = state.tickets.filter((ticket) => ["결제·환불", "결제·취소"].includes(ticket.category) && ["환불 기준", "환불 진행상태", "결제 취소 안내"].includes(ticket.subcategory));
    const paymentUnresolved = payment.filter(isUnresolved).length;
    const aged = state.tickets.filter(isAged);
    const accessAged = aged.filter(ticket => ["계정·접근", "계정·로그인"].includes(ticket.category)).length;
    const urgentOutage = state.tickets.filter(ticket => ticket.category === "오류·장애" && ticket.priority === "긴급");
    $("#paymentEvidence").textContent = `전체 ${state.tickets.length}건 중 환불 기준·진행상태 관련 문의 ${payment.length}건이며, 이 중 ${paymentUnresolved}건은 분석 기준시각에 미해결입니다.`;
    $("#delayEvidence").textContent = `전체 미해결 ${state.tickets.filter(isUnresolved).length}건 중 48시간 이상 미해결 ${aged.length}건(계정·접근 ${accessAged}건)입니다. 오류·장애의 긴급 문의 ${urgentOutage.length}건 중 ${urgentOutage.filter(isUnresolved).length}건은 미해결입니다.`;
    const userData = state.source === "user";
    $("#evidenceScope").textContent = userData ? "전체 사용자 CSV 기준 · 필터와 무관" : "전체 가상 Sample Data 기준 분석";
    $("#userEvidenceNote").hidden = !userData;
    $("#paymentTitle").textContent = userData ? "환불 안내 문의와 미해결 현황을 확인합니다." : "환불 기준과 진행상태 안내를 점검합니다.";
    $("#delayTitle").textContent = "장기 미해결과 긴급 장애를 구분해 관리합니다.";
    document.querySelectorAll("[data-category]").forEach(button => {
      const paymentButton = button.dataset.category.startsWith("결제");
      const preferred = paymentButton ? "결제·환불" : "계정·접근";
      const legacy = paymentButton ? "결제·취소" : "계정·로그인";
      button.dataset.category = activeCategories().includes(preferred) ? preferred : activeCategories().includes(legacy) ? legacy : preferred;
      button.disabled = !activeCategories().includes(button.dataset.category);
      button.textContent = `${button.dataset.category} 문의 보기 →`;
    });
  }

  function resetFilters() {
    elements.start.value = state.minDate;
    elements.end.value = state.maxDate;
    elements.category.value = "all";
    elements.status.value = "all";
    state.agedOnly = false;
    elements.agedOnly.setAttribute("aria-pressed", "false");
    updateDashboard();
  }

  function openTicket(ticketId) {
    const ticket = state.tickets.find((item) => item.ticket_id === ticketId);
    if (!ticket) return;
    elements.dialogTitle.textContent = ticket.ticket_id;
    const value = (input) => input || "—";
    elements.dialogContent.innerHTML = `<dl class="dialog-grid"><div><dt>접수시각</dt><dd>${escapeHtml(ticket.created_at)} Asia/Seoul</dd></div><div><dt>채널</dt><dd>${escapeHtml(ticket.channel)}</dd></div><div><dt>문의 유형</dt><dd>${escapeHtml(ticket.category)} · ${escapeHtml(ticket.subcategory)}</dd></div><div><dt>상태 / 우선순위</dt><dd>${escapeHtml(ticket.status)} · ${escapeHtml(ticket.priority)}</dd></div><div><dt>최초 응답</dt><dd>${escapeHtml(value(ticket.first_response_at))}</dd></div><div><dt>해결시각</dt><dd>${escapeHtml(value(ticket.resolved_at))}</dd></div><div class="dialog-wide"><dt>문의 요약</dt><dd>${escapeHtml(ticket.summary)}</dd></div><div class="dialog-wide"><dt>원인 태그</dt><dd>${escapeHtml(ticket.root_cause_tag)}</dd></div><div class="dialog-wide"><dt>다음 조치</dt><dd>${escapeHtml(ticket.next_action)}</dd></div></dl>`;
    elements.dialog.showModal();
  }

  function showLoadError() {
    state.error = true;
    elements.error.hidden = false;
    elements.empty.hidden = true;
    elements.tableScroll.hidden = true;
    elements.pagination.hidden = true;
    $("#sourceTotal").textContent = "불러오기 실패";
    $("#datasetStatus").textContent = "현재 데이터: 샘플을 불러오지 못했습니다. 다시 시도하거나 CSV를 선택해 주세요.";
    $("#filterSummary").textContent = "CSV 데이터를 확인해 주세요.";
    $("#kpiGrid").setAttribute("aria-busy", "false");
    ["#kpiTotal", "#kpiUnresolved", "#kpiAged", "#kpiMedian"].forEach((selector) => { $(selector).textContent = "—"; });
    renderDailyChart([]);
    renderCategoryChart([]);
  }

  function setBusy(busy) {
    state.loading = busy;
    [elements.importButton, elements.restoreButton, elements.file, $("#retryLoad")].forEach((control) => { control.disabled = busy; });
    $(".data-tools").setAttribute("aria-busy", String(busy));
  }

  function setDataMessage(message = "", error = "") {
    $("#csvMessage").textContent = message;
    $("#csvMessage").hidden = !message;
    $("#csvError").textContent = error;
    $("#csvError").hidden = !error;
  }

  // Commit only a completely parsed and validated file; failed imports leave the active dataset intact.
  function activateDataset(tickets, source, file = null) {
    const dates = tickets.map((ticket) => ticket.created_at.slice(0, 10)).sort();
    const latestAt = new Date(tickets.reduce((latest, ticket) => Math.max(latest,
      ticket.createdAt.getTime(), ticket.firstResponseAt?.getTime() ?? -Infinity, ticket.resolvedAt?.getTime() ?? -Infinity), -Infinity));
    const analysisAt = source === "sample" ? ANALYSIS_AT : parseSeoul(`${formatSeoul(latestAt).slice(0, 10)} 23:59:59`);
    const downloadUrl = file ? URL.createObjectURL(file) : null;
    const previousUrl = state.downloadUrl;
    Object.assign(state, {
      tickets, source, analysisAt, latestAt, downloadUrl, error: false,
      minDate: source === "sample" ? MIN_DATE : dates[0],
      maxDate: source === "sample" ? MAX_DATE : dates.at(-1),
    });
    elements.category.innerHTML = '<option value="all">전체 유형</option>' + activeCategories().map(category => `<option>${category}</option>`).join("");
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    if (elements.dialog.open) elements.dialog.close();
    elements.download.href = downloadUrl || DATA_URL;
    elements.download.download = file ? "cx-user-data.csv" : "cx-tickets-2026-08.csv";
    [elements.start, elements.end].forEach((input) => { input.min = state.minDate; input.max = state.maxDate; });
    $("#datasetPeriod").textContent = `${state.minDate} ~ ${state.maxDate}`;
    $("#analysisDisplay").textContent = formatSeoul(analysisAt);
    $("#sourceTotal").textContent = `${tickets.length.toLocaleString("ko-KR")}건`;
    $("#datasetStatus").textContent = `현재 데이터: ${source === "sample" ? "가상 Sample Data" : "사용자 업로드 CSV"} · ${tickets.length.toLocaleString("ko-KR")}건`;
    $("#datasetEyebrow").textContent = source === "sample" ? "가상 데이터 기반 포트폴리오" : "사용자 CSV · 브라우저 로컬 분석";
    $("#analysisForm").hidden = source === "sample";
    elements.analysisInput.value = formatSeoul(analysisAt).replace(" ", "T");
    elements.analysisInput.min = formatSeoul(latestAt).replace(" ", "T");
    $("#analysisError").hidden = true;
    elements.error.hidden = true;
    renderEvidence();
    resetFilters();
  }

  async function loadTickets() {
    if (state.loading) return;
    setBusy(true);
    setDataMessage("샘플 CSV를 불러오는 중입니다.");
    try {
      const response = await fetch(DATA_URL, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("샘플 CSV 파일을 불러오지 못했습니다.");
      const text = await response.text();
      const tickets = parseCsv(text).map(normalizeTicket);
      validateTickets(tickets, ANALYSIS_AT);
      activateDataset(tickets, "sample");
      setDataMessage();
    } catch {
      if (!state.tickets.length) showLoadError();
      setDataMessage("", `샘플 CSV를 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.${state.tickets.length ? " 현재 데이터는 유지됩니다." : ""}`);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file) {
    if (!file || state.loading) return;
    setBusy(true);
    setDataMessage("CSV 파일을 브라우저에서 확인하는 중입니다.");
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error(".csv 확장자의 CSV 파일을 선택해 주세요.");
      if (file.size > MAX_FILE_BYTES) throw new Error("파일이 너무 큽니다. 5MB 이하의 CSV를 선택해 주세요.");
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("파일을 읽지 못했습니다. 파일을 확인한 뒤 다시 선택해 주세요."));
        reader.onabort = () => reject(new Error("파일 읽기가 취소되었습니다."));
        reader.readAsText(file, "utf-8");
      });
      if (text.includes("\uFFFD")) throw new Error("문자 인코딩을 확인해 주세요. CSV UTF-8 형식으로 저장해 주세요.");
      const tickets = parseCsv(text).map(normalizeTicket);
      validateTickets(tickets);
      activateDataset(tickets, "user", file);
      setDataMessage("브라우저에서만 처리되며 서버에 저장되지 않습니다. 분석 기준시각을 확인해 주세요.");
    } catch (error) {
      setDataMessage("", `${error.message}${state.tickets.length ? " 현재 데이터와 필터는 유지됩니다." : ""}`);
    } finally {
      elements.file.value = "";
      setBusy(false);
    }
  }

  elements.form.addEventListener("submit", (event) => event.preventDefault());
  elements.form.addEventListener("change", (event) => {
    // Clearing or typing an out-of-range date must not leave the chart with an invalid range.
    for (const input of [elements.start, elements.end]) {
      const fallback = input === elements.start ? state.minDate : state.maxDate;
      input.value = input.value || fallback;
      if (input.value < state.minDate) input.value = state.minDate;
      if (input.value > state.maxDate) input.value = state.maxDate;
    }
    if (elements.start.value > elements.end.value) {
      if (event.target === elements.start) elements.end.value = elements.start.value;
      else elements.start.value = elements.end.value;
    }
    updateDashboard();
  });
  $("#resetFilters").addEventListener("click", resetFilters);
  $("[data-reset]").addEventListener("click", resetFilters);
  $("#retryLoad").addEventListener("click", loadTickets);
  elements.restoreButton.addEventListener("click", loadTickets);
  elements.importButton.addEventListener("click", () => elements.file.click());
  elements.file.addEventListener("change", () => importFile(elements.file.files[0]));
  $("#analysisForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.source !== "user") return;
    try {
      const analysisAt = parseSeoul(elements.analysisInput.value);
      if (!analysisAt || analysisAt < state.latestAt) throw new Error("분석 기준시각은 CSV의 가장 최근 이벤트 시각 이후여야 합니다. 기존 기준시각은 유지됩니다.");
      state.analysisAt = analysisAt;
      $("#analysisDisplay").textContent = formatSeoul(analysisAt);
      $("#analysisError").hidden = true;
      updateDashboard();
      renderEvidence();
    } catch (error) {
      $("#analysisError").textContent = error.message;
      $("#analysisError").hidden = false;
    }
  });
  elements.agedOnly.addEventListener("click", () => {
    state.agedOnly = !state.agedOnly;
    elements.agedOnly.setAttribute("aria-pressed", String(state.agedOnly));
    updateDashboard();
  });
  elements.rows.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ticket]");
    if (button) openTicket(button.dataset.ticket);
  });
  elements.pagination.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button || button.disabled) return;
    state.page = Number(button.dataset.page);
    renderTable();
    $("#ticket-list-title").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#closeDialog").addEventListener("click", () => elements.dialog.close());
  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });
  $("#openMethod").addEventListener("click", () => {
    $("#methodDetails").open = true;
    $("#methodology").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => {
    elements.start.value = state.minDate;
    elements.end.value = state.maxDate;
    elements.category.value = button.dataset.category;
    elements.status.value = "all";
    state.agedOnly = false;
    elements.agedOnly.setAttribute("aria-pressed", "false");
    updateDashboard();
    $("#filter-title").scrollIntoView({ behavior: "smooth", block: "center" });
  }));

  loadTickets();
})();

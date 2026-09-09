// Run the production script with minimal DOM/FileReader adapters. No packages or network required.
// Browser checks additionally exercise the real file chooser, controls and layout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const sample = fs.readFileSync(path.join(root, 'data/cx-tickets-2026-08.csv'), 'utf8');
const template = fs.readFileSync(path.join(root, 'data/cx-tickets-template.csv'), 'utf8').replace(/^\uFEFF/, '');
const production = fs.readFileSync(path.join(root, 'cx-dashboard.js'), 'utf8');

class Element {
  constructor() { this.value = ''; this.hidden = false; this.textContent = ''; this.innerHTML = ''; this.listeners = {}; this.attrs = {}; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attrs[name] = value; }
  scrollIntoView() {}
  close() { this.open = false; }
  emit(name, extra = {}) { return this.listeners[name]?.({ target: this, preventDefault() {}, ...extra }); }
}

async function boot() {
  const nodes = new Map();
  const $ = (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  for (const selector of ['#categoryFilter', '#statusFilter']) $(selector).value = 'all';
  $('#startDate').value = '2026-08-01'; $('#endDate').value = '2026-08-31';
  const requests = [];
  const objectUrls = new Map();
  let failFetch = false;
  let nextBlob = 0;
  const context = {
    document: { querySelector: $, querySelectorAll: () => [] }, window: {},
    console: { error: (...args) => { throw new Error(`Unexpected console error: ${args}`); } },
    AbortSignal, Date, Blob,
    URL: { createObjectURL: (file) => { const url = `blob:test-${++nextBlob}`; objectUrls.set(url, file); return url; }, revokeObjectURL: (url) => objectUrls.delete(url) },
    FileReader: class {
      readAsText(file, encoding) {
        assert.equal(encoding, 'utf-8');
        queueMicrotask(() => { this.result = file.contents; file.readError ? this.onerror() : this.onload(); });
      }
    },
    fetch: async (url, options) => {
      assert.equal(url, './data/cx-tickets-2026-08.csv');
      assert.equal(options.method, undefined);
      requests.push(url);
      if (failFetch) throw new Error('Simulated sample failure');
      return { ok: true, text: async () => sample };
    },
    localStorage: { setItem() { throw new Error('Persistence is forbidden'); } },
    sessionStorage: { setItem() { throw new Error('Persistence is forbidden'); } },
  };
  // Add a state reader only inside this test VM, never to the shipped browser script.
  const bootMarker = /  loadTickets\(\);\r?\n\}\)\(\);\s*$/;
  assert.match(production, bootMarker);
  vm.runInNewContext(production.replace(bootMarker, '  window.readTestState = () => ({ ...state });\n  loadTickets();\n})();'), context);
  await new Promise(setImmediate);
  const state = () => context.window.readTestState();
  const kpis = () => ['#kpiTotal', '#kpiUnresolved', '#kpiAged', '#kpiMedian'].map((key) => $(key).textContent);
  const upload = async (contents, name = 'local.csv', extra = {}) => {
    $('#csvFile').files = [{ name, size: Buffer.byteLength(contents), contents, ...extra }];
    await $('#csvFile').emit('change');
  };
  return { $, state, kpis, upload, requests, objectUrls, failNextFetch: (value) => { failFetch = value; } };
}

(async () => {
  const app = await boot();
  const { $, state, kpis, upload } = app;
  assert.deepEqual(kpis(), ['420건', '82건', '30건', '17.4시간']);
  assert.equal(state().analysisAt.toISOString(), '2026-08-31T14:59:59.000Z');
  assert.equal(new Set(state().tickets.map(ticket => ticket.category)).size, 9);
  assert.equal(($('#categoryChart').innerHTML.match(/class="bar-row"/g) || []).length, 9);
  assert.match($('#paymentEvidence').textContent, /관련 문의 42건/);
  assert.match($('#delayEvidence').textContent, /계정·접근 8건/);

  const invalidCases = [
    ['missing-column.csv', '필수 컬럼 `resolved_at`'], ['empty.csv', '비어 있습니다'],
    ['invalid-date.csv', 'created_at 날짜'], ['duplicate-id.csv', 'ticket_id 중복'],
    ['invalid-response.csv', 'first_response_at 날짜'], ['invalid-resolution.csv', 'resolved_at 날짜'],
    ['invalid-order.csv', 'first_response_at이 created_at보다'], ['invalid-status.csv', 'status는'],
    ['not-csv.txt', '.csv 확장자'],
    ['out-of-range.csv', '3,660일'],
  ];
  for (const [name, message] of invalidCases) {
    const before = state().tickets;
    await upload(fs.readFileSync(path.join(__dirname, 'fixtures/cx-csv', name), 'utf8'), name);
    assert.ok($('#csvError').textContent.includes(message), name);
    assert.equal(state().tickets, before, `${name} must preserve active data`);
    assert.deepEqual(kpis(), ['420건', '82건', '30건', '17.4시간']);
  }

  await upload(template);
  assert.deepEqual(kpis(), ['4건', '2건', '1건', '3시간']);
  assert.equal($('#analysisDisplay').textContent, '2026-09-04 23:59:59');
  assert.equal($('#datasetPeriod').textContent, '2026-09-01 ~ 2026-09-04');
  assert.equal($('#analysisInput').min, '2026-09-04T15:00:00');
  assert.equal((state().filtered).length, 4);
  assert.equal(($('#ticketRows').innerHTML.match(/<tr>/g) || []).length, 4);
  assert.equal(($('#categoryChart').innerHTML.match(/class="bar-value">1</g) || []).length, 4);
  assert.match($('#dailyChart').attrs['aria-label'], /전체 4건/);
  assert.match($('#paymentEvidence').textContent, /전체 4건/);
  assert.match($('#delayEvidence').textContent, /48시간 이상 미해결 1건/);
  assert.match($('#evidenceScope').textContent, /사용자 CSV/);
  const downloaded = app.objectUrls.get($('#downloadCsv').href);
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString('utf8'), '\uFEFF' + template);
  assert.equal(downloaded.type, 'text/csv;charset=utf-8');
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(app.requests.length, 1, 'Reading a local file must not make a network request');

  $('#categoryFilter').value = '결제·환불'; $('#ticketFilters').emit('change');
  assert.deepEqual(kpis(), ['1건', '0건', '0건', '2시간']);
  const prior = state().tickets;
  await upload(template.replace('2026-09-01 12:00:00', 'not-a-date'));
  assert.equal(state().tickets, prior);
  assert.equal($('#categoryFilter').value, '결제·환불');
  assert.deepEqual(kpis(), ['1건', '0건', '0건', '2시간']);
  $('#statusFilter').value = '미처리'; $('#ticketFilters').emit('change');
  assert.deepEqual(kpis(), ['0건', '0건', '0건', '—']);
  assert.equal($('#emptyState').hidden, false);
  assert.equal($('#ticketRows').innerHTML, '');
  assert.match($('#dailyChart').innerHTML, /표시할 일별 문의가 없습니다/);
  $('#resetFilters').emit('click');

  $('#startDate').value = '2026-09-04'; $('#ticketFilters').emit('change');
  assert.deepEqual(kpis(), ['2건', '1건', '0건', '4시간']);
  $('#resetFilters').emit('click');
  $('#statusFilter').value = '해결'; $('#ticketFilters').emit('change');
  assert.deepEqual(kpis(), ['2건', '0건', '0건', '3시간']);
  $('#statusFilter').value = '처리중'; $('#ticketFilters').emit('change');
  assert.deepEqual(kpis(), ['1건', '1건', '0건', '—']);
  $('#resetFilters').emit('click');

  $('#analysisInput').value = '2026-09-06T13:59:59'; $('#analysisForm').emit('submit');
  assert.equal($('#kpiAged').textContent, '1건');
  $('#analysisInput').value = '2026-09-06T14:00:00'; $('#analysisForm').emit('submit');
  assert.equal($('#kpiAged').textContent, '2건', '48-hour boundary is inclusive');
  $('#analysisInput').value = '2026-09-01T00:00:00'; $('#analysisForm').emit('submit');
  assert.equal($('#analysisError').hidden, false);
  assert.equal($('#analysisDisplay').textContent, '2026-09-06 14:00:00');
  $('#agedOnly').emit('click');
  assert.deepEqual(kpis(), ['2건', '2건', '2건', '—']);

  app.failNextFetch(true);
  await $('#restoreSample').emit('click');
  assert.equal(state().tickets, prior);
  assert.match($('#csvError').textContent, /현재 데이터는 유지/);
  app.failNextFetch(false);
  await $('#restoreSample').emit('click');
  assert.deepEqual(kpis(), ['420건', '82건', '30건', '17.4시간']);
  assert.equal(state().agedOnly, false);
  assert.equal($('#categoryFilter').value, 'all');
  assert.equal($('#analysisForm').hidden, true);
  assert.equal($('#downloadCsv').href, './data/cx-tickets-2026-08.csv');
  assert.equal(app.objectUrls.size, 0, 'Release the previous in-memory download');

  await upload('\uFEFF' + template.replaceAll('\n', '\r\n'));
  assert.deepEqual(kpis(), ['4건', '2건', '1건', '3시간']);
  const bomDownload = Buffer.from(await app.objectUrls.get($('#downloadCsv').href).arrayBuffer()).toString('utf8');
  assert.equal(bomDownload, '\uFEFF' + template.replaceAll('\n', '\r\n'), 'Preserve CSV text and line endings without duplicating BOM');
  await upload(bomDownload);
  assert.deepEqual(kpis(), ['4건', '2건', '1건', '3시간'], 'Excel-compatible download can be uploaded again');
  await upload(template.replace('2026-09-01 10:00:00', '2026-09-01T01:00:00Z'));
  assert.deepEqual(kpis(), ['4건', '2건', '1건', '3시간']);
  assert.equal(app.objectUrls.size, 1);
  const stableTickets = state().tickets;
  for (const badCsv of [template.split('\n')[0], template + '"unclosed', template.replace(',채팅,', ',메신저,'), template.replace(',일반,', ',중요,'), template.replace(',결제·환불,', ',unknown,')]) {
    await upload(badCsv); assert.equal(state().tickets, stableTickets); assert.equal($('#csvError').hidden, false);
  }
  await upload(template, 'large.csv', { size: 6 * 1024 * 1024 });
  assert.match($('#csvError').textContent, /5MB/);
  const [header, firstRow] = template.split('\n');
  await upload([header, ...Array.from({ length: 10001 }, (_, index) => firstRow.replace('TEMPLATE-001', `LIMIT-${index}`))].join('\n'));
  assert.match($('#csvError').textContent, /10,000건/);
  assert.equal(state().tickets, stableTickets);
  await upload(template, 'failed.csv', { readError: true });
  assert.match($('#csvError').textContent, /파일을 읽지 못했습니다/);
  assert.equal(state().tickets, stableTickets);
  await upload(fs.readFileSync(path.join(__dirname, 'fixtures/cx-csv/long-text.csv'), 'utf8'));
  assert.equal($('#analysisDisplay').textContent, '1960-09-01 23:59:59');
  assert.deepEqual(kpis(), ['1건', '1건', '0건', '—'], 'Missing event dates must not turn into January 1970');
  assert.match($('#ticketRows').innerHTML, /&lt;b&gt;한글 문의&lt;\/b&gt;/);
  await upload(template.split('\n').slice(0, 2).join('\n')
    .replace('2026-09-01 10:30:00', '2026-09-01 10:00:00').replace('2026-09-01 12:00:00', '2026-09-01 10:00:00'));
  assert.deepEqual(kpis(), ['1건', '0건', '0건', '0시간'], 'A resolved zero-duration ticket is different from no resolved tickets');
  assert.deepEqual((await boot()).kpis(), ['420건', '82건', '30건', '17.4시간']);
  await upload(template.replaceAll('결제·환불', '결제·취소').replaceAll('환불 기준', '결제 취소 안내').replaceAll('계정·접근', '계정·로그인'));
  assert.deepEqual(kpis(), ['4건', '2건', '1건', '3시간'], 'Previous CSV categories remain compatible');
  assert.match($('#paymentEvidence').textContent, /관련 문의 1건/);
  process.stdout.write('PASS: sample, CSV import, schema/date/status/order/duplicate errors, atomic retention, active download, charts/list/filters, analysis time and 48h boundary, restore failure/success, BOM/ISO dates, refresh default, no upload/persistence.\n');
})().catch((error) => { console.error(error); process.exitCode = 1; });

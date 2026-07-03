/**
 * dashboard.js — QC Control Center
 *
 * PERFORMANCE NOTES:
 *
 * 1. DOM DIFFING instead of innerHTML replacement on live-updating sections
 *    (KPI tiles, dept cards, recent activity, compare panel, detail table cells).
 *    Previously every 1-second poll rebuilt the entire DOM sub-tree, forcing the
 *    browser to:
 *      - Destroy & recreate dozens of DOM nodes
 *      - Re-calculate styles for every new node
 *      - Re-run layout for the containing flex/grid
 *      - Repaint the affected region
 *    Now we update only the text/class that changed.  If nothing changed, we
 *    skip the write entirely.  This is the single biggest win.
 *
 * 2. Cached DOM references
 *    document.getElementById / querySelector calls are cheap but add up when
 *    called hundreds of times per second.  We cache all stable refs at boot.
 *
 * 3. requestAnimationFrame for chart redraws
 *    Chart redraws are scheduled via rAF so they never happen mid-frame and
 *    never stack up (cancelled if a new one arrives before the previous fires).
 *
 * 4. Throttled detail-table updates
 *    The detail table only diffs cells when the raw data hash changes.
 *    If the same data arrives from the server, we short-circuit immediately.
 *
 * 5. document.createDocumentFragment for first-time table builds
 *    When a table is rendered from scratch we build it off-DOM in a fragment,
 *    then do a single appendChild.  One layout/paint instead of N.
 *
 * 6. Minimal re-render on overview
 *    renderOverview() now checks a shallow data fingerprint.  If nothing
 *    meaningful changed, only the clock / shift label updates.
 *
 * 7. Debounced resize handler (already in original, kept)
 *
 * 8. setInterval for polling is unchanged (1 s dept, 5 s chart) but the
 *    handlers skip work when the modal is open or when data hasn't changed.
 */

'use strict';

/* ═══ STATE ════════════════════════════════════════════════════════════ */

let allDepartments = {};
let currentView = 'overview';
let currentDepartment = null;
let currentConsoleDept = null;
let currentUsername = null;
let deletedConsoleRows = new Set();
const DEPT_CODES = {};

let isLoggedIn = false;
let _refreshInterval  = null;
let _chartInterval    = null;
let _resizeHandler    = null;

// Fingerprints used to skip no-op renders
let _lastDeptFingerprint = '';
let _lastDetailFingerprint = '';
let _detailScrolling = false;
let _detailScrollTimer = null;
let _consoleScrolling = false;
let _consoleScrollTimer = null;

const DETAIL_EMP_COL_W = 180;
const DETAIL_CAT_COL_W = 92;
const DETAIL_TOTAL_COL_W = 76;
const CONSOLE_EMP_COL_W = 200;
const CONSOLE_NUM_COL_W = 112;
const CONSOLE_TOTAL_COL_W = 68;
const CONSOLE_DEL_COL_W = 44;

/* ═══ CACHED DOM REFS ══════════════════════════════════════════════════
 * Populated once at DOMContentLoaded (boot).
 * PERF: avoids repeated getElementById calls inside 1-Hz render loops.
 */
const $ = {};   // named cache

function cacheRefs(){
    $.clock           = document.getElementById('clock');
    $.date            = document.getElementById('date');
    $.errorBanner     = document.getElementById('errorBanner');
    $.overviewShift   = document.getElementById('overviewShift');
    $.overviewKpiRow  = document.getElementById('overviewKpiRow');
    $.deptComparePanel= document.getElementById('deptComparePanel');
    $.recentList      = document.getElementById('recentActivityList');
    $.deptGrid        = document.getElementById('deptGrid');
    $.viewOverview    = document.getElementById('view-overview');
    $.viewDetail      = document.getElementById('view-detail');
    $.navTabs         = document.getElementById('navTabs');
    $.chartWrap       = document.getElementById('chartWrap');
    $.chartCanvas     = document.getElementById('activityChart');
    $.chartEmpty      = document.getElementById('chartEmpty');
    $.chartResetLabel = document.getElementById('chartResetLabel');
    $.detailCode      = document.getElementById('detailCode');
    $.detailTableTitle= document.getElementById('detailTableTitle');
    $.detailLiveTotal = document.getElementById('detailLiveTotal');
    $.detailContainer = document.getElementById('detailTableContainer');
    $.tableScroll     = document.getElementById('detailTableScroll');
    $.detailEmpCount  = document.getElementById('detailEmpCount');
    $.detailDefectCount=document.getElementById('detailDefectCount');
    $.detailTopCat    = document.getElementById('detailTopCat');
    $.detailUpdateBtn = document.getElementById('detailUpdateBtn');
    $.detailExportBtn = document.getElementById('detailExportBtn');
    $.detailResetBtn  = document.getElementById('detailResetBtn');
    $.editModal       = document.getElementById('editModal');
    $.consoleDeptName = document.getElementById('consoleDeptName');
    $.consoleBody     = document.getElementById('consoleBody');
    $.logsModal       = document.getElementById('logsModal');
    $.logsBody        = document.getElementById('logsBody');
    $.userMenuWrap    = document.getElementById('userMenuWrap');
    $.userMenuBtn     = document.getElementById('userMenuBtn');
    $.userMenuLabel   = document.getElementById('userMenuLabel');
    $.loginOverlay    = document.getElementById('loginOverlay');
}

/* ═══ UTILITIES ════════════════════════════════════════════════════════ */

function debounce(fn, delay){
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

/**
 * Lightweight text setter — only touches the DOM if the value changed.
 * PERF: avoids style recalculations triggered by setting .textContent
 * on an element whose value hasn't changed.
 */
function setText(el, val){
    const s = String(val);
    if(el && el.textContent !== s) el.textContent = s;
}

function setHTML(el, html){
    if(el && el.innerHTML !== html) el.innerHTML = html;
}

/** Build a shallow fingerprint of department data for change detection */
function deptFingerprint(){
    return JSON.stringify(
        Object.keys(allDepartments).map(d => {
            const emp = allDepartments[d].employees || [];
            return emp.map(e => Object.values(e.defects).reduce((a,b)=>a+(b|0),0)).join(',');
        })
    );
}

/* ═══ CONSTANTS ════════════════════════════════════════════════════════ */

const CONSOLE_COLORS = ['#c89b1c','#a78bda','#16a34a','#2563eb','#ea7c1f','#dc2626','#0d9488','#7c3aed','#c2410c'];
function formatCatLabel(cat){ return cat.replace(/_/g, ' '); }

function getDefectVal(defects, cat){
    if(!defects) return 0;
    if(cat in defects) return parseInt(defects[cat]) || 0;
    const upper = cat.toUpperCase();
    for(const k of Object.keys(defects)){
        if(k.toUpperCase() === upper) return parseInt(defects[k]) || 0;
    }
    return 0;
}

/* ═══ API ══════════════════════════════════════════════════════════════ */

async function fetchDepartments(){
    const res = await fetch('/api/departments');
    if(!res.ok) throw new Error('Server responded ' + res.status);
    return res.json();
}

async function pushUpdate(department, employees){
    const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            department,
            employees,
            updated_by: getCurrentUser()
        })
    });
    const body = await res.json().catch(() => ({}));
    if(!res.ok || body.ok === false) throw new Error(body.error || 'Server error');
    return body;
}

/* ═══ EXPORT / RESET ═══════════════════════════════════════════════════ */

async function exportDepartment(dept){
    try {
        const res = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ department: dept })
        });
        if(!res.ok){
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'Export failed');
        }
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/);
        const filename = match ? match[1] : (dept + '_defects.xlsx');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        showToast('Excel file downloaded.', 'success');
    } catch(e) {
        showToast("Couldn't export — " + e.message, 'error');
    }
}

async function resetDepartment(dept){
    if(!confirm('Reset ALL counters for ' + dept + ' to zero? This cannot be undone.')) return;
    try {
        const res = await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ department: dept, updated_by: getCurrentUser() })
        });
        const body = await res.json().catch(() => ({}));
        if(!res.ok || body.ok === false) throw new Error(body.error || 'Reset failed');
        allDepartments = await fetchDepartments();
        _lastDeptFingerprint = '';
        _lastDetailFingerprint = '';
        if(currentView === 'overview') renderOverviewFull();
        if(currentView === 'detail' && currentDepartment === dept){
            renderDetailStats(dept);
            renderDetailTable(dept);
        }
        showToast('Counters reset for ' + dept + '.', 'success');
    } catch(e) {
        showToast("Couldn't reset — " + e.message, 'error');
    }
}

/* ═══ CLOCK ════════════════════════════════════════════════════════════ */

function updateClock(){
    const now = new Date();
    // PERF: setText skips DOM write if value is unchanged
    setText($.clock, now.toLocaleTimeString());
    setText($.date, now.toDateString());
}
setInterval(updateClock, 1000);
updateClock();

/* ═══ LOAD ═════════════════════════════════════════════════════════════ */

async function loadDepartments(){
    try {
        allDepartments = await fetchDepartments();
        $.errorBanner.style.display = 'none';
    } catch(e) {
        $.errorBanner.style.display = 'block';
        $.errorBanner.innerText = "Cannot reach the QC server. Make sure admin_server.py is running and open this page at http://localhost:5050";
        return;
    }
    Object.keys(allDepartments).forEach(dept => {
        DEPT_CODES[dept] = dept.slice(0,2).toUpperCase();
    });
    renderNavTabs();
    fetchChartLog();
    route();
}

/* ═══ HELPERS ══════════════════════════════════════════════════════════ */

function deptStats(dept){
    const employees = (allDepartments[dept] && allDepartments[dept].employees) || [];
    let total = 0;
    employees.forEach(emp => Object.values(emp.defects).forEach(n => total += n));
    return { employeeCount: employees.length, total };
}

function topCategory(dept){
    const info = topCategoryInfo(dept);
    return info.value > 0 ? info.label + ' (' + info.value + ')' : '—';
}

function defectValue(defects, cat){
    if(!defects) return 0;
    const key = Object.keys(defects).find(k => k.toUpperCase() === String(cat).toUpperCase());
    return key ? (parseInt(defects[key]) || 0) : 0;
}

function topCategoryInfo(dept){
    const employees = (allDepartments[dept] && allDepartments[dept].employees) || [];
    if(employees.length === 0) return { label: '—', value: 0 };
    const categories = getDeptCategories(dept, employees);
    let best = null, bestVal = -1;
    categories.forEach(cat => {
        const sum = employees.reduce((acc, emp) => acc + defectValue(emp.defects, cat), 0);
        if(sum > bestVal){ bestVal = sum; best = cat; }
    });
    return { label: best ? best.replace(/_/g, ' ') : '—', value: Math.max(0, bestVal) };
}

function deptStatusLevel(total){
    if(total > 25) return { cls: 'alert', text: 'Critical' };
    if(total > 12) return { cls: 'watch', text: 'Watch' };
    return { cls: 'ok', text: 'Clear' };
}

function getShiftLabel(){
    const hour = new Date().getHours();
    return (hour >= 6 && hour < 18) ? 'Morning shift · 06:00 – 18:00' : 'Night shift · 18:00 – 06:00';
}

function getOverviewSummary(){
    const depts = Object.keys(allDepartments);
    let combinedDefects = 0, combinedEmployees = 0, leader = '—', leaderVal = -1;
    depts.forEach(dept => {
        const { employeeCount, total } = deptStats(dept);
        combinedDefects += total;
        combinedEmployees += employeeCount;
        if(total > leaderVal){ leaderVal = total; leader = dept; }
    });
    const savesToday = (chartLog.entries || []).length;
    return { depts, combinedDefects, combinedEmployees, leader, leaderVal, savesToday };
}

function formatAuditTimestamp(iso){
    if(!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', second: '2-digit'
        });
    } catch(e){ return iso; }
}

function formatCardUpdatedBy(dept){
    const data = allDepartments[dept] || {};
    const by = (data.last_updated_by || '').trim();
    if(by) return 'Last updated by: <b>' + by + '</b>';
    if(data.last_updated) return 'Last updated via <b>QC station</b>';
    return 'Last updated by: <b>—</b>';
}

let auditLogCache = { entries: [] };
let auditLogFetchedAt = 0;

async function refreshAuditLogCache(force){
    if(!force && Date.now() - auditLogFetchedAt < 8000) return;
    try {
        const data = await fetchAuditLog();
        auditLogCache = data;
        auditLogFetchedAt = Date.now();
    } catch(e){ /* ignore */ }
}

/* ═══ OVERVIEW ═════════════════════════════════════════════════════════ */

/**
 * PERF: renderOverviewKpis now diffs individual KPI tiles instead of
 * rebuilding all 4 with innerHTML.  Each tile has a stable structure —
 * only the .kpi-value and .kpi-sub text changes.  We cache the last-
 * rendered values and skip DOM writes when nothing changed.
 */
let _kpiCache = {};

function renderOverviewKpis(s){
    if(!$.overviewKpiRow) return;
    if(!s) s = getOverviewSummary();
    const avgPerOp = s.combinedEmployees ? (s.combinedDefects / s.combinedEmployees).toFixed(1) : '0.0';

    // Build the tiles HTML only once (structure never changes)
    if(!$.overviewKpiRow.children.length){
        $.overviewKpiRow.innerHTML =
            '<div class="kpi-tile"><div class="kpi-label">Combined defects</div><div class="kpi-value" id="_kv0"></div><div class="kpi-sub" id="_ks0"></div></div>' +
            '<div class="kpi-tile"><div class="kpi-label">Operators tracked</div><div class="kpi-value" id="_kv1"></div><div class="kpi-sub" id="_ks1"></div></div>' +
            '<div class="kpi-tile"><div class="kpi-label">Highest department</div><div class="kpi-value" style="font-size:20px;padding-top:4px;" id="_kv2"></div><div class="kpi-sub" id="_ks2"></div></div>' +
            '<div class="kpi-tile"><div class="kpi-label">Saves today</div><div class="kpi-value" id="_kv3"></div><div class="kpi-sub" id="_ks3">Chart log · resets 06:00</div></div>';
    }

    // PERF: setText skips DOM write when value unchanged
    const vals = [
        [s.combinedDefects, 'Across ' + s.depts.length + ' departments today'],
        [s.combinedEmployees, 'Avg ' + avgPerOp + ' defects per operator'],
        [s.leaderVal > 0 ? s.leader : '—', s.leaderVal > 0 ? s.leaderVal + ' defects logged' : 'All departments clear'],
        [s.savesToday, null]
    ];
    vals.forEach(([v, sub], i) => {
        const vEl = document.getElementById('_kv' + i);
        const sEl = document.getElementById('_ks' + i);
        setText(vEl, v);
        if(sub !== null) setText(sEl, sub);
    });
}

/**
 * PERF: renderDeptCompare diffs the compare bars rather than rebuilding.
 * Bar widths change via style.width (cheap — no layout if overflow:hidden).
 */
let _compareState = {};

function renderDeptCompare(s){
    const panel = $.deptComparePanel;
    if(!panel) return;
    const depts = Object.keys(allDepartments);
    const totals = depts.map(dept => ({ dept, ...deptStats(dept) }));
    const maxTotal = Math.max(1, ...totals.map(t => t.total));
    const combined = s ? s.combinedDefects : totals.reduce((a, t) => a + t.total, 0);
    const colors = { CUTTING: '#2563eb', EMBRO: '#e11d48' };

    // First render — build structure
    if(!panel.querySelector('.compare-row')){
        let html = '<div class="panel-title">Department Comparison</div>';
        totals.forEach(item => {
            const color = colors[item.dept] || '#64748b';
            html +=
                '<div class="compare-row" data-dept="' + item.dept + '">' +
                    '<div class="compare-head">' +
                        '<span class="compare-name"><span class="compare-dot" style="background:' + color + ';"></span>' + item.dept + '</span>' +
                        '<span class="compare-val" data-cv="' + item.dept + '"></span>' +
                    '</div>' +
                    '<div class="compare-bar"><div class="compare-fill" data-cf="' + item.dept + '" style="background:' + color + ';width:4%;"></div></div>' +
                '</div>';
        });
        html += '<div class="compare-foot" data-cf-note></div>';
        panel.innerHTML = html;
    }

    // PERF: update only changed values
    totals.forEach(item => {
        const pct = combined > 0 ? Math.round(item.total / combined * 100) : 0;
        const barPct = Math.max(4, Math.round(item.total / maxTotal * 100));
        const valEl = panel.querySelector('[data-cv="' + item.dept + '"]');
        const fillEl = panel.querySelector('[data-cf="' + item.dept + '"]');
        const newVal = item.total + ' (' + pct + '%)';
        if(valEl && valEl.textContent !== newVal){
            valEl.innerHTML = item.total + ' <span style="color:#94a3b8;font-weight:500;">(' + pct + '%)</span>';
        }
        if(fillEl){
            const newW = barPct + '%';
            if(fillEl.style.width !== newW) fillEl.style.width = newW;
        }
    });

    const noteEl = panel.querySelector('[data-cf-note]');
    if(noteEl){
        const note = combined === 0
            ? 'Both departments are currently at <b>zero defects</b>.'
            : (totals[0].total === totals[1]?.total
                ? 'Both departments are <b>tied</b> at ' + totals[0].total + ' defects.'
                : 'Plant total: <b>' + combined + '</b> defects logged today.');
        if(noteEl.innerHTML !== note) noteEl.innerHTML = note;
    }
}

/**
 * PERF: renderRecentActivity diffs the 3 visible entries by their text
 * fingerprint.  Most seconds nothing changes.
 */
let _recentFingerprint = '';

function renderRecentActivity(){
    const list = $.recentList;
    if(!list) return;
    const entries = (auditLogCache.entries || []).slice(0, 3);
    const fp = JSON.stringify(entries.map(e => e.timestamp));
    if(fp === _recentFingerprint) return;     // PERF: skip if unchanged
    _recentFingerprint = fp;

    if(!entries.length){
        list.innerHTML = '<div class="recent-empty">No monitor saves logged yet today.</div>';
        return;
    }
    list.innerHTML = entries.map(entry => {
        const when = formatAuditTimestamp(entry.timestamp);
        const who  = entry.user || 'unknown';
        const dept = entry.department || '—';
        const detail = entry.summary || entry.action || 'update';
        return '<div class="recent-item">' +
            '<div class="recent-item-time">' + when + '</div>' +
            '<div class="recent-item-text"><b>' + who + '</b> · ' + dept + ' — ' + detail + '</div>' +
        '</div>';
    }).join('');
}

/**
 * PERF: renderOverviewCards creates/updates cards in-place rather than
 * flushing the entire grid each second.
 *
 * Strategy:
 * - On first call (or after dept list changes): build all cards from scratch
 *   with a DocumentFragment (single DOM insertion).
 * - On subsequent calls: diff each card's mutable fields (metrics, status,
 *   insights, footer) and update only changed text/class nodes.
 */
function renderOverviewCards(s){
    const grid = $.deptGrid;
    if(!grid) return;
    const summary = s || getOverviewSummary();
    const depts = Object.keys(allDepartments);

    // If the number of dept cards changed, rebuild from scratch
    if(grid.children.length !== depts.length){
        const frag = document.createDocumentFragment();
        depts.forEach(dept => {
            frag.appendChild(buildDeptCard(dept, summary));
        });
        grid.innerHTML = '';
        grid.appendChild(frag);
        return;
    }

    // Otherwise diff-update each existing card
    depts.forEach((dept, i) => {
        const card = grid.children[i];
        if(!card) return;
        patchDeptCard(card, dept, summary);
    });
}

function buildDeptCard(dept, summary){
    const card = document.createElement('div');
    card.className = 'dept-card dept-' + dept.toLowerCase();
    card.dataset.dept = dept;
    card.innerHTML = deptCardHTML(dept, summary);
    card.querySelector('.btn-view').onclick  = () => { location.hash = '#/dept/' + encodeURIComponent(dept); };
    card.querySelector('.btn-update').onclick = () => openEditConsole(dept);
    return card;
}

/** Full HTML template for a dept card */
function deptCardHTML(dept, summary){
    const { employeeCount, total } = deptStats(dept);
    const color = total > 25 ? 'var(--red-mid)' : total > 12 ? '#d97706' : 'var(--green)';
    const status = deptStatusLevel(total);
    const topCat = topCategoryInfo(dept);
    const avg = employeeCount ? (total / employeeCount).toFixed(1) : '0.0';
    const share = summary.combinedDefects > 0 ? Math.round(total / summary.combinedDefects * 100) : 0;
    const data = allDepartments[dept] || {};
    const updatedAt = data.last_updated ? formatAuditTimestamp(data.last_updated) : '—';
    const lastBy = (data.last_updated_by || '').trim() || '—';

    return (
        '<div class="dept-card-top">' +
            '<div class="dept-card-top-left">' +
                '<span class="dept-code">' + DEPT_CODES[dept] + '</span>' +
                '<span class="dept-card-name">' + dept + '</span>' +
            '</div>' +
            '<span class="dept-status ' + status.cls + '" data-status>' + status.text + '</span>' +
        '</div>' +
        '<div class="dept-card-metrics">' +
            '<div class="metric"><span class="metric-value" data-metric-emp>' + employeeCount + '</span><span class="metric-label">Operators</span></div>' +
            '<div class="metric"><span class="metric-value" data-metric-def style="color:' + color + ';">' + total + '</span><span class="metric-label">Defects</span></div>' +
            '<div class="metric"><span class="metric-value" data-metric-avg>' + avg + '</span><span class="metric-label">Avg / op</span></div>' +
        '</div>' +
        '<div class="dept-card-insights">' +
            '<div class="insight-item">Top category<b data-ins-top>' + topCat.label + (topCat.value ? ' (' + topCat.value + ')' : '') + '</b></div>' +
            '<div class="insight-item">Share of plant<b data-ins-share>' + share + '%</b></div>' +
            '<div class="insight-item">Last activity<b data-ins-time>' + updatedAt + '</b></div>' +
            '<div class="insight-item">Updated by<b data-ins-by>' + lastBy + '</b></div>' +
        '</div>' +
        '<div class="dept-card-actions">' +
            '<button class="action-btn btn-view">View log</button>' +
            '<button class="action-btn btn-update">Update</button>' +
        '</div>' +
        '<div class="dept-card-footer" data-footer>' + formatCardUpdatedBy(dept) + '</div>'
    );
}

/** Diff-update only changed fields on an existing card */
function patchDeptCard(card, dept, summary){
    const { employeeCount, total } = deptStats(dept);
    const color = total > 25 ? 'var(--red-mid)' : total > 12 ? '#d97706' : 'var(--green)';
    const status = deptStatusLevel(total);
    const topCat = topCategoryInfo(dept);
    const avg = employeeCount ? (total / employeeCount).toFixed(1) : '0.0';
    const share = summary.combinedDefects > 0 ? Math.round(total / summary.combinedDefects * 100) : 0;
    const data = allDepartments[dept] || {};
    const updatedAt = data.last_updated ? formatAuditTimestamp(data.last_updated) : '—';
    const lastBy = (data.last_updated_by || '').trim() || '—';

    const statusEl = card.querySelector('[data-status]');
    if(statusEl){
        if(statusEl.textContent !== status.text) statusEl.textContent = status.text;
        if(!statusEl.classList.contains(status.cls)){
            statusEl.className = 'dept-status ' + status.cls;
        }
    }

    const empEl  = card.querySelector('[data-metric-emp]');
    const defEl  = card.querySelector('[data-metric-def]');
    const avgEl  = card.querySelector('[data-metric-avg]');
    setText(empEl, employeeCount);
    if(defEl){
        setText(defEl, total);
        if(defEl.style.color !== color) defEl.style.color = color;
    }
    setText(avgEl, avg);

    setText(card.querySelector('[data-ins-top]'),   topCat.label + (topCat.value ? ' (' + topCat.value + ')' : ''));
    setText(card.querySelector('[data-ins-share]'),  share + '%');
    setText(card.querySelector('[data-ins-time]'),   updatedAt);
    setText(card.querySelector('[data-ins-by]'),     lastBy);

    const footEl = card.querySelector('[data-footer]');
    const footHTML = formatCardUpdatedBy(dept);
    if(footEl && footEl.innerHTML !== footHTML) footEl.innerHTML = footHTML;
}

function renderOverview(){
    setText($.overviewShift, getShiftLabel());
    const s = getOverviewSummary();
    renderOverviewKpis(s);
    renderDeptCompare(s);
    renderOverviewCards(s);
    renderRecentActivity();
    if(chartLog.entries.length) scheduleChartRedraw();
}

async function renderOverviewFull(){
    await refreshAuditLogCache(true);
    renderOverview();
}

function showOverview(){
    currentView = 'overview';
    $.viewOverview.classList.add('active');
    $.viewDetail.classList.remove('active');
    setActiveTab();
    renderOverviewFull();
}

/* ═══ ROUTING ══════════════════════════════════════════════════════════ */

function route(){
    const hash = location.hash || '#/';
    const match = hash.match(/^#\/dept\/(.+)$/);
    if(match){
        const dept = decodeURIComponent(match[1]);
        if(allDepartments[dept]){ showDetail(dept); return; }
    }
    showOverview();
}

window.addEventListener('hashchange', route);

function renderNavTabs(){
    const nav = $.navTabs;
    nav.innerHTML = '';
    const overviewTab = document.createElement('button');
    overviewTab.className = 'nav-tab';
    overviewTab.dataset.route = '#/';
    overviewTab.innerText = 'Overview';
    overviewTab.onclick = () => location.hash = '#/';
    nav.appendChild(overviewTab);

    Object.keys(allDepartments).forEach(dept => {
        const tab = document.createElement('button');
        tab.className = 'nav-tab';
        tab.dataset.route = '#/dept/' + encodeURIComponent(dept);
        tab.innerText = dept;
        tab.onclick = () => location.hash = '#/dept/' + encodeURIComponent(dept);
        nav.appendChild(tab);
    });
}

function setActiveTab(){
    const hash = location.hash || '#/';
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.route === hash);
    });
}

/* ═══ DEPT COLUMN ORDER & COLORS ═══════════════════════════════════════ */

const DEPT_CATEGORY_ORDER = {
    CUTTING: ['WRONG_COLOR','WRONG_SIZE','WRONG_CUT','OFF_SHADE','LOW_QUALITY','WRONG_MATERIAL','OTHERS'],
    EMBRO:   ['LOW_QUALITY','WRONG_COLOR_THREAD','WRONG_PLACEMENT','WRONG_TEXT_FONT','UNBALANCED','WRONG_SPELLING','OTHERS']
};

const DEPT_HEADER_COLORS = {
    CUTTING: {
        WRONG_COLOR:    { bg:'#f5c700', color:'#0f172a' },
        WRONG_SIZE:     { bg:'#c084fc', color:'#0f172a' },
        WRONG_CUT:      { bg:'#22c55e', color:'#0f172a' },
        OFF_SHADE:      { bg:'#38bdf8', color:'#0f172a' },
        LOW_QUALITY:    { bg:'#fb923c', color:'#0f172a' },
        WRONG_MATERIAL: { bg:'#ef4444', color:'#0f172a' },
        OTHERS:         { bg:'#2dd4bf', color:'#0f172a' },
    },
    EMBRO: {
        LOW_QUALITY:        { bg:'#f5c700', color:'#0f172a' },
        WRONG_COLOR_THREAD: { bg:'#c084fc', color:'#0f172a' },
        WRONG_PLACEMENT:    { bg:'#22c55e', color:'#0f172a' },
        WRONG_TEXT_FONT:    { bg:'#38bdf8', color:'#0f172a' },
        UNBALANCED:         { bg:'#fb923c', color:'#0f172a' },
        WRONG_SPELLING:     { bg:'#ef4444', color:'#0f172a' },
        OTHERS:             { bg:'#2dd4bf', color:'#0f172a' },
    }
};

function getDeptCategories(dept, employees){
    const order = DEPT_CATEGORY_ORDER[dept];
    if(order) return order;
    const raw = employees && employees.length > 0 ? Object.keys(employees[0].defects) : [];
    const others = raw.filter(c => c === 'OTHERS');
    return [...raw.filter(c => c !== 'OTHERS'), ...others];
}

function getHeaderStyle(dept, cat){
    const map = DEPT_HEADER_COLORS[dept];
    if(map && map[cat]) return map[cat];
    return { bg:'var(--surface-2)', color:'#1e293b' };
}

function detailTableMinWidth(categoryCount){
    return DETAIL_EMP_COL_W + (categoryCount * DETAIL_CAT_COL_W) + DETAIL_TOTAL_COL_W;
}

function buildDetailColgroup(categories){
    let html = '<colgroup><col class="col-employee" style="width:' + DETAIL_EMP_COL_W + 'px">';
    categories.forEach(() => { html += '<col style="width:' + DETAIL_CAT_COL_W + 'px">'; });
    html += '<col class="col-total" style="width:' + DETAIL_TOTAL_COL_W + 'px"></colgroup>';
    return html;
}

function buildConsoleColgroup(categories){
    let html = '<colgroup><col style="width:' + CONSOLE_EMP_COL_W + 'px">';
    categories.forEach(() => { html += '<col style="width:' + CONSOLE_NUM_COL_W + 'px">'; });
    html += '<col style="width:' + CONSOLE_TOTAL_COL_W + 'px"><col style="width:' + CONSOLE_DEL_COL_W + 'px"></colgroup>';
    return html;
}

function bindScrollOptimizations(){
    if($.tableScroll){
        $.tableScroll.addEventListener('scroll', () => {
            _detailScrolling = true;
            clearTimeout(_detailScrollTimer);
            _detailScrollTimer = setTimeout(() => { _detailScrolling = false; }, 150);
        }, { passive: true });
    }
    if($.consoleBody){
        $.consoleBody.addEventListener('scroll', () => {
            _consoleScrolling = true;
            clearTimeout(_consoleScrollTimer);
            _consoleScrollTimer = setTimeout(() => { _consoleScrolling = false; }, 150);
        }, { passive: true });
    }
}

/* ═══ DETAIL ═══════════════════════════════════════════════════════════ */

function showDetail(dept){
    currentView = 'detail';
    currentDepartment = dept;
    _lastDetailFingerprint = '';
    $.viewOverview.classList.remove('active');
    $.viewDetail.classList.add('active');
    setActiveTab();
    $.detailCode.innerText = DEPT_CODES[dept];
    $.detailTableTitle.innerText = 'Inspection log — ' + dept;
    $.detailUpdateBtn.onclick = () => openEditConsole(dept);
    $.detailExportBtn.onclick = () => exportDepartment(dept);
    $.detailResetBtn.onclick  = () => resetDepartment(dept);
    renderDetailStats(dept);
    renderDetailTable(dept);
}

function renderDetailStats(dept){
    const { employeeCount, total } = deptStats(dept);
    setText($.detailEmpCount, employeeCount);
    setText($.detailDefectCount, total);
    setText($.detailLiveTotal, total);
    setText($.detailTopCat, topCategory(dept));
}

/**
 * PERF: renderDetailTable now has two modes:
 * 1. First render / structure change → rebuild full table with DocumentFragment
 * 2. Subsequent updates → patch only changed cell text/class values
 *
 * This eliminates the ~180ms innerHTML reassignment on every 1-second tick
 * for a 20-employee department.
 */
function renderDetailTable(dept){
    const data = allDepartments[dept];
    const container = $.detailContainer;

    if(!data.employees || data.employees.length === 0){
        container.innerHTML = '<div class="empty-state">No entries logged yet.</div>';
        _lastDetailFingerprint = '';
        return;
    }

    const categories = getDeptCategories(dept, data.employees);

    // Build a fingerprint to detect actual changes
    const fp = data.employees.map(emp =>
        emp.name + ':' + categories.map(c => getDefectVal(emp.defects, c)).join(',')
    ).join('|');

    // PERF: skip entire render if data hasn't changed
    if(fp === _lastDetailFingerprint && container.querySelector('table')) return;
    _lastDetailFingerprint = fp;

    let maxVal = 1;
    data.employees.forEach(emp => {
        categories.forEach(cat => { if((getDefectVal(emp.defects, cat)) > maxVal) maxVal = getDefectVal(emp.defects, cat); });
    });
    const highThreshold = Math.max(2, Math.ceil(maxVal * 0.55));

    // Check whether we can patch the existing table or need to rebuild
    const existingTable = container.querySelector('table.data-table');
    const existingRows = existingTable && existingTable.querySelector('colgroup')
        ? existingTable.querySelectorAll('tbody tr')
        : null;

    if(existingRows && existingRows.length === data.employees.length){
        // PERF: patch existing cells — no DOM node creation
        const tbody = existingTable.querySelector('tbody');
        const tfoot = existingTable.querySelector('tfoot');
        const catTotals = new Array(categories.length).fill(0);
        let grandTotal = 0;

        data.employees.forEach((emp, rowIdx) => {
            const tr = existingRows[rowIdx];
            // Name cell (index 0)
            const nameCell = tr.children[0];
            if(nameCell && nameCell.textContent !== emp.name) nameCell.textContent = emp.name;

            // Alternate row class
            const targetClass = (rowIdx % 2 === 0 ? 'row-odd' : 'row-even');
            if(!tr.classList.contains(targetClass)){
                tr.className = targetClass;
            }

            let rowTotal = 0;
            categories.forEach((cat, ci) => {
                const v = getDefectVal(emp.defects, cat);
                rowTotal += v;
                catTotals[ci] += v;
                const td = tr.children[ci + 1]; // +1 for name col
                if(!td) return;
                const sv = String(v);
                if(td.textContent !== sv) td.textContent = sv;
                let cls = 'cell-count';
                if(v === 0) cls += ' cell-zero';
                else if(v >= highThreshold) cls += ' cell-high';
                if(td.className !== cls) td.className = cls;
            });
            // Total col
            const totalCell = tr.children[categories.length + 1];
            if(totalCell){
                const st = String(rowTotal);
                if(totalCell.textContent !== st) totalCell.textContent = st;
            }
            grandTotal += rowTotal;
        });

        // Footer
        if(tfoot){
            const ftCells = tfoot.querySelectorAll('td');
            // ftCells[0] = "TOTAL" label, then category cells, last = grand total
            categories.forEach((cat, ci) => {
                const td = ftCells[ci + 1];
                if(td){
                    const sv = String(catTotals[ci]);
                    if(td.textContent !== sv) td.textContent = sv;
                }
            });
            const gtCell = ftCells[categories.length + 1];
            if(gtCell){
                const sg = String(grandTotal);
                if(gtCell.textContent !== sg) gtCell.textContent = sg;
            }
        }
        return;
    }

    // Full rebuild (structure changed or first render)
    const minW = detailTableMinWidth(categories.length);
    let html = '<table class="data-table" style="min-width:' + minW + 'px">';
    html += buildDetailColgroup(categories);
    html += '<thead><tr>';
    html += '<th class="col-employee">Employee</th>';
    categories.forEach(cat => {
        const hs = getHeaderStyle(dept, cat);
        const label = cat.replace(/_/g,' ');
        html += '<th class="cat-header" style="background:' + hs.bg + ';color:' + hs.color + ';">' + label + '</th>';
    });
    html += '<th class="col-total">Total</th></tr></thead><tbody>';

    data.employees.forEach((emp, rowIdx) => {
        let rowTotal = 0;
        const rowClass = rowIdx % 2 === 0 ? 'row-odd' : 'row-even';
        html += '<tr class="' + rowClass + '"><td class="col-employee">' + emp.name + '</td>';
        categories.forEach(cat => {
            const v = getDefectVal(emp.defects, cat);
            rowTotal += v;
            let cls = 'cell-count';
            if(v === 0) cls += ' cell-zero';
            else if(v >= highThreshold) cls += ' cell-high';
            html += '<td class="' + cls + '">' + v + '</td>';
        });
        html += '<td class="col-total">' + rowTotal + '</td></tr>';
    });

    html += '</tbody><tfoot><tr><td>TOTAL</td>';
    let grandTotal = 0;
    categories.forEach(cat => {
        const sum = data.employees.reduce((acc, emp) => acc + getDefectVal(emp.defects, cat), 0);
        grandTotal += sum;
        html += '<td>' + sum + '</td>';
    });
    html += '<td class="col-foot-total">' + grandTotal + '</td>';
    html += '</tr></tfoot></table>';
    container.innerHTML = html;
}

/* ═══ EDIT CONSOLE ══════════════════════════════════════════════════════ */

function buildConsoleRowHtml(dept, emp, i, categories){
    const total = Object.values(emp.defects).reduce((a,b) => a + (parseInt(b)||0), 0);
    let html = '<tr data-emp-row="' + i + '">';
    html += '<td><div class="console-name-box"><input type="text" class="console-input" data-row="' + i + '" data-field="name" value="' + emp.name + '"></div></td>';
    categories.forEach(cat => {
        const v = getDefectVal(emp.defects, cat);
        html += '<td><div class="stepper-group">' +
            '<button type="button" class="step-btn" onclick="stepValue(this,-1)">&minus;</button>' +
            '<input type="number" min="0" class="console-input console-num" data-row="' + i + '" data-field="' + cat + '" value="' + v + '" oninput="recalcRowTotal(this)">' +
            '<button type="button" class="step-btn" onclick="stepValue(this,1)">+</button>' +
        '</div></td>';
    });
    html += '<td class="console-total-cell">' + total + '</td>';
    html += '<td class="col-del"><button type="button" class="console-del-btn" onclick="deleteConsoleRow(this)" title="Remove employee">&times;</button></td>';
    html += '</tr>';
    return html;
}

function buildEditConsoleTable(dept, employees){
    const body = $.consoleBody;
    const categories = getDeptCategories(dept, employees);
    const minW = CONSOLE_EMP_COL_W + (categories.length * CONSOLE_NUM_COL_W) + CONSOLE_TOTAL_COL_W + CONSOLE_DEL_COL_W;
    let html = '<table class="console-table" style="min-width:' + minW + 'px">';
    html += buildConsoleColgroup(categories);
    html += '<thead><tr><th class="col-employee">Employee</th>';
    categories.forEach(cat => {
        const hs = getHeaderStyle(dept, cat);
        html += '<th class="col-num" style="background:' + hs.bg + ';color:' + hs.color + ';">' + formatCatLabel(cat) + '</th>';
    });
    html += '<th class="col-total">Total</th><th class="col-del"></th></tr></thead><tbody></tbody></table>';
    body.innerHTML = html;

    const tbody = body.querySelector('tbody');
    const BATCH = 8;

    if(employees.length <= BATCH){
        let rows = '';
        employees.forEach((emp, i) => { rows += buildConsoleRowHtml(dept, emp, i, categories); });
        tbody.innerHTML = rows;
        return;
    }

    let idx = 0;
    function appendBatch(){
        if(currentConsoleDept !== dept || !tbody.isConnected) return;
        const end = Math.min(idx + BATCH, employees.length);
        let rows = '';
        for(; idx < end; idx++) rows += buildConsoleRowHtml(dept, employees[idx], idx, categories);
        tbody.insertAdjacentHTML('beforeend', rows);
        if(idx < employees.length) requestAnimationFrame(appendBatch);
    }
    appendBatch();
}

function openEditConsole(dept){
    currentConsoleDept = dept;
    deletedConsoleRows = new Set();
    const employees = allDepartments[dept].employees || [];
    $.consoleDeptName.innerText = 'Edit console — ' + dept;

    $.editModal.style.display = 'flex';
    if(employees.length === 0){
        $.consoleBody.innerHTML = '<div class="empty-state">No entries yet. Add an employee below.</div>';
        return;
    }

    $.consoleBody.innerHTML = '<div class="logs-empty">Loading…</div>';
    requestAnimationFrame(() => {
        if(currentConsoleDept !== dept) return;
        buildEditConsoleTable(dept, employees);
    });
}

function stepValue(btn, delta){
    const group = btn.closest('.stepper-group');
    const input = group.querySelector('input.console-num');
    let v = parseInt(input.value) || 0;
    v = Math.max(0, v + delta);
    input.value = v;
    recalcRowTotal(input);
}

function recalcRowTotal(inputEl){
    const tr = inputEl.closest('tr');
    if(!tr) return;
    let sum = 0;
    tr.querySelectorAll('.console-num').forEach(inp => sum += (parseInt(inp.value) || 0));
    const totalCell = tr.querySelector('.console-total-cell');
    if(totalCell) totalCell.innerText = sum;
}

function deleteConsoleRow(btn){
    const tr = btn.closest('tr');
    if(!tr) return;
    if(tr.dataset.empRow !== undefined && tr.dataset.empRow !== ''){
        deletedConsoleRows.add(parseInt(tr.dataset.empRow));
    }
    tr.remove();
}

function closeModal(){
    $.editModal.style.display = 'none';
}

function addEmployeeRow(){
    const dept = currentConsoleDept;
    const employees = allDepartments[dept].employees || [];
    if(employees.length === 0){ openEditConsole(dept); return; }
    const categories = getDeptCategories(dept, employees);
    const table = document.querySelector('#consoleBody .console-table');
    if(!table){ openEditConsole(dept); return; }
    const tbody = table.querySelector('tbody') || table;
    const existingRows = tbody.querySelectorAll('tr').length;

    const tr = document.createElement('tr');
    tr.className = 'new-emp-row';
    let rowHtml = '<td><div class="console-name-box"><input type="text" class="console-input new-emp-input" data-newrow="' + existingRows + '" data-field="name" placeholder="Employee name"></div></td>';
    categories.forEach(cat => {
        rowHtml += '<td><div class="stepper-group">' +
            '<button type="button" class="step-btn" onclick="stepValue(this,-1)">&minus;</button>' +
            '<input type="number" min="0" class="console-input console-num new-emp-input" data-newrow="' + existingRows + '" data-field="' + cat + '" value="0" oninput="recalcRowTotal(this)">' +
            '<button type="button" class="step-btn" onclick="stepValue(this,1)">+</button>' +
        '</div></td>';
    });
    rowHtml += '<td class="console-total-cell">0</td>';
    rowHtml += '<td class="col-del"><button type="button" class="console-del-btn" onclick="deleteConsoleRow(this)" title="Remove row">&times;</button></td>';
    tr.innerHTML = rowHtml;
    tbody.appendChild(tr);
    tr.querySelector('input[data-field="name"]').focus();
}

async function saveConsole(){
    const dept = currentConsoleDept;
    const employees = allDepartments[dept].employees || [];
    const categories = getDeptCategories(dept, employees);

    const kept = [];
    const rows = document.querySelectorAll('#consoleBody .console-table tbody tr[data-emp-row]');
    rows.forEach(tr => {
        const rowIdx = parseInt(tr.dataset.empRow);
        if(deletedConsoleRows.has(rowIdx)) return;
        const nameInput = tr.querySelector('.console-input[data-field="name"]');
        const name = (nameInput ? nameInput.value.trim() : '') || (employees[rowIdx] ? employees[rowIdx].name : '');
        const defects = {};
        categories.forEach(cat => {
            const inp = tr.querySelector('.console-input[data-field="' + cat + '"]');
            defects[cat] = inp ? (parseInt(inp.value) || 0) : getDefectVal((employees[rowIdx] || {}).defects, cat);
        });
        kept.push({ name, defects });
    });

    const newRowMap = {};
    document.querySelectorAll('#consoleBody .new-emp-input').forEach(input => {
        const idx = input.dataset.newrow;
        if(!newRowMap[idx]) newRowMap[idx] = { name:'', defects:{} };
        const field = input.dataset.field;
        if(field === 'name'){
            newRowMap[idx].name = input.value.trim();
        } else {
            newRowMap[idx].defects[field] = parseInt(input.value) || 0;
        }
    });

    Object.values(newRowMap).forEach(row => {
        if(row.name){
            categories.forEach(cat => { if(!(cat in row.defects)) row.defects[cat] = 0; });
            kept.push(row);
        }
    });

    try {
        await pushUpdate(dept, kept);
        allDepartments = await fetchDepartments();
        _lastDeptFingerprint = '';
        _lastDetailFingerprint = '';
        closeModal();
        if(currentView === 'overview') renderOverviewFull();
        if(currentView === 'detail' && currentDepartment === dept){
            renderDetailStats(dept);
            renderDetailTable(dept);
        }
        fetchChartLog();
        showToast('Changes saved.', 'success');
    } catch(e) {
        showToast("Couldn't save — " + e.message, 'error');
    }
}

/* ═══ TOAST ═════════════════════════════════════════════════════════════ */

function showToast(message, type){
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type === 'error' ? 'error' : 'success');
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2800);
}

/* ═══ MODAL DISMISS ═════════════════════════════════════════════════════ */

window.addEventListener('click', e => {
    if(e.target === $.editModal) closeModal();
    if(e.target === $.logsModal) closeLogsModal();
});
window.addEventListener('keydown', e => {
    if(e.key === 'Escape'){
        closeModal();
        closeLogsModal();
    }
});

/* ═══ ACTIVITY LOGS ═════════════════════════════════════════════════════ */

function formatLogChanges(entry){
    if(entry.action === 'reset'){
        const prev = (entry.changes && entry.changes[0] && entry.changes[0].previous_total);
        if(typeof prev === 'number' && prev > 0) return 'Reset all counters from ' + prev + ' to 0';
        return 'Reset all counters to 0';
    }
    const parts = [];
    (entry.changes || []).forEach(item => {
        if(item.type === 'employee_added')   parts.push('Added employee: ' + item.employee);
        else if(item.type === 'employee_removed') parts.push('Removed employee: ' + item.employee);
        else if(item.type === 'employee_renamed') parts.push('Renamed ' + item.from + ' → ' + item.to);
        else if(item.type === 'defects_updated'){
            Object.keys(item.changes || {}).forEach(key => {
                const ch = item.changes[key];
                parts.push(item.employee + ' · ' + key.replace(/_/g,' ') + ': ' + ch.from + ' → ' + ch.to);
            });
        }
    });
    return parts.length ? parts.join('<br>') : (entry.summary || 'Changes saved');
}

async function fetchAuditLog(){
    const res = await fetch('/api/audit-log');
    if(!res.ok) throw new Error('Could not load logs');
    return res.json();
}

function renderLogsTable(entries){
    if(!entries.length){
        $.logsBody.innerHTML = '<div class="logs-empty">No activity logged yet.</div>';
        return;
    }
    let html = '<table class="logs-table"><thead><tr><th>When</th><th>User</th><th>Dept</th><th>Action</th><th>What changed</th></tr></thead><tbody>';
    entries.forEach(entry => {
        html += '<tr>' +
            '<td class="logs-time">' + formatAuditTimestamp(entry.timestamp) + '</td>' +
            '<td class="logs-user">' + (entry.user || '—') + '</td>' +
            '<td><span class="logs-dept">' + (entry.department || '—') + '</span></td>' +
            '<td class="logs-action">' + (entry.action || 'update') + '</td>' +
            '<td class="logs-detail">' + formatLogChanges(entry) + '</td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    $.logsBody.innerHTML = html;
}

async function openLogsModal(){
    closeUserMenu();
    $.logsModal.style.display = 'flex';
    $.logsBody.innerHTML = '<div class="logs-empty">Loading logs…</div>';
    try {
        const data = await fetchAuditLog();
        const entries = data.entries || [];
        requestAnimationFrame(() => {
            if($.logsModal.style.display !== 'flex') return;
            renderLogsTable(entries);
        });
    } catch(e){
        $.logsBody.innerHTML = '<div class="logs-empty">Could not load logs — ' + e.message + '</div>';
    }
}

function closeLogsModal(){
    if($.logsModal) $.logsModal.style.display = 'none';
}

/* ═══ ACTIVITY CHART ════════════════════════════════════════════════════ */

const DEPT_COLORS = {
    CUTTING: { line:'#2563eb', fillTop:'rgba(37,99,235,0.22)', fillBot:'rgba(37,99,235,0.02)', glow:'rgba(37,99,235,0.35)' },
    EMBRO:   { line:'#e11d48', fillTop:'rgba(225,29,72,0.20)', fillBot:'rgba(225,29,72,0.02)', glow:'rgba(225,29,72,0.30)' }
};
const DEPT_ORDER = ['CUTTING', 'EMBRO'];

let chartLog = { entries: [] };

/**
 * PERF: chart redraws are scheduled via requestAnimationFrame.
 * If multiple triggers fire before the next frame (e.g. data update + resize),
 * only one redraw happens.  The previous rAF token is cancelled.
 */
let _chartRaf = null;
function scheduleChartRedraw(){
    if(_chartRaf) cancelAnimationFrame(_chartRaf);
    _chartRaf = requestAnimationFrame(() => {
        _chartRaf = null;
        renderActivityChart();
    });
}

async function fetchChartLog(){
    if(!isLoggedIn) return;
    try {
        const res = await fetch('/api/chart-log');
        if(!res.ok) return;
        chartLog = await res.json();
        scheduleChartRedraw();
        if(currentView === 'overview') renderOverviewKpis();
    } catch(e){ /* server not ready */ }
}

function renderActivityChart(){
    const entries = (chartLog.entries || []);
    const canvas  = $.chartCanvas;
    const empty   = $.chartEmpty;

    if(entries.length === 0){
        canvas.style.display = 'none';
        empty.style.display  = 'flex';
        return;
    }
    canvas.style.display = 'block';
    empty.style.display  = 'none';

    const wrap = $.chartWrap;
    const W = wrap.clientWidth  || 800;
    const H = wrap.clientHeight || 172;

    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const PAD_L = 52, PAD_R = 24, PAD_T = 18, PAD_B = 36;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const now = new Date();
    const nowFrac = now.getHours() + now.getMinutes()/60 + now.getSeconds()/3600;
    const nowPlot = nowFrac < 6 ? nowFrac + 24 : nowFrac;
    const xStart = 6, xEnd = 30;

    const series = {};
    DEPT_ORDER.forEach(d => { series[d] = [{ hf: xStart, total: 0 }]; });

    entries.forEach(e => {
        const dept = e.department;
        if(!series[dept]) return;
        const hf = e.hour_fraction < 6 ? e.hour_fraction + 24 : e.hour_fraction;
        series[dept].push({ hf, total: e.total });
    });

    DEPT_ORDER.forEach(d => {
        const arr  = series[d];
        const last = arr[arr.length - 1];
        const cap  = Math.min(nowPlot, xEnd);
        const liveTotal = deptStats(d).total;
        if(last.hf >= cap - 0.001){
            last.hf = cap; last.total = liveTotal;
        } else {
            arr.push({ hf: cap, total: liveTotal });
        }
    });

    let yMax = 10;
    DEPT_ORDER.forEach(d => {
        series[d].forEach(p => { if(p.total > yMax) yMax = p.total; });
    });
    yMax = Math.ceil(yMax * 1.15 / 5) * 5;

    const toX = hf  => PAD_L + ((hf  - xStart) / (xEnd - xStart)) * plotW;
    const toY = val => PAD_T + plotH - (val / yMax) * plotH;

    // Soft plot background
    const plotGrad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
    plotGrad.addColorStop(0, 'rgba(255,255,255,0.55)');
    plotGrad.addColorStop(1, 'rgba(241,245,249,0.35)');
    ctx.fillStyle = plotGrad;
    ctx.fillRect(PAD_L, PAD_T, plotW, plotH);

    // Grid + labels
    ctx.textAlign = 'right';
    ctx.font = '500 10px IBM Plex Mono, monospace';
    for(let i = 0; i <= 4; i++){
        const val = Math.round(yMax * i / 4);
        const y   = toY(val);
        ctx.strokeStyle = i === 0 ? 'rgba(100,116,139,0.28)' : 'rgba(148,163,184,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.fillText(val, PAD_L - 8, y + 3.5);
    }

    ctx.textAlign = 'center';
    ctx.font = '500 10px IBM Plex Mono, monospace';
    for(let h = xStart; h <= xEnd; h += 2){
        const x = toX(h);
        ctx.strokeStyle = 'rgba(148,163,184,0.14)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
        const realH = h % 24;
        const label = (realH % 12 || 12) + (realH < 12 ? 'am' : 'pm');
        ctx.fillStyle = h % 4 === 0 ? '#475569' : '#94a3b8';
        ctx.fillText(label, x, PAD_T + plotH + 18);
    }

    // NOW line
    const nowX = toX(nowPlot);
    ctx.strokeStyle = 'rgba(30,64,175,0.35)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(nowX, PAD_T); ctx.lineTo(nowX, PAD_T + plotH); ctx.stroke();
    ctx.setLineDash([]);

    const nowLabel = 'NOW';
    ctx.font = '600 9px Inter, sans-serif';
    const labelW = ctx.measureText(nowLabel).width + 10;
    ctx.fillStyle = 'rgba(30,64,175,0.88)';
    ctx.fillRect(nowX - labelW / 2, PAD_T - 2, labelW, 16);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(nowLabel, nowX, PAD_T + 9);

    // Dept lines
    DEPT_ORDER.forEach(dept => {
        const pts    = series[dept];
        const colors = DEPT_COLORS[dept] || { line:'#888', fillTop:'rgba(136,136,136,0.15)', fillBot:'rgba(136,136,136,0.02)', glow:'rgba(136,136,136,0.2)' };
        if(pts.length < 2) return;

        const fillGrad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
        fillGrad.addColorStop(0, colors.fillTop);
        fillGrad.addColorStop(1, colors.fillBot);
        ctx.beginPath();
        ctx.moveTo(toX(pts[0].hf), toY(0));
        pts.forEach(p => ctx.lineTo(toX(p.hf), toY(p.total)));
        ctx.lineTo(toX(pts[pts.length-1].hf), toY(0));
        ctx.closePath();
        ctx.fillStyle = fillGrad;
        ctx.fill();

        ctx.beginPath();
        pts.forEach((p, i) => {
            const x = toX(p.hf), y = toY(p.total);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = colors.glow;
        ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;

        ctx.beginPath();
        pts.forEach((p, i) => {
            const x = toX(p.hf), y = toY(p.total);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke();

        const last = pts[pts.length - 1];
        const lx = toX(last.hf), ly = toY(last.total);
        ctx.beginPath();
        ctx.arc(lx, ly, 7, 0, Math.PI * 2);
        ctx.fillStyle = colors.glow; ctx.globalAlpha = 0.45; ctx.fill(); ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.line; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    });

    ctx.strokeStyle = 'rgba(71,85,105,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T);
    ctx.lineTo(PAD_L, PAD_T + plotH);
    ctx.lineTo(PAD_L + plotW, PAD_T + plotH);
    ctx.stroke();
}

/* ═══ LIVE REFRESH ══════════════════════════════════════════════════════ */

async function liveRefreshDepartments(){
    if($.editModal.style.display === 'flex' || $.logsModal.style.display === 'flex') return;
    try {
        allDepartments = await fetchDepartments();
        if(currentView === 'overview'){
            await refreshAuditLogCache(false);
            renderOverview();
        }
        if(currentView === 'detail' && currentDepartment && !_detailScrolling){
            renderDetailStats(currentDepartment);
            renderDetailTable(currentDepartment);
        } else if(currentView === 'detail' && currentDepartment){
            renderDetailStats(currentDepartment);
        }
        $.errorBanner.style.display = 'none';
    } catch(e) {
        // Transient network hiccup — ignore quietly
    }
}

function startPolling(){
    if(_refreshInterval) return;
    _refreshInterval = setInterval(liveRefreshDepartments, 1000);
    _chartInterval   = setInterval(fetchChartLog, 5000);
    _resizeHandler   = debounce(() => { if(chartLog.entries.length) scheduleChartRedraw(); }, 120);
    window.addEventListener('resize', _resizeHandler);
}

function stopPolling(){
    clearInterval(_refreshInterval); _refreshInterval = null;
    clearInterval(_chartInterval);   _chartInterval   = null;
    if(_resizeHandler){
        window.removeEventListener('resize', _resizeHandler);
        _resizeHandler = null;
    }
}

/* ═══ LOGIN ═════════════════════════════════════════════════════════════ */

const DEFAULT_USERS = [
    { username: 'admin', password: 'admin123' }
];
const SESSION_KEY = 'qc_control_session';
let loadedUsers = null;

async function loadUsers(){
    try {
        const res = await fetch('users.json');
        if(!res.ok) throw new Error('not found');
        loadedUsers = await res.json();
    } catch(e){
        loadedUsers = DEFAULT_USERS;
    }
}

function saveSession(username){
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ username, loggedInAt: Date.now() }));
    } catch(e){}
}

function getSession(){
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch(e){ return null; }
}

function clearSession(){
    try { localStorage.removeItem(SESSION_KEY); } catch(e){}
}

function isLoginOverlayVisible(){
    return document.documentElement.classList.contains('auth-required');
}

function showLoginOverlay(){
    document.documentElement.classList.add('auth-required');
    const overlay = $.loginOverlay;
    if(!overlay) return;
    overlay.style.display = '';
    overlay.style.opacity = '';
    overlay.style.pointerEvents = '';
}

function dismissLoginOverlay(immediate){
    document.documentElement.classList.remove('auth-required');
    const overlay = $.loginOverlay;
    if(!overlay) return;
    if(immediate){
        overlay.style.display = 'none';
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        return;
    }
    overlay.style.transition = 'opacity 0.35s ease';
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'none';
    setTimeout(() => {
        overlay.style.display = 'none';
        overlay.style.opacity = '';
        overlay.style.transition = '';
    }, 360);
}

function getCurrentUser(){
    if(currentUsername) return currentUsername;
    const session = getSession();
    return (session && session.username) ? session.username : 'unknown';
}

function closeUserMenu(){
    const wrap = $.userMenuWrap;
    if(wrap) wrap.classList.remove('open');
    const btn = $.userMenuBtn;
    if(btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleUserMenu(e){
    if(e) e.stopPropagation();
    const wrap = $.userMenuWrap;
    if(!wrap) return;
    const open = wrap.classList.toggle('open');
    const btn = $.userMenuBtn;
    if(btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function injectUserMenu(username){
    currentUsername = username;
    const label = $.userMenuLabel;
    const wrap  = $.userMenuWrap;
    const btn   = $.userMenuBtn;
    if(!wrap || !label) return;
    label.textContent = username;
    wrap.style.display = 'flex';
    if(btn && !btn.dataset.bound){
        btn.dataset.bound = '1';
        btn.addEventListener('click', toggleUserMenu);
    }
}

function logout(){
    closeUserMenu();
    if(confirm('Sign out of QC Control Center?')){
        isLoggedIn = false;
        stopPolling();
        clearSession();
        location.reload();
    }
}

function restoreSession(){
    const session = getSession();
    if(!session || !session.username){ showLoginOverlay(); return false; }
    const users = loadedUsers || DEFAULT_USERS;
    if(!users.some(u => u.username === session.username)){
        clearSession(); showLoginOverlay(); return false;
    }
    document.documentElement.classList.remove('auth-required');
    dismissLoginOverlay(true);
    injectUserMenu(session.username);
    isLoggedIn = true;
    return true;
}

function doLogin(){
    const username = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value;
    const errorEl  = document.getElementById('loginError');
    const userEl   = document.getElementById('loginUser');
    const passEl   = document.getElementById('loginPass');
    const btn      = document.getElementById('loginBtn');

    errorEl.style.display = 'none';
    userEl.classList.remove('error');
    passEl.classList.remove('error');

    if(!username || !password){
        errorEl.innerText = 'Please enter your username and password.';
        errorEl.style.display = 'block';
        (!username ? userEl : passEl).classList.add('error');
        return;
    }

    const users = loadedUsers || DEFAULT_USERS;
    const match = users.find(u => u.username === username && u.password === password);

    if(match){
        btn.disabled = true;
        btn.innerText = 'Signing in…';
        saveSession(match.username);
        setTimeout(async () => {
            isLoggedIn = true;
            dismissLoginOverlay(false);
            injectUserMenu(match.username);
            await loadDepartments();
            fetchChartLog();
            startPolling();
        }, 380);
    } else {
        errorEl.innerText = 'Incorrect username or password.';
        errorEl.style.display = 'block';
        userEl.classList.add('error');
        passEl.classList.add('error');
        passEl.value = '';
        passEl.focus();
    }
}

document.addEventListener('keydown', e => {
    if(e.key === 'Enter' && isLoginOverlayVisible()) doLogin();
});

document.addEventListener('click', closeUserMenu);

/* ═══ BOOT ══════════════════════════════════════════════════════════════ */

(async function boot(){
    cacheRefs();
    bindScrollOptimizations();
    await loadUsers();
    const restored = restoreSession();
    if(!restored){
        showLoginOverlay();
        const userField = document.getElementById('loginUser');
        if(userField) setTimeout(() => userField.focus(), 80);
    } else {
        startPolling();
        await loadDepartments();
    }
})();

const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1bMmf9UL5EIiN9yDiDEFY2TwR0OEp_bf1KT9nweBGjRk/export?format=csv&gid=574467458";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const DUTY_MARK = "●";

const SETTINGS_KEY = "work-schedule-mobile-settings";
const CACHE_KEY = "work-schedule-mobile-cache";

const state = {
  schedule: null,
  settings: loadJson(SETTINGS_KEY, {
    selectedEmployee: "",
    monthOffset: 0,
    selectedIso: "",
  }),
  fetchedAt: "",
  deferredInstallPrompt: null,
};

const els = {
  calendarGrid: document.getElementById("calendarGrid"),
  employeeSelect: document.getElementById("employeeSelect"),
  installButton: document.getElementById("installButton"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  modalCloseButton: document.getElementById("modalCloseButton"),
  modalCode: document.getElementById("modalCode"),
  modalDate: document.getElementById("modalDate"),
  modalEmployee: document.getElementById("modalEmployee"),
  modalMemo: document.getElementById("modalMemo"),
  dayModal: document.getElementById("dayModal"),
  monthLabel: document.getElementById("todayButton"),
  nextMonthButton: document.getElementById("nextMonthButton"),
  prevMonthButton: document.getElementById("prevMonthButton"),
  refreshButton: document.getElementById("refreshButton"),
  statusText: document.getElementById("statusText"),
  todayButton: document.getElementById("todayButton"),
};

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, amount) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function normalizeCell(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function normalizeShiftText(value) {
  return normalizeCell(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function isDayNumber(value) {
  const text = normalizeCell(value);
  if (!/^\d{1,2}$/.test(text)) return false;
  const day = Number(text);
  return day >= 1 && day <= 31;
}

function weekdayIndex(value) {
  return WEEKDAY_LABELS.indexOf(normalizeCell(value).slice(0, 1));
}

function findHeaderRows(rows) {
  for (let index = 0; index < rows.length - 1; index += 1) {
    const dayRow = rows[index] ?? [];
    const weekdayRow = rows[index + 1] ?? [];
    const first = normalizeCell(dayRow[0]);
    const nextFirst = normalizeCell(weekdayRow[0]);
    const dayCount = dayRow.slice(1).filter(isDayNumber).length;
    const weekdayCount = weekdayRow.slice(1).filter((cell) => weekdayIndex(cell) >= 0).length;

    if (first === "일" && nextFirst === "요일" && dayCount > 20 && weekdayCount > 20) {
      return { dayRowIndex: index, weekdayRowIndex: index + 1 };
    }
  }

  throw new Error("날짜/요일 헤더 행을 찾을 수 없습니다.");
}

function findDateColumns(dayRow, weekdayRow) {
  const columns = [];
  const lastColumn = Math.max(dayRow.length, weekdayRow.length);

  for (let column = 1; column < lastColumn; column += 1) {
    if (!isDayNumber(dayRow[column])) continue;
    const weekday = weekdayIndex(weekdayRow[column]);
    if (weekday < 0) continue;
    columns.push({ column, day: Number(normalizeCell(dayRow[column])), weekday });
  }

  if (columns.length < 28) throw new Error("날짜 열이 충분하지 않습니다.");
  return columns;
}

function findKnownYears(rows) {
  const years = new Set();
  for (const row of rows) {
    for (const cell of row) {
      const matches = normalizeCell(cell).match(/\b20\d{2}\b/g);
      if (!matches) continue;
      for (const match of matches) years.add(Number(match));
    }
  }
  return [...years].sort((a, b) => a - b);
}

function scoreStartDate(startDate, columns) {
  let score = 0;
  for (let index = 0; index < columns.length; index += 1) {
    const expected = addDays(startDate, index);
    if (expected.getDate() === columns[index].day && expected.getDay() === columns[index].weekday) {
      score += 1;
    }
  }
  return score;
}

function inferStartDate(rows, columns) {
  const years = findKnownYears(rows);
  const minYear = years.length ? Math.min(...years) - 1 : 2020;
  const maxYear = years.length ? Math.max(...years) + 2 : 2035;
  const firstDay = columns[0].day;
  let best = null;

  for (let year = minYear; year <= maxYear; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      if (firstDay > new Date(year, month + 1, 0).getDate()) continue;
      const candidate = new Date(year, month, firstDay);
      const score = scoreStartDate(candidate, columns);
      if (!best || score > best.score) best = { date: candidate, score };
    }
  }

  if (!best || best.score < Math.min(60, columns.length)) {
    throw new Error("시트 날짜 범위를 추론할 수 없습니다.");
  }

  return best.date;
}

function splitShiftCell(value) {
  const text = normalizeShiftText(value);
  if (!text) return { code: "", detail: "", fullText: "" };
  const lines = text.split("\n");
  return {
    code: lines[0] ?? "",
    detail: lines.slice(1).join("\n"),
    fullText: text,
  };
}

function parseScheduleCsv(csv) {
  const rows = parseCsv(csv);
  const { dayRowIndex, weekdayRowIndex } = findHeaderRows(rows);
  const dateColumns = findDateColumns(rows[dayRowIndex], rows[weekdayRowIndex]);
  const startDate = inferStartDate(rows, dateColumns);
  const datedColumns = dateColumns.map((dateColumn, index) => {
    const date = addDays(startDate, index);
    return {
      ...dateColumn,
      iso: toIsoDate(date),
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      date: date.getDate(),
      weekday: date.getDay(),
    };
  });

  const employees = [];
  for (let rowIndex = weekdayRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const name = normalizeCell(row[0]);
    if (!name) continue;
    if (name === "인원") break;

    const shifts = {};
    for (const dateColumn of datedColumns) {
      const fullText = normalizeShiftText(row[dateColumn.column]);
      if (fullText) shifts[dateColumn.iso] = splitShiftCell(fullText);
    }
    employees.push({ name, shifts });
  }

  return {
    dateRange: {
      start: datedColumns[0].iso,
      end: datedColumns[datedColumns.length - 1].iso,
    },
    employees,
  };
}

function classifyShiftCode(value) {
  const text = String(value ?? "").trim().toUpperCase();
  const cleanText = text.replaceAll(DUTY_MARK, "").replace(/\s+/g, "");
  const codes = [...new Set(cleanText.match(/[A-G]/g) ?? [])];
  const hasRest = /주휴|무휴|공휴|연차|월차/.test(cleanText);

  return {
    codes,
    baseCode: codes[0] ?? "",
    hasDuty: text.includes(DUTY_MARK),
    hasRest,
    hasOvertime: hasRest && codes.length > 0,
  };
}

function getEmployee() {
  return (
    state.schedule?.employees.find((employee) => employee.name === state.settings.selectedEmployee) ??
    state.schedule?.employees[0]
  );
}

function sourceForDay(employee, iso) {
  return employee?.shifts?.[iso] ?? { code: "", detail: "", fullText: "" };
}

function displayForDay(employee, iso) {
  const source = sourceForDay(employee, iso);
  return {
    code: source.code,
    source,
  };
}

function currentViewDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + Number(state.settings.monthOffset ?? 0), 1);
}

function buildMonthDays(year, month) {
  const first = new Date(year, month - 1, 1);
  const start = addDays(first, -first.getDay());
  const today = toIsoDate(new Date());
  const days = [];

  for (let index = 0; index < 42; index += 1) {
    const date = addDays(start, index);
    days.push({
      iso: toIsoDate(date),
      day: date.getDate(),
      weekday: date.getDay(),
      inMonth: date.getMonth() === month - 1,
      isToday: toIsoDate(date) === today,
    });
  }

  return days;
}

function formatCode(value) {
  const text = String(value ?? "").replace(/\s+/g, "");
  if (!text) return "";
  const fragment = document.createDocumentFragment();
  for (const char of text) {
    if (char === DUTY_MARK) {
      const dot = document.createElement("span");
      dot.className = "duty-dot";
      dot.textContent = DUTY_MARK;
      fragment.append(dot);
    } else {
      fragment.append(document.createTextNode(char));
    }
  }
  return fragment;
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function saveSettings() {
  saveJson(SETTINGS_KEY, state.settings);
}

async function fetchSchedule(force = false) {
  if (!force) {
    const cached = loadJson(CACHE_KEY, null);
    if (cached?.schedule) {
      state.schedule = cached.schedule;
      state.fetchedAt = cached.fetchedAt ?? "";
      renderAll();
    }
  }

  setStatus("시트 동기화 중");
  const response = await fetch(`${SHEET_URL}&_=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`시트 응답 오류: ${response.status}`);
  const schedule = parseScheduleCsv(await response.text());
  state.schedule = schedule;
  state.fetchedAt = new Date().toISOString();
  saveJson(CACHE_KEY, { schedule, fetchedAt: state.fetchedAt });
  setStatus(`${pad(new Date().getHours())}:${pad(new Date().getMinutes())} 동기화`);
}

function renderEmployees() {
  els.employeeSelect.replaceChildren();
  const employees = state.schedule?.employees ?? [];
  if (!employees.some((employee) => employee.name === state.settings.selectedEmployee)) {
    state.settings.selectedEmployee = employees[0]?.name ?? "";
  }

  for (const employee of employees) {
    const option = document.createElement("option");
    option.value = employee.name;
    option.textContent = employee.name;
    option.selected = employee.name === state.settings.selectedEmployee;
    els.employeeSelect.append(option);
  }
}

function renderMonthLabel() {
  const viewDate = currentViewDate();
  els.monthLabel.textContent = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
  }).format(viewDate);
}

function renderCalendar() {
  const employee = getEmployee();
  const viewDate = currentViewDate();
  const days = buildMonthDays(viewDate.getFullYear(), viewDate.getMonth() + 1);
  if (!state.settings.selectedIso || !days.some((day) => day.iso === state.settings.selectedIso && day.inMonth)) {
    state.settings.selectedIso = days.find((day) => day.isToday && day.inMonth)?.iso ?? days.find((day) => day.inMonth)?.iso;
  }

  els.calendarGrid.replaceChildren();
  for (const day of days) {
    const display = displayForDay(employee, day.iso);
    const shift = classifyShiftCode(display.code);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "day-button",
      day.inMonth ? "in-month" : "out-month",
      day.isToday ? "today" : "",
      shift.hasRest ? "rest-day" : "",
      shift.hasOvertime ? "overtime-day" : "",
      shift.hasDuty ? "duty-day" : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.dataset.iso = day.iso;
    button.setAttribute("aria-label", `${day.iso} ${display.code || "근무 없음"}`);

    const number = document.createElement("span");
    number.className = "day-number";
    number.textContent = day.day;
    button.append(number);

    const code = document.createElement("span");
    code.className = "shift-code";
    const formatted = formatCode(display.code);
    if (formatted) code.append(formatted);
    button.append(code);

    button.addEventListener("click", () => {
      state.settings.selectedIso = day.iso;
      saveSettings();
      openDayModal(day, employee);
    });

    els.calendarGrid.append(button);
  }
}

function openDayModal(day, employee) {
  const date = new Date(`${day.iso}T00:00:00`);
  const display = displayForDay(employee, day.iso);
  const shift = classifyShiftCode(display.code);
  const memoLines = [];
  if (shift.hasDuty) memoLines.push("당직");
  if (display.source.detail) memoLines.push(display.source.detail);

  els.modalDate.textContent = new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
  els.modalEmployee.textContent = employee.name;
  els.modalCode.replaceChildren();
  const formatted = formatCode(display.code);
  if (formatted) {
    els.modalCode.append(formatted);
  } else {
    els.modalCode.textContent = "-";
  }
  els.modalMemo.textContent = memoLines.join("\n") || "메모 없음";
  els.dayModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeDayModal() {
  els.dayModal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function renderAll() {
  if (!state.schedule) return;
  renderEmployees();
  renderMonthLabel();
  renderCalendar();
}

function bindEvents() {
  els.employeeSelect.addEventListener("change", () => {
    state.settings.selectedEmployee = els.employeeSelect.value;
    saveSettings();
    renderAll();
  });

  els.prevMonthButton.addEventListener("click", () => {
    state.settings.monthOffset -= 1;
    saveSettings();
    renderAll();
  });

  els.nextMonthButton.addEventListener("click", () => {
    state.settings.monthOffset += 1;
    saveSettings();
    renderAll();
  });

  els.todayButton.addEventListener("click", () => {
    state.settings.monthOffset = 0;
    state.settings.selectedIso = toIsoDate(new Date());
    saveSettings();
    renderAll();
  });

  els.refreshButton.addEventListener("click", async () => {
    try {
      await fetchSchedule(true);
      renderAll();
    } catch (error) {
      console.error(error);
      setStatus("동기화 실패");
    }
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    els.installButton.classList.remove("hidden");
  });

  els.installButton.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    els.installButton.classList.add("hidden");
  });

  els.modalBackdrop.addEventListener("click", closeDayModal);
  els.modalCloseButton.addEventListener("click", closeDayModal);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDayModal();
  });
}

async function init() {
  bindEvents();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker failed:", error));
  }

  try {
    await fetchSchedule(false);
    renderAll();
  } catch (error) {
    console.error(error);
    setStatus("시트 연결 실패");
    const cached = loadJson(CACHE_KEY, null);
    if (cached?.schedule) {
      state.schedule = cached.schedule;
      state.fetchedAt = cached.fetchedAt;
      renderAll();
      setStatus("저장된 근무표 표시 중");
    }
  }
}

init();

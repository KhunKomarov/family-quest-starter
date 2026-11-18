(() => {
  "use strict";

  const root = document.getElementById("family-tv");
  const demoGuide = document.querySelector("[data-demo-guide]");
  if (demoGuide) demoGuide.hidden = new URLSearchParams(location.search).get("demo") !== "1";
  const get = selector => root.querySelector(selector);
  const all = selector => Array.from(root.querySelectorAll(selector));
  const text = (selector, value) => { get(selector).textContent = value; };
  const attr = (node, key, on) => on ? node.setAttribute(key, "") : node.removeAttribute(key);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const replace = (node, children) => {
    node.textContent = "";
    children.forEach(child => node.appendChild(child));
  };
  const element = (tag, className, label) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  };

  const calendar = get("[data-calendar]");
  const profile = get("[data-profile-screen]");
  const profileList = get('.cal-profiles');
  const profileTemplate = profileList.querySelector('[data-child]').cloneNode(true);
  profileList.textContent = '';
  window.FamilyRules.children.forEach((child, index) => {
    const button = profileTemplate.cloneNode(true);
    button.dataset.child = index;
    button.className = child.color;
    button.querySelector('img').src = 'avatar-' + (index + 1) + '.png';
    profileList.appendChild(button);
  });
  root.style.setProperty('--child-count', window.FamilyRules.children.length);
  const profiles = all("[data-child]");
  const tabs = all("[role=tab]");
  const panels = all("[role=tabpanel]");
  const lists = panels.map(panel => panel.querySelector(".quest-list"));
  const back = get("[data-back]");
  const advance = get("[data-advance]");
  const weekButtons = all("[data-week-nav]");
  const report = get("#family-morning");
  const reportButton = get("[data-morning-button]");
  const cutoff = get("[data-cutoff]");
  const demoTime = get("[data-demo-time]");
  const demo = !window.FamilyQuestStore && new URLSearchParams(location.search).get("demo") === "1";
  const store = window.FamilyQuestStore;
  const storageKey = "family-quest-starter-v1";
  const { ordinary, minuteLimit, morningCutoff, weekdayShort, weekdayLong,
    morningTasks, children, sampleStart, timeNow, realDay, date, weekday, monday, dateText,
    blank, menuFor, videoRate, offer, afternoonTaskRate, chartHeight, dayColumn, longGoalStatus, morningCutoffFor, morningTimeText,
    longGoalCells, longGoalTodayText, entertainmentCutoff, createStats } = window.FamilyRules;
  profiles.forEach((button, index) => {
    button.querySelector("[data-profile-name]").textContent = children[index].name;
  });
  const deadline = () => cutoff.value || morningCutoff;
  const setDeadline = value => { cutoff.value = value; };
  const currentTime = () => demo ? demoTime.value || "06:50" : timeNow().toISOString().slice(11, 16);
  const editable = () => currentTime() >= "06:00" && currentTime() < "23:00";
  const prechecked = ids => {
    const entry = blank();
    ids.forEach(id => { entry.base[id] = "06:40"; entry.order.push("base:" + id); });
    return entry;
  };
  const today = demo ? sampleStart + 2 : realDay();
  const state = { today, first: demo ? sampleStart : today, records: {}, dailyTasks: [], active: null, tab: 0 };
  const eveningClosed = day => Boolean(entertainmentCutoff(day) && currentTime() >= entertainmentCutoff(day));
  if (demo) {
    const allMorning = morningTasks.map(task => task[0]);
    state.records[today] = children.map((_, index) => prechecked(allMorning.slice(0, [4, 5, 3][index % 3])));
    const goal = window.FamilyConfig.goal;
    state.longGoal = {
      ...goal, start: sampleStart, skipSince: goal.allowOneSkip ? sampleStart : Infinity,
      carry: children.map(() => ({ streak: 0, earned: false }))
    };
    state.dailyTasks = [{ id: "demo-water-plants", title: "Полить цветы", done: [1] }];
  }
  const { getDay, info, longGoalProgress, weekStatus, weekTotal, weekValues, weekend, cache } = createStats(state, deadline, demo);
  let view;
  let catalogKey;
  let walletBalances;
  let selectedWeek = null;
  let calendarHistory = new Map();
  let lastEditable = editable();
  let lastBeforeCutoff = currentTime() < morningCutoffFor(state.today, deadline());
  let lastEveningClosed = eveningClosed(state.today);
  const journal = window.createFamilyJournal(window.FamilyQuestSync, applyJournalSnapshot, save, showJournalStatus);
  attr(root, "data-car", journal.car);

  function showJournalStatus(message) {
    all("[data-sync-status]").forEach(node => {
      node.hidden = false;
      node.textContent = message;
    });
  }

  function applyJournalSnapshot(snapshot, projected) {
    if (snapshot.familyConfig) Object.assign(window.FamilyConfig, snapshot.familyConfig);
    state.goalCells = projected.cells;
    state.goalAdjustments = snapshot.adjustments || [];
    state.periodGoals = snapshot.periodGoals || [];
    for (let day = snapshot.start; day <= snapshot.today; day++) {
      if (projected.records[day]) state.records[day] = projected.records[day];
      else delete state.records[day];
    }
    state.first = Math.min(state.first, snapshot.first);
    state.syncedStart = snapshot.start;
    state.startTargets = snapshot.startTargets;
    state.recoverySince = snapshot.recoverySince;
    state.startRecovery = snapshot.startRecovery;
    calendarHistory = new Map((snapshot.calendarHistory || []).map(([day, rows]) =>
      [day, rows.map(([score, target, remarks, parentPoints, met, restored]) =>
        ({ score, target, remarks, parentPoints, met, restored }))]));
    state.longGoal = snapshot.longGoal;
    const nextCatalogKey = JSON.stringify([snapshot.catalog, snapshot.afternoonRateCutover]);
    const changedCatalog = nextCatalogKey !== catalogKey;
    catalogKey = nextCatalogKey;
    state.catalog = snapshot.catalog;
    state.afternoonRateCutover = snapshot.afternoonRateCutover;
    walletBalances = snapshot.wallets;
    setDeadline(snapshot.cutoff);
    ensureDay();
    state.dailyTasks = projected.daily.filter(task => task.day === state.today);
    cache.clear();
    if (state.active === null) paintCalendar();
    else {
      if (changedCatalog) {
        const refocus = lists.some(list => list.contains(document.activeElement));
        buildProfileTasks(state.active);
        if (refocus) focus(tabs[state.tab]);
      }
      paintProfile();
    }
  }

  function locked(task) {
    return journal.locked(state.today, state.active, task);
  }

  const chartRoot = get("[data-cal-bars]");
  const chartDates = get("[data-cal-dates]");
  const chart = weekdayShort.map((day, index) => {
    const group = element("div", "cal-day");
    const label = element("div", "cal-date");
    attr(group, "data-weekend", index >= 5);
    attr(label, "data-weekend", index >= 5);
    chartRoot.appendChild(group);
    chartDates.appendChild(label);
    const columns = children.map(child => {
      const column = element("div", "cal-column " + child.color);
      column.setAttribute("role", "img");
      const bar = element("div", "cal-bar");
      const stack = element("div", "cal-stack");
      const earned = element("div", "cal-earned");
      const red = element("div", "cal-adjustment cal-red");
      const praise = element("div", "cal-adjustment cal-praise");
      const count = element("output");
      const goal = element("span", "cal-target");
      stack.append(praise, earned, red);
      bar.append(stack, count);
      column.append(bar, goal);
      group.appendChild(column);
      return { column, bar, earned, red, praise, count, goal };
    });
    return { group, label, columns };
  });
  const week = get("[data-cal-week]");
  const heading = element("div", "cal-week-head");
  ["", ...weekdayShort, "Будни"].forEach(label => heading.appendChild(element("span", "", label)));
  week.appendChild(heading);
  const weekRows = children.map(child => {
    const row = element("div", "cal-week-row " + child.color);
    const marks = weekdayShort.map(() => element("span", "cal-week-mark"));
    const total = element("strong", "cal-week-total");
    row.append(element("span", "cal-week-name", child.name), ...marks, total);
    week.appendChild(row);
    return { marks, total };
  });

  function longGoalTrack(progress, goal) {
    const track = element("div", "cal-long-goal-steps");
    track.setAttribute("aria-hidden", "true");
    for (const { phase, carry, fill } of longGoalCells(progress, goal)) {
      const mark = element("i");
      mark.dataset.phase = phase;
      mark.style.setProperty("--carry", carry + "%");
      mark.style.setProperty("--fill", fill + "%");
      track.appendChild(mark);
    }
    return track;
  }

  function paintLongGoal(first, last) {
    window.FamilyPeriodGoals.render(get('[data-calendar-goals]'), personalGoals(), children.map(child => child.name));
    const goal = state.longGoal;
    const section = get("[data-long-goal-section]");
    const line = get("[data-long-goal-line]");
    section.hidden = !goal || goal.start > state.today;
    line.hidden = section.hidden || goal.start > last;
    if (section.hidden) return;
    line.style.setProperty("--long-goal-threshold", chartHeight(goal.points) + "%");
    text("#family-long-goal-heading", goal.title || "Накопительная цель");
    line.firstElementChild.textContent = "Цель · " + goal.points;
    const series = state.today >= goal.skipSince ? ' дней · допустимо пропусков: ' + (goal.allowedSkips === undefined ? 1 : goal.allowedSkips) : " дней подряд";
    text("[data-long-goal-rule]", (first === monday(state.today) ? "" : "Прогресс на сегодня · ")
      + goal.points + " очков в день · " + goal.days + series + " → " + (goal.reward || "приз семьи") + " · фиолетовый — перенос");
    replace(get("[data-long-goal-rows]"), children.map(({name, color}, index) => {
      const progress = longGoalProgress(index);
      const row = element("div", "cal-long-goal-child " + color);
      row.append(element("strong", "", name), element("span", "", longGoalStatus(progress, goal)), longGoalTrack(progress, goal));
      if (!progress.earned) row.append(element("small", "cal-long-goal-today", longGoalTodayText(progress, goal)));
      return row;
    }));
  }

  function personalGoals() {
    const now = demo ? state.today * 86400000 - window.FamilyConfig.utcOffsetMinutes * 60000 +
      Number(currentTime().slice(0,2)) * 3600000 + Number(currentTime().slice(3)) * 60000 : Date.now();
    if (state.goalCells) return window.FamilyPeriodGoals.fromJournal(window.FamilyConfig, now, state.first,
      state.goalCells, state.goalAdjustments, state.catalog, state.periodGoals);
    return window.FamilyPeriodGoals.evaluate(window.FamilyConfig, now, state.first, (day, child) => {
      const row = getDay(day)[child], entry = row.entry;
      return {score: row.score, morningMet: entry ? row.morningMet : row.score >= 5,
        extra: entry ? entry.rewards.length + entry.videos + Object.values(entry.repeatables || {}).reduce((a,b)=>a+b,0) : 0};
    });
  }

  function firstCalendarDay() {
    if (!state.syncedStart) return state.first;
    return calendarHistory.size ? calendarHistory.keys().next().value : Math.max(state.first, state.syncedStart);
  }

  function calendarDay(day) {
    if (state.syncedStart && day < state.syncedStart) return calendarHistory.get(day);
    return getDay(day);
  }

  function paintCalendar() {
    const current = monday(state.today);
    const earliest = monday(firstCalendarDay());
    if (selectedWeek !== null) selectedWeek = Math.max(earliest, Math.min(current, selectedWeek));
    const first = selectedWeek === null ? current : selectedWeek;
    const last = first + 6;
    const year = date(last).getUTCFullYear();
    const startYear = date(first).getUTCFullYear();
    const span = date(first).getUTCMonth() === date(last).getUTCMonth()
      ? date(first).getUTCDate() + "–" + dateText(last)
      : dateText(first) + (startYear === year ? "" : " " + startYear) + " — " + dateText(last);
    text("[data-week-caption]", "◆ " + (demo ? "ПРОБНАЯ НЕДЕЛЯ" : "СЕМЕЙНЫЙ КАЛЕНДАРЬ"));
    text("[data-week-range]", span + " " + year);
    weekButtons[0].disabled = first <= earliest;
    weekButtons[1].disabled = weekButtons[2].disabled = first >= current;
    const statusAt = (day, index) => weekStatus(day, index, Math.min(last, state.today), calendarDay);
    text("[data-day-caption]", "Сегодня · " + weekdayLong[weekday(state.today)] + ", " + dateText(state.today));
    advance.hidden = !demo || state.today >= sampleStart + 3;
    chart.forEach(({ group, label, columns }, offset) => {
      const day = first + offset;
      const row = calendarDay(day);
      label.textContent = weekdayShort[offset] + " " + date(day).getUTCDate();
      attr(group, "data-today", day === state.today);
      attr(label, "data-today", day === state.today);
      columns.forEach(({ column, bar, earned, red, praise, count, goal }, index) => {
        const data = row && row[index];
        const sizes = dayColumn(data, chartHeight, 2.5);
        count.textContent = data ? data.score : "";
        attr(bar, "data-empty", !data || (!data.score && !data.remarks));
        bar.style.setProperty("--height", sizes.height + "%");
        earned.style.height = sizes.earned + "%";
        red.style.height = sizes.remarks + "%";
        praise.style.height = sizes.praise + "%";
        goal.hidden = !data || data.target === ordinary;
        if (data) goal.style.setProperty("--target", chartHeight(data.target) + "%");
        const restored = statusAt(day, index) === "restored";
        const labelText = children[index].name + ", " + weekdayLong[offset] + (data ? ": " + data.score + " очков, норма " + data.target + ", замечаний " + data.remarks + ", похвала +" + data.parentPoints + (restored ? ", восстановлено" : "") : ": без отметок");
        column.setAttribute("aria-label", labelText);
        column.title = labelText;
      });
    });
    weekRows.forEach(({ marks, total }, index) => {
      const data = info(index);
      profiles[index].querySelector("[data-child-score]").textContent = data.score + " / " + data.target + " норма" + (data.parentPoints ? " · +" + data.parentPoints : "");
      let weekdays = 0;
      marks.forEach((mark, offset) => {
        const day = first + offset;
        const status = statusAt(day, index);
        if (offset < 5 && (status === "done" || status === "restored")) weekdays++;
        mark.dataset.status = status;
        mark.textContent = { future: "–", done: "✓", restored: "↺✓", today: "•", missed: "×" }[status];
        mark.title = { future: "Без отметок", done: "Норма выполнена", restored: "Восстановлено ✓", today: "В процессе", missed: "Норма пропущена" }[status];
        mark.setAttribute("aria-label", weekdayLong[offset] + ": " + mark.title);
      });
      total.textContent = weekdays + " / 5";
    });
    for (const [key, offset] of [["saturday", 5], ["sunday", 6]]) {
      const reward = get("[data-weekend-" + key + "]");
      const names = first === current && weekday(state.today) === offset
        ? children.filter((_, index) => weekend(index)[key]).map(child => child.name) : [];
      reward.hidden = !names.length;
      reward.textContent = names.length ? "Час доступен · " + names.join(", ") : "";
    }
    paintLongGoal(first, last);
    paintMorning();
  }

  function paintMorning() {
    replace(get("[data-morning-rows]"), children.map((child, index) => {
      const data = info(index);
      const row = element("li", child.color);
      row.append(element("strong", "", child.name),
        document.createTextNode(data.onTime + " / " + data.morningRequired.size + " до " + data.morningCutoff
          + " · " + morningTimeText(data)));
      return row;
    }));
  }

  function makeTask(id, title, kind) {
    const button = element("button", "quest-task");
    button.type = "button";
    button.dataset[kind] = id;
    const repeated = kind === 'video' || kind === 'repeat';
    if (!repeated) button.setAttribute("aria-pressed", "false");
    const box = element("span", repeated ? "quest-box quest-add" : "quest-box", repeated ? "+" : "");
    box.setAttribute("aria-hidden", "true");
    const name = element("span", "quest-task-name", title);
    const value = element("span", "quest-value");
    const picture = element("span", "quest-task-picture");
    window.familyTaskIcon(id, title, picture);
    picture.setAttribute("aria-hidden", "true");
    button.append(box, name, value, picture);
    return { button, name, value };
  }

  function focus(node) {
    if (!node || node.disabled || node.hidden) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function buildProfileTasks(index) {
    const menu = menuFor(index, state.today, state.catalog);
    const morning = menu.morning.map(([id, title]) => makeTask(id, title, "base"));
    const afternoon = menu.afternoon.map(([id, title]) => {
      const task = makeTask(id, title, "base");
      const rate = afternoonTaskRate(state.today, id, title, menu.afternoonMinutes, state.afternoonRateCutover);
      task.name.append(element("small", "quest-task-rate", "Ставка: " + rate + " мин / " + rate + " жет."));
      return { ...task, rate };
    });
    const rewards = menu.rewards.map(([id, title, rate]) => ({ ...makeTask(id, title, "bonus"), rate }));
    const video = makeTask("video", menu.video.title, "video");
    const videoCount = element("small", "quest-detail");
    video.name.appendChild(videoCount);
    const repeatables = (menu.repeatables || []).map(([id, title, rate]) => {
      const task = { ...makeTask(id, title, 'repeat'), id, rate };
      task.count = element('small', 'quest-detail');
      task.name.appendChild(task.count);
      return task;
    });
    replace(lists[0], morning.map(task => task.button));
    replace(lists[1], afternoon.map(task => task.button));
    replace(lists[2], rewards.map(task => task.button).concat(video.button, repeatables.map(task => task.button)));
    view = { menu, morning, afternoon, rewards, video, videoCount, repeatables, daily: [], dailyKey: null };
  }

  function openProfile(index) {
    state.active = index;
    state.tab = 0;
    const child = children[index];
    profile.className = child.color;
    const image = get("[data-active-portrait]");
    image.src = profiles[index].querySelector("img").src;
    image.alt = "Фото: " + child.name;
    text("[data-active-name]", child.name);
    text("[data-active-date]", "Сегодня · " + dateText(state.today));
    buildProfileTasks(index);
    calendar.hidden = true;
    profile.hidden = false;
    window.scrollTo(0, 0);
    paintProfile();
    const first = view.morning.find(task => !taskIsReadOnly(task.button));
    focus(first ? first.button : tabs[0]);
  }

  function paintProfile() {
    const index = state.active;
    const data = info(index);
    const { entry, morningRequired, morningMet, morningDone, morningMinutes, score, target, met, credit,
      recoveryLeft, restored, rewardsOpen } = data;
    const { minutes, bats, awards } = credit;
    const open = editable();
    const left = Math.max(0, target - score);
    const toward = Math.min(score, target);
    const morningTotal = morningRequired.size;
    const stats = weekValues(index);
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === state.tab));
      panels[i].hidden = i !== state.tab;
    });
    text("[data-base-tab]", morningDone + " / " + morningTotal);
    text("[data-day-tab]", morningMet ? score + " / " + target : "После утра");
    text("[data-bonus-tab]", rewardsOpen ? "Начисляются" : met ? "После восстановления" : "После нормы");
    attr(get("[data-bonus-tab]"), "data-open", rewardsOpen);
    const dailyDone = state.dailyTasks.filter(task => task.done.includes(index)).length;
    text("[data-daily-tab]", dailyDone + " / " + state.dailyTasks.length);
    get("[data-daily-empty]").hidden = state.dailyTasks.length > 0;
    const dailyKey = JSON.stringify(state.dailyTasks.map(task => [task.id, task.title]));
    if (dailyKey !== view.dailyKey) {
      view.dailyKey = dailyKey;
      view.daily = state.dailyTasks.map(({ id, title }) => makeTask(id, title, "dailyTask"));
      const refocus = lists[3].contains(document.activeElement);
      replace(lists[3], view.daily.map(task => task.button));
      if (refocus) focus(tabs[3]);
    }
    view.daily.forEach(({ button, value }, task) => {
      paintTask(button, value, "daily:" + state.dailyTasks[task].id, state.dailyTasks[task].done.includes(index), "");
    });
    const morningGate = get("[data-day-gate]");
    morningGate.hidden = morningMet;
    morningGate.textContent = "Дела можно отметить сейчас. Очки появятся после всех " + morningTotal + " утренних дел.";
    const gate = get("[data-gate-message]");
    gate.hidden = rewardsOpen;
    gate.textContent = met ? "Отметки зачтутся после восстановления пропусков."
      : "Дела можно отметить сейчас. Минуты и монеты начислятся после дневной нормы.";
    get("[data-hours-message]").hidden = open;
    view.morning.forEach(({button, value}) => {
      const id = button.dataset.base;
      const mark = entry.base[id];
      const onTimeMark = (mark || currentTime()) < data.morningCutoff;
      const rate = onTimeMark ? "+3 мин утром" : "+1 очко";
      const label = morningRequired.has(id) ? (onTimeMark ? rate : "К утренней норме") : "Доп. · " + rate;
      paintTask(button, value, id, Boolean(mark), label);
    });
    view.afternoon.forEach(({button, value, rate}) => {
      const id = button.dataset.base;
      const checked = own(entry.base, id);
      const label = checked && !morningMet ? "Зачтётся после " + morningTotal + " утренних дел"
        : awards.get("base:" + id) || (!checked && met ? recoveryLeft ? "На восстановление" : offer(rate, minutes) : "");
      paintTask(button, value, id, checked, label);
    });
    view.rewards.forEach(({button, value, rate}) => {
      const id = button.dataset.bonus;
      const checked = entry.rewards.includes(id);
      const task = "bonus:" + id;
      const label = checked && !rewardsOpen ? (met ? "После восстановления" : "После дневной нормы") : awards.get(task) || offer(rate, minutes);
      paintTask(button, value, task, checked, label);
    });
    const waitingVideos = rewardsOpen ? credit.pendingVideos : entry.videos;
    view.video.button.setAttribute("aria-disabled", String(!open));
    view.video.value.textContent = offer(videoRate(view.menu), minutes);
    view.videoCount.textContent = " · за неделю: " + stats.videos
      + (waitingVideos ? (met ? " · после восстановления: " : " · после дневной нормы: ") + waitingVideos : "");
    view.repeatables.forEach(task => {
      task.button.setAttribute('aria-disabled', String(!open));
      task.value.textContent = offer(task.rate, minutes);
      task.count.textContent = ' · сегодня: ' + (entry.repeatables[task.id] || 0) +
        (!rewardsOpen ? (met ? ' · после восстановления' : ' · после дневной нормы') : '');
    });
    get("[data-norm-number]").firstChild.nodeValue = score + " ";
    get("[data-norm-number] small").textContent = "/ " + target + " очков";
    const track = get("[data-norm-track]");
    const beforeRemarks = Math.min(target, data.done + entry.parentPoints);
    const remarkLabel = entry.remarks ? "−" + entry.remarks + (entry.remarks === 1 ? " за замечание" : " за замечания") : "";
    if (track.children.length !== target) replace(track, Array.from({length: target}, () => element("span")));
    track.style.gridTemplateColumns = "repeat(" + target + ", minmax(0,1fr))";
    track.setAttribute("aria-valuemax", target);
    track.setAttribute("aria-valuenow", toward);
    track.setAttribute("aria-valuetext", score + " из " + target + (remarkLabel ? ", " + remarkLabel : ""));
    Array.from(track.children).forEach((part, i) => {
      part.className = i < toward ? "filled" : i < beforeRemarks ? "remark" : "";
    });
    const remarks = get("[data-norm-remarks]");
    remarks.hidden = !remarkLabel;
    remarks.textContent = remarkLabel;
    attr(get(".quest-norm"), "data-complete", met);
    text("[data-norm-next]", !morningMet ? "Для зачёта нужен утренний минимум"
      : met ? "Норма выполнена" + (score > target ? " · +" + (score - target) + " сверх нормы" : "")
        : "До дневной нормы: " + left);
    const recovery = get("[data-recovery]");
    recovery.hidden = !recoveryLeft && !restored.length;
    recovery.textContent = [restored.length ? "Восстановлено ✓ " + restored.map(dateText).join(", ") : "",
      recoveryLeft ? "До восстановления · " + recoveryLeft + " очк." : ""].filter(Boolean).join(" · ");
    const raised = get("[data-raised]");
    raised.hidden = false;
    raised.textContent = "Утренний телефон: " + (morningMinutes ? "заработано " + morningTimeText(data)
      : morningTotal * 3 + " мин за " + morningTotal + " обязательных дел до " + data.morningCutoff)
      + (target > ordinary ? " · дневная норма +" + (target - ordinary) : "") + (entry.parentPoints ? " · от родителей +" + entry.parentPoints : "");
    get("[data-minutes-number]").firstChild.nodeValue = minutes + " ";
    const minutesTrack = get("[data-minute-track]");
    minutesTrack.setAttribute("aria-valuenow", minutes);
    minutesTrack.firstElementChild.style.width = minutes / minuteLimit * 100 + "%";
    text("[data-minutes-next]", !met ? "Откроются после дневной нормы" : recoveryLeft ? "Откроются после восстановления" : minutes === minuteLimit ? "Дневной лимит набран" : "До лимита осталось " + (minuteLimit - minutes) + " мин");
    const cutoff = entertainmentCutoff(state.today);
    const entertainment = get("[data-entertainment-cutoff]");
    entertainment.hidden = !cutoff;
    entertainment.textContent = cutoff ? (eveningClosed(state.today) ? "Выдача минут закрыта с " : "Выдача минут до ") + cutoff : "";
    const balance = journal.enabled ? walletBalances && walletBalances[index]
      : Object.keys(state.records).reduce((total, day) => {
        const row = getDay(Number(day));
        return total + (row ? row[index].credit.bats : 0);
      }, 0);
    text("[data-wallet]", Number.isSafeInteger(balance) ? balance + " жет." : "—");
    text("[data-cash-earned]", "Сегодня " + bats + " жет. · за неделю " + stats.bats + " жет.");
    text("[data-cash-next]", minutes === minuteLimit ? "Теперь цена дела начисляется в монетах" : "После 30 минут цена дела начисляется в монетах");
    text("[data-week]", weekTotal(index) + " из 5");
    const goal = state.longGoal;
    const progress = longGoalProgress(index);
    const goalLabel = get("[data-quest-long-goal]");
    goalLabel.hidden = !progress;
    if (progress) {
      const summary = (goal.title || "Накопительная цель") + " · " + longGoalStatus(progress, goal)
        + (progress.earned ? "" : " · " + longGoalTodayText(progress, goal));
      replace(goalLabel, [element("div", "", summary), longGoalTrack(progress, goal)]);
    }
    window.FamilyPeriodGoals.render(get('[data-profile-goals]'), personalGoals().filter(goal => goal.child === index), children.map(child => child.name));
    const bonus = weekend(index);
    const available = weekday(state.today) === 5 ? bonus.saturday : bonus.sunday;
    const weekendLabel = get("[data-weekend-label]");
    weekendLabel.textContent = available ? "Сегодня доступен 1 час гаджетов" : "5 из 5 → 1 час гаджетов в субботу";
    text("[data-remarks-count]", entry.remarks);
    text("[data-praise-count]", data.parentPoints);
  }

  function taskIsReadOnly(button) {
    return button.getAttribute("aria-disabled") === "true";
  }

  function paintTask(button, value, task, checked, label) {
    const reviewed = locked(task);
    // Keep read-only rows reachable by the remote, including the last row of a list.
    button.setAttribute("aria-disabled", String(!editable() || reviewed || checked));
    button.setAttribute("aria-pressed", String(checked));
    value.textContent = reviewed ? "Снято родителями" : label;
    value.hidden = !value.textContent;
  }

  function showCalendar() {
    const index = state.active;
    if (index === null) return false;
    state.active = null;
    view = null;
    profile.hidden = true;
    calendar.hidden = false;
    window.scrollTo(0, 0);
    chartRoot.getBoundingClientRect();
    paintCalendar();
    const data = info(index);
    text("[data-calendar-announcement]", children[index].name + " сегодня: " + data.score + " очков, " + weekTotal(index) + " из 5 будней с нормой.");
    focus(profiles[index]);
    return true;
  }

  function save() {
    if (demo) return true;
    const snapshot = { version: 1, first: state.first, today: state.today, records: state.records, cutoff: cutoff.value,
      dailyTasks: state.dailyTasks };
    try {
      snapshot.sync = journal.snapshot();
      const payload = JSON.stringify(snapshot);
      if (store) return store.write(payload);
      localStorage.setItem(storageKey, payload);
      return true;
    } catch (error) {
      console.error("Сохранение журнала", error);
      return false;
    }
  }

  function restore(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Number.isInteger(snapshot.first) || !snapshot.records
        || snapshot.first > state.today || snapshot.first < state.today - 36525) return;
    journal.restore(snapshot.sync);
    const savedJournal = journal.snapshot();
    if (savedJournal && savedJournal.canonical) state.catalog = savedJournal.canonical.catalog;
    state.first = snapshot.first;
    state.dailyTasks = [];
    if (snapshot.today === state.today && Array.isArray(snapshot.dailyTasks)) {
      state.dailyTasks = snapshot.dailyTasks.filter(task => task && typeof task.title === "string" && task.title.trim()).map((task, i) => ({
        id: typeof task.id === "string" ? task.id : String(i), title: task.title,
        done: children.map((_, child) => child).filter(child => Array.isArray(task.done) && task.done.includes(child))
      }));
    }
    for (const key of Object.keys(snapshot.records)) {
      const day = Number(key);
      const row = snapshot.records[key];
      if (!Number.isInteger(day) || day < state.first || day > state.today + (journal.enabled ? 1 : 0)
          || !Array.isArray(row) || row.length !== children.length) continue;
      state.records[day] = children.map((_, index) => {
        const raw = row[index] || {};
        const entry = blank();
        const menu = menuFor(index, day, state.catalog);
        const baseIds = new Set(menu.morning.concat(menu.afternoon).map(task => task[0]));
        Object.entries(raw.base || {}).forEach(([id, time]) => {
          if (baseIds.has(id) && /^\d\d:\d\d$/.test(time)) entry.base[id] = time;
        });
        const rewardIds = new Set(menu.rewards.map(([id]) => id));
        entry.rewards = Array.from(new Set((Array.isArray(raw.rewards) ? raw.rewards : []).filter(id => rewardIds.has(id))));
        const savedOrder = Array.isArray(raw.order) ? raw.order : [];
        const repeatCounts = {};
        (menu.repeatables || []).forEach(([id]) => {
          const recorded = savedOrder.filter(mark => mark === 'repeat:' + id).length;
          const count = raw.repeatables && raw.repeatables[id];
          entry.repeatables[id] = Number.isSafeInteger(count) ? Math.max(0, Math.min(count, Math.max(5, recorded))) : recorded;
          repeatCounts[id] = entry.repeatables[id];
        });
        const storedVideos = savedOrder.filter(mark => mark === "video").length;
        entry.videos = Number.isSafeInteger(raw.videos) ? Math.max(0, Math.min(raw.videos, Math.max(5, storedVideos))) : storedVideos;
        entry.remarks = Number.isSafeInteger(raw.remarks) ? Math.max(0, raw.remarks) : 0;
        entry.parentPoints = Number.isSafeInteger(raw.parentPoints) ? Math.max(0, raw.parentPoints) : 0;
        const remaining = new Set(Object.keys(entry.base).map(id => "base:" + id).concat(entry.rewards.map(id => "bonus:" + id)));
        let videos = entry.videos;
        let parents = entry.parentPoints;
        entry.order = savedOrder.filter(mark => {
          if (typeof mark === 'string' && mark.startsWith('repeat:')) {
            const id = mark.slice(7);
            if (!repeatCounts[id]) return false;
            repeatCounts[id]--;
            return true;
          }
          if (mark === "parent") {
            if (!parents) return false;
            parents--;
            return true;
          }
          if (mark !== "video") return remaining.delete(mark);
          if (!videos) return false;
          videos--;
          return true;
        }).concat(Array.from(remaining), Array(videos).fill("video"), Object.entries(repeatCounts).flatMap(([id, count]) => Array(count).fill('repeat:' + id)));
        return entry;
      });
    }
    if (/^\d\d:\d\d$/.test(snapshot.cutoff)) setDeadline(snapshot.cutoff);
    cache.clear();
  }

  function ensureDay() {
    if (!state.records[state.today]) state.records[state.today] = children.map(blank);
  }

  function refresh() {
    const day = demo ? state.today : realDay();
    const canEdit = editable();
    const beforeCutoff = currentTime() < morningCutoffFor(day, deadline());
    const closed = eveningClosed(day);
    if (day !== state.today) {
      state.today = day;
      state.first = Math.min(state.first, day);
      state.dailyTasks = [];
      ensureDay();
      if (state.active !== null) showCalendar();
      else paintCalendar();
      save();
    } else if ((lastEditable !== canEdit || lastBeforeCutoff !== beforeCutoff || lastEveningClosed !== closed) && state.active !== null) {
      paintProfile();
    }
    lastEditable = canEdit;
    lastBeforeCutoff = beforeCutoff;
    lastEveningClosed = closed;
  }

  function changed() {
    cache.delete(state.today);
    paintProfile();
    save();
    journal.send();
  }

  root.addEventListener("click", event => {
    refresh();
    const button = event.target.closest("button");
    if (!button || button.disabled || taskIsReadOnly(button)) return;
    if (button.hasAttribute("data-child")) { openProfile(Number(button.dataset.child)); return; }
    if (button === back) { showCalendar(); return; }
    if (weekButtons.includes(button)) {
      const step = Number(button.dataset.weekNav);
      const current = monday(state.today);
      const destination = (selectedWeek === null ? current : selectedWeek) + step * 7;
      selectedWeek = !step || destination >= current ? null : destination;
      paintCalendar();
      if (button.disabled) focus(weekButtons.find(control => !control.disabled) || profiles[0]);
      return;
    }
    if (button === advance && demo && state.today < sampleStart + 3) {
      state.today++;
      state.dailyTasks = [];
      ensureDay();
      paintCalendar();
      focus(profiles[0]);
      save();
      return;
    }
    if (button === reportButton) {
      report.hidden = !report.hidden;
      reportButton.setAttribute("aria-expanded", String(!report.hidden));
      if (!report.hidden) report.scrollIntoView({ block: "nearest" });
      return;
    }
    if (state.active === null) return;
    if (tabs.includes(button)) { state.tab = tabs.indexOf(button); paintProfile(); return; }
    if (!editable()) return;
    const entry = info(state.active).entry;
    let task;
    if (button.hasAttribute("data-daily-task")) {
      const item = state.dailyTasks.find(item => item.id === button.dataset.dailyTask);
      if (!item || item.done.includes(state.active)) return;
      task = "daily:" + item.id;
      item.done.push(state.active);
    } else if (button.dataset.base) {
      task = button.dataset.base;
      if (own(entry.base, task)) return;
      entry.base[task] = currentTime();
      entry.order.push("base:" + task);
    } else if (button.dataset.bonus) {
      const id = button.dataset.bonus;
      task = "bonus:" + id;
      if (entry.rewards.includes(id)) return;
      entry.rewards.push(id);
      entry.order.push(task);
    } else if (button.hasAttribute('data-repeat')) {
      const id = button.dataset.repeat;
      task = 'repeat:' + id;
      entry.repeatables[id] = (entry.repeatables[id] || 0) + 1;
      entry.order.push(task);
    } else if (button.hasAttribute("data-video")) {
      task = "video";
      entry.videos++;
      entry.order.push("video");
    } else return;
    if (!task.startsWith("daily:") || /^[0-9a-f]{32}$/.test(task.slice(6))) {
      journal.mark({ child: state.active, day: state.today, task, at: Date.now() });
    }
    changed();
    if (taskIsReadOnly(button)) {
      const tasks = Array.from(lists[state.tab].querySelectorAll("button"));
      const next = tasks.slice(tasks.indexOf(button) + 1).find(task => !taskIsReadOnly(task));
      focus(next || tabs[state.tab]);
    }
  });

  root.addEventListener("change", event => {
    if (event.target === cutoff || event.target === demoTime) {
      cache.clear();
      lastEditable = editable();
      lastBeforeCutoff = currentTime() < morningCutoffFor(state.today, deadline());
      if (state.active !== null) paintProfile();
      paintMorning();
      save();
    }
  });

  function goBack() {
    if (showCalendar()) return true;
    if (!report.hidden) { reportButton.click(); focus(reportButton); return true; }
    return false;
  }

  function remote(key) {
    refresh();
    if (["Escape", "Backspace", "GoBack", "BrowserBack"].includes(key)) return goBack();
    const current = document.activeElement;
    if (key === "Enter") {
      if (current && root.contains(current) && (current.tagName === "BUTTON" || current.tagName === "INPUT")) {
        if (current.tagName === "INPUT" && typeof current.showPicker === "function") {
          try { current.showPicker(); } catch (_) { current.click(); }
        } else current.click();
      } else focus(profiles[0]);
      return true;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return false;
    const personalCards = Array.from((state.active === null ? get('[data-calendar-goals]') : get('[data-profile-goals]')).querySelectorAll('[data-goal-focus]'));
    const goalIndex = personalCards.indexOf(current);
    if (goalIndex >= 0) {
      const destination = key === 'ArrowDown' ? personalCards[goalIndex + 1] || (state.active === null ? reportButton : tabs[state.tab])
        : key === 'ArrowUp' ? personalCards[goalIndex - 1] || (state.active === null ? profiles[profiles.length - 1] : tabs[state.tab])
        : state.active === null ? profiles[0] : tabs[state.tab];
      focus(destination); return true;
    }
    let next;
    if (state.active === null) {
      const i = profiles.indexOf(current);
      const availableWeeks = weekButtons.filter(button => !button.disabled);
      const weekIndex = availableWeeks.indexOf(current);
      if (i >= 0) {
        if (key === "ArrowUp") next = i === 0 ? availableWeeks[0] || profiles[0] : profiles[i - 1];
        if (key === "ArrowLeft") next = profiles[Math.max(0, i - 1)];
        if (key === "ArrowDown") next = profiles[i + 1] || personalCards[0] || reportButton;
        if (key === "ArrowRight") next = availableWeeks[0] || (!advance.hidden ? advance : reportButton);
      } else if (weekIndex >= 0) {
        if (key === "ArrowLeft") next = availableWeeks[weekIndex - 1] || profiles[0];
        if (key === "ArrowRight") next = availableWeeks[weekIndex + 1] || (!advance.hidden ? advance : reportButton);
        if (key === "ArrowDown") next = profiles[0];
      } else next = profiles[current === reportButton ? profiles.length - 1 : 0];
    } else {
      const tasks = Array.from(lists[state.tab].querySelectorAll("button"));
      const i = tasks.indexOf(current);
      const tab = tabs.indexOf(current);
      if (key === 'ArrowRight' && i >= 0 && personalCards.length) { focus(personalCards[0]); return true; }
      if (tab >= 0 && (key === "ArrowLeft" || key === "ArrowRight")) {
        const destination = tab + (key === "ArrowLeft" ? -1 : 1);
        if (tabs[destination] && !tabs[destination].hidden) { tabs[destination].click(); next = tabs[destination]; }
      } else if (key === "ArrowLeft" && i >= 0) next = tabs[state.tab];
      else if (key === "ArrowUp") next = tab >= 0 ? back : tasks[i - 1] || (current === back ? null : tabs[state.tab]);
      else if (key === "ArrowDown") next = current === back ? tabs[state.tab] : tab >= 0 ? tasks[0] : tasks[i + 1];
    }
    if (!next || next.disabled) return false;
    focus(next);
    return true;
  }

  root.addEventListener("focusin", () => {
    const initial = get("[data-preview-focus]");
    if (initial) initial.removeAttribute("data-preview-focus");
  });
  root.addEventListener("keydown", event => {
    if (event.key !== "Enter" && remote(event.key)) event.preventDefault();
  });

  window.familyTvRemote = remote;
  window.familyTvBack = goBack;
  window.familyQuestSyncResult = journal.receive;
  window.familyTvStart = () => {
    if (!journal.car) focus(profiles[0]);
    journal.send();
  };
  window.familyTvRefresh = () => {
    refresh();
    journal.send();
  };

  if (!demo) {
    try {
      const stored = store ? store.read() : localStorage.getItem(storageKey);
      if (stored) restore(JSON.parse(stored));
    } catch (error) {
      console.error("Чтение журнала", error);
    }
  }
  ensureDay();
  get("[data-demo-clock]").hidden = !demo;
  paintCalendar();
  if (!demo) {
    journal.start();
    save();
    setInterval(window.familyTvRefresh, 10000);
  }
})();

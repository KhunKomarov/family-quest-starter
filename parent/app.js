(() => {
  "use strict";

  const { children, menuFor, monday, weekday, dateText, weekdayShort, chartHeight, dayColumn, longGoalStatus,
    longGoalCells, longGoalTodayText, morningTimeText, createStats } = window.FamilyRules;
  const { key, project, timeText } = window.FamilyProjection;
  const get = selector => document.querySelector(selector);
  const dialog = get("#action-dialog");
  const actionInput = get("#action-input");
  const actionAmount = get("#action-amount");
  const status = get("#status");
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
  const labels = {
    point: "😺 +1 балл", remark: "😿 −1 балл", undo: "Решение отменено",
    reject: "Галочка снята", reopen: "Разрешена повторная отметка", "restore-video": "Отметка видео восстановлена", "wallet-payout": "Выплата из копилки",
    "daily-add": "Добавлены задания дня", "daily-edit": "Задание изменено", "daily-remove": "Задание убрано",
    "catalog-add": "Добавлено постоянное дело", "family-link-issued": "Подтверждена выдача времени"
  };
  const limitNames = { morning: "Экранное время утром", youtube: "Экранное время днём" };
  const dailyTaskLimit = 20;
  let snapshot;
  let projected;
  let stats;
  let day;
  let child = 0;
  let panel = "checks";
  let pendingAction;
  let pendingDaily;
  let reading = false;
  let writing = false;
  let changes = 0;

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  function button(label, handler, className) {
    const result = node("button", label, className);
    result.type = "button";
    result.addEventListener("click", handler);
    return result;
  }

  async function request(path, body) {
    const response = await fetch("/parent/api/" + path, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : {});
    if (response.status === 401) location.replace("/parent/");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.error || "request failed");
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function show(data) {
    if (day === undefined || day === snapshot.today || day < monday(data.today)) day = data.today;
    snapshot = data;
    projected = project(data);
    const state = {
      first: Math.max(data.first, data.start), today: data.today, records: projected.records,
      syncedStart: data.start, startTargets: data.startTargets, catalog: data.catalog,
      recoverySince: data.recoverySince, startRecovery: data.startRecovery, longGoal: data.longGoal,
      afternoonRateCutover: data.afternoonRateCutover
    };
    stats = createStats(state, () => data.cutoff);
    get("#account").textContent = "Вход: " + data.actor;
    get("#dashboard").hidden = false;
    render();
  }

  async function refresh() {
    if (reading || writing) return;
    reading = true;
    const observed = changes;
    try {
      const data = await request("state");
      if (writing || observed !== changes) return;
      if (!snapshot || JSON.stringify(data) !== JSON.stringify(snapshot)) show(data);
      status.textContent = "";
    } catch (_) {
      status.textContent = "Нет связи с журналом. Проверяем подключение…";
    } finally {
      reading = false;
    }
  }

  function renderWeek() {
    const start = monday(snapshot.today);
    const goal = snapshot.longGoal;
    get("#week-range").textContent = dateText(start) + " — " + dateText(start + 6);
    const columns = weekdayShort.map((name, index) => {
      const date = start + index;
      const row = stats.getDay(date);
      const select = button("", () => { day = date; selectPanel("checks"); }, "chart-day");
      select.disabled = date > snapshot.today;
      select.setAttribute("aria-pressed", String(date === day));
      select.setAttribute("aria-label", dateText(date) + (row ? ", " + children.map(({ name }, i) => {
        const { score, target, remarks, parentPoints } = row[i];
        return name + " " + score + " из " + target + (remarks ? ", замечания −" + remarks : "")
          + (parentPoints ? ", похвала +" + parentPoints : "") + (stats.weekStatus(date, i) === "restored" ? ", восстановлено" : "");
      }).join(", ") : ""));
      select.append(node("span", name));
      const bars = node("span", undefined, "bars");
      if (goal && date >= goal.start) {
        bars.setAttribute("data-long-goal", "");
        bars.style.setProperty("--long-goal-threshold", chartHeight(goal.points) + "%");
      }
      children.forEach(({ color }, i) => {
        const data = row && row[i];
        const bar = node("span", undefined, "bar " + color);
        const fill = node("span", undefined, "bar-fill");
        const sizes = dayColumn(data, chartHeight);
        bar.style.setProperty("--goal", chartHeight(data ? data.target : 7) + "%");
        fill.style.height = sizes.height + "%";
        for (const [className, height] of [["bar-praise", sizes.praise], ["bar-earned", sizes.earned], ["bar-red", sizes.remarks]]) {
          if (!height) continue;
          const segment = node("span", undefined, className);
          segment.style.height = height + "%";
          fill.append(segment);
        }
        if (data && data.score) bar.append(node("small", data.score));
        if (stats.weekStatus(date, i) === "restored") bar.append(node("span", "↺", "bar-restored"));
        bar.prepend(fill);
        bars.append(bar);
      });
      bars.setAttribute("aria-hidden", "true");
      select.append(bars, node("small", new Date(date * 86400000).getUTCDate()));
      return select;
    });
    get("#week-chart").replaceChildren(...columns);
    get("#week-totals").replaceChildren(...children.map(({ name, color }, i) => {
      const span = node("span", undefined, color);
      const total = stats.weekTotal(i);
      span.append(node("strong", name), node("small", total + " / 5 будней"));
      return span;
    }));
    const goalPanel = get("#long-goal-goal");
    goalPanel.hidden = !goal || snapshot.today < goal.start;
    if (!goalPanel.hidden) {
      get("#long-goal-heading").textContent = goal.title || "Накопительная цель";
      const series = snapshot.today >= goal.skipSince ? ' дней · допустимо пропусков: ' + (goal.allowedSkips === undefined ? 1 : goal.allowedSkips) : " дней подряд";
      get("#long-goal-rule").textContent = "Золотая линия · " + goal.points + " очков в день · "
        + goal.days + series + " → " + (goal.reward || "приз семьи") + " · фиолетовый — перенос";
      const results = children.map((_, index) => stats.longGoalProgress(index));
      get("#long-goal-progress").replaceChildren(...children.map(({ name, color }, index) => {
        const progress = results[index];
        const summary = node("div", undefined, color);
        const track = node("div", undefined, "long-goal-cells");
        track.setAttribute("aria-hidden", "true");
        for (const { phase, carry, fill } of longGoalCells(progress, goal)) {
          const cell = node("i");
          cell.dataset.phase = phase;
          cell.style.setProperty("--carry", carry + "%");
          cell.style.setProperty("--fill", fill + "%");
          track.append(cell);
        }
        summary.append(node("strong", name), node("span", longGoalStatus(progress, goal)), track);
        if (!progress.earned) summary.append(node("small", longGoalTodayText(progress, goal)));
        return summary;
      }));
      get("#long-goal-ready").hidden = !results.some(progress => progress.earned);
    }
  }

  function cell(task, person = child, date = day) {
    return projected.cells.get(key(date, person, task));
  }

  function taskLabel(task, person, date = day) {
    const menu = menuFor(person, date, snapshot.catalog);
    if (task.startsWith("video:")) return menu.video.title;
    if (task.startsWith('repeat:')) return ((menu.repeatables || []).find(([id]) => id === task.split(':')[1]) || [task, task])[1];
    if (task.startsWith("bonus:")) return (menu.rewards.find(([id]) => "bonus:" + id === task) || [task, task])[1];
    const current = menu.morning.concat(menu.afternoon).find(([id]) => id === task);
    const historical = current || menuFor(person, 0, snapshot.catalog).afternoon.find(([id]) => id === task);
    return historical ? historical[1] : task;
  }

  function rowFor(title, meta, actions, checked) {
    const row = node("li");
    const details = node("div");
    const heading = node("strong");
    if (checked !== undefined) {
      const icon = node("span", checked ? "✓" : "○", "state-mark");
      icon.setAttribute("aria-hidden", "true");
      heading.append(icon);
    }
    heading.append(document.createTextNode(title));
    details.append(heading, node("p", meta, "meta"));
    row.append(details);
    if (actions.length) {
      const group = node("div", undefined, "actions");
      group.append(...actions);
      row.append(group);
    }
    return row;
  }

  function checklistRow(task, title, waiting, additional) {
    const value = cell(task);
    const checked = Boolean(value && value[4]);
    const locked = Boolean(value && value[5]);
    const actions = [];
    if (checked || locked) {
      const restoreVideo = locked && (task.startsWith("video:") || task.startsWith('repeat:'));
      const action = checked ? "reject" : restoreVideo ? "restore-video" : "reopen";
      const label = checked ? "Снять галочку" : restoreVideo ? "Вернуть галочку" : "Разрешить снова";
      actions.push(button(label, () => promptAction({ day, child, task, action, version: value[6] }, label, title)));
    }
    const state = locked ? "Снято родителями" : checked
      ? "Отмечено в " + timeText(value[3]) + (waiting ? " · " + waiting : "") : "Не отмечено";
    return rowFor(title, state + (additional ? " · дополнительно" : ""), actions, checked);
  }

  function renderChecks() {
    get("#selected-date").textContent = (day === snapshot.today ? "Сегодня · " : "") + dateText(day) + " · по времени семьи";
    get("#children").replaceChildren(...children.map(({ name, color }, i) => {
      const select = button(name, () => { child = i; renderChecks(); }, color);
      select.setAttribute("aria-pressed", String(child === i));
      return select;
    }));
    const balance = snapshot.wallets && snapshot.wallets[child];
    get("#wallet-balance").textContent = Number.isSafeInteger(balance) ? balance + " жет." : "—";
    get("#wallet-payout").disabled = !(balance > 0);
    const row = stats.getDay(day);
    const current = row && row[child];
    const week = stats.weekValues(child);
    const menu = menuFor(child, day, snapshot.catalog);
    const bonus = stats.weekend(child);
    const weekendHour = weekday(snapshot.today) === 5 ? bonus.saturday : bonus.sunday;
    const recovery = current && [stats.weekStatus(day, child) === "restored" ? ["Зачёт недели", "Восстановлено ✓"] : null,
      current.restored.length ? ["Восстановлены", current.restored.map(dateText).join(", ")] : null,
      day === snapshot.today && current.recoveryLeft ? ["До восстановления", current.recoveryLeft + " очк. сверх нормы"] : null,
      day === snapshot.today && weekendHour ? ["Бонус сегодня", "1 час гаджетов"] : null].filter(Boolean);
    get("#stats").replaceChildren(...(current ? [
      ["Дневная норма", current.score + " / " + current.target],
      ["Утренний минимум", current.morningDone + " / " + current.morningRequired.size],
      ["Телефон утром", morningTimeText(current) + " · " + current.onTime + " / " + current.morningRequired.size + " до " + current.morningCutoff],
      ["Экранное время за день", current.credit.minutes + " / 30 мин"],
      ["За день", current.credit.bats + " жет."],
      ["За неделю", week.bats + " жет."],
      ["Повторений за неделю", String(week.videos + week.repeats)],
      ["😺", "+" + current.parentPoints, "Похвала"],
      ["😿", "−" + current.remarks, "Замечания"]
    ].concat(recovery) : []).map(([label, value, description]) => {
      const item = node("div");
      if (description) {
        item.setAttribute("role", "group");
        item.setAttribute("aria-label", description);
      }
      item.append(node("strong", value), document.createTextNode(label));
      return item;
    }));
    const videoMarks = Array.from(projected.cells.values())
      .filter(([date, person, task]) => date === day && person === child && task.startsWith("video:"))
      .map(([, , task], index) => [task, menu.video.title + " · отметка " + (index + 1)]);
    const repeatMarks = (menu.repeatables || []).flatMap(([id, title]) => {
      const marks = Array.from(projected.cells.values()).filter(([date, person, task]) =>
        date === day && person === child && task.startsWith('repeat:' + id + ':'));
      return marks.length ? marks.map(([, , task], index) => [task, title + ' · отметка ' + (index + 1)]) : [['repeat:' + id, title]];
    });
    const sections = [
      ["Утро", menu.morning],
      ["Дневные дела", menu.afternoon],
      ["Супер дела", menu.rewards.map(([task, title]) => ["bonus:" + task, title])
        .concat(videoMarks.length ? videoMarks : [["video", menu.video.title]], repeatMarks)],
      ["Задания дня", projected.daily.filter(task => task.day === day).map(task => ["daily:" + task.id, task.title])]
    ];
    get("#checklist").replaceChildren(...sections.filter(([, tasks]) => tasks.length).flatMap(([title, tasks]) => {
      const list = node("ul", undefined, "items");
      const waiting = current && title === "Дневные дела" && !current.morningMet
        ? "зачтётся после всех " + current.morningRequired.size + " утренних дел"
        : current && title === "Супер дела" && !current.rewardsOpen
          ? (current.met ? "после восстановления пропусков" : "после дневной нормы") : "";
      list.append(...tasks.map(([task, name]) => {
        const additional = current && title === "Утро" && !current.morningRequired.has(task);
        return checklistRow(task, name, waiting, additional);
      }));
      return [node("h3", title), list];
    }));
  }

  function currentDailyTasks() {
    return projected.daily.filter(task => task.day === snapshot.today);
  }

  function renderDaily() {
    get("#daily-date").textContent = dateText(snapshot.today) + " · по времени семьи";
    const tasks = currentDailyTasks();
    get("#daily-capacity").textContent = "Заданий на сегодня: " + tasks.length + " из " + dailyTaskLimit + ".";
    get("#daily-list").replaceChildren(...tasks.map(({ day, id, title, done }) => {
      const edit = button("Править", () => promptAction({ day, action: "daily-edit", target: id, expected: title },
        "Изменить задание", "", "title", title));
      const remove = button("Убрать", () => promptAction({ day, action: "daily-remove", target: id, expected: title },
        "Убрать задание", title, ""));
      const names = children.filter((_, i) => done.includes(i)).map(person => person.name);
      return rowFor(title, names.length ? "Отметили: " + names.join(", ") : "Пока без отметок", [edit, remove]);
    }));
    if (!tasks.length) get("#daily-list").append(node("li", "На сегодня заданий нет.", "meta"));
  }

  function renderLimits() {
    get("#limits-date").textContent = dateText(snapshot.today) + " · по времени семьи";
    const rewards = snapshot.familyLink || [];
    const now = Date.now();
    const rows = rewards.map(({ child, kind, earned, issued, availableAt, expiresAt }) => {
      const title = children[child].name + " · " + limitNames[kind];
      const difference = earned - issued;
      let detail = "Заработано " + earned + " мин";
      if (issued) detail += " · выдано " + issued + " мин";
      const inWindow = !(now < availableAt || now >= expiresAt);
      if (difference > 0 && inWindow) detail += " · к выдаче " + difference + " мин";
      if (now < availableAt) detail += " · выдача с " + timeText(availableAt);
      if (expiresAt) detail += now >= expiresAt ? " · окно закрылось в " + timeText(expiresAt) : " · до " + timeText(expiresAt);
      if (difference < 0) detail += " · проверь лимит после изменения журнала";
      const actions = difference > 0 && inWindow ? [button("Отметить выдачу", () => {
        promptAction({ action: "family-link-issued", day: snapshot.today, child, kind, minutes: earned, expected: issued },
          "Подтвердить выдачу", title + " · " + difference + " мин уже выданы?", "");
      })] : [];
      return rowFor(title, detail, actions);
    });
    get("#limits-list").replaceChildren(...(rows.length ? rows : [node("li", "Пока нет заработанного времени.", "meta")]));
  }

  function renderAudit() {
    const active = new Set(snapshot.adjustments.map(row => row[4]));
    const items = snapshot.audit.map(([id, at, date, actor, action, person, label, note]) => {
      const title = labels[action] + (Number.isInteger(person) ? " · " + children[person].name : "");
      const correction = action === "reject" || action === "reopen" || action === "restore-video";
      const detail = correction ? (label.startsWith("daily:") ? label.slice(6) : taskLabel(label, person, date))
        : action === "undo" && label === "Замечание −1" ? labels.remark
        : action === "undo" && label === "Баллы +1" ? labels.point : label;
      const history = [actor + " · " + dateText(date) + " · " + timeText(at), detail, note].filter(Boolean).join("\n");
      const actions = active.has(id) ? [button("Отменить", () => promptAction({ day: date, action: "undo", target: id },
        "Отменить решение", title))] : [];
      return rowFor(title, history, actions);
    });
    get("#audit-list").replaceChildren(...(items.length ? items : [node("li", "Родительских решений пока нет.", "meta")]));
  }

  function render() {
    renderWeek();
    if (snapshot.familyConfig) Object.assign(window.FamilyConfig, snapshot.familyConfig);
    window.FamilyPeriodGoals.render(get('#period-goals'), snapshot.periodGoals || [], children.map(child => child.name));
    if (panel === "checks") renderChecks();
    else if (panel === "limits") renderLimits();
    else if (panel === "daily") renderDaily();
    else renderAudit();
  }

  function selectPanel(name) {
    panel = name;
    for (const tab of document.querySelectorAll("[data-panel]")) {
      const selected = tab.dataset.panel === name;
      tab.setAttribute("aria-pressed", String(selected));
      get("#" + tab.dataset.panel).hidden = !selected;
    }
    render();
  }

  function promptAction(action, title, summary, field = "note", initial = "") {
    if (writing) return;
    const payout = action.action === "wallet-payout";
    pendingAction = { id: id(), ...action };
    get("#action-title").textContent = title;
    get("#action-summary").textContent = summary;
    get("#action-summary").hidden = !summary;
    get("#action-error").textContent = "";
    get("#action-submit").textContent = payout ? "Списать" : action.action === "family-link-issued" ? "Подтвердить" : "Сохранить";
    get("#action-amount-wrap").hidden = actionAmount.disabled = !payout;
    actionAmount.required = payout;
    actionAmount.value = "";
    actionAmount.max = payout ? snapshot.wallets[action.child] : "";
    get("#action-input-wrap").hidden = !field;
    get("#action-label").textContent = field === "title" ? "Задание"
      : action.action === "remark" ? "Что случилось?" : "За что / примечание";
    actionInput.name = field;
    actionInput.value = initial;
    actionInput.maxLength = field === "title" ? 250 : 500;
    actionInput.required = ["point", "remark", "daily-edit"].includes(action.action);
    dialog.showModal();
    if (payout) actionAmount.focus();
    else if (field) actionInput.focus();
  }

  function errorText(error) {
    if (error.message === "insufficient_balance") return "В копилке уже меньше этой суммы. Проверь остаток.";
    if (error.status === 409) return "Запись уже изменилась. Открой её снова и проверь.";
    if (error.status === 400) return "Проверь текст, дату и список. На день можно добавить до 20 заданий.";
    return "Нет связи с журналом. Попробуй ещё раз.";
  }

  for (const tab of document.querySelectorAll("[data-panel]")) tab.addEventListener("click", () => selectPanel(tab.dataset.panel));
  for (const control of document.querySelectorAll("[data-decision]")) control.addEventListener("click", () => {
    const action = control.dataset.decision;
    promptAction({ day, child, action }, labels[action], children[child].name + " · " + dateText(day));
  });
  get("#wallet-payout").addEventListener("click", () => {
    const action = "wallet-payout";
    promptAction({ day: snapshot.today, child, action }, labels[action], children[child].name + " · " + snapshot.wallets[child] + " жет. в копилке");
  });
  get("#action-cancel").addEventListener("click", () => { if (!writing) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (writing) event.preventDefault(); });
  get("#action-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!pendingAction || writing) return;
    const submit = get("#action-submit");
    const input = actionInput.value.trim();
    if (actionInput.required && !input) {
      get("#action-error").textContent = "Заполни это поле.";
      return;
    }
    const body = { ...pendingAction };
    if (actionInput.name) body[actionInput.name] = input;
    if (body.action === "wallet-payout") {
      const amount = actionAmount.valueAsNumber;
      if (!Number.isSafeInteger(amount) || amount < 1) {
        get("#action-error").textContent = "Введи целое число жетонов больше нуля.";
        return;
      }
      body.amount = amount;
    }
    writing = submit.disabled = true;
    changes++;
    try {
      show(await request("action", body));
      dialog.close();
      status.textContent = body.action === "wallet-payout" ? "Выплата записана" : "Сохранено";
    } catch (error) {
      get("#action-error").textContent = errorText(error);
    } finally {
      writing = submit.disabled = false;
    }
  });
  get("#add-daily").addEventListener("submit", async event => {
    event.preventDefault();
    if (!snapshot || writing) return;
    const input = get("#new-tasks");
    const activeTasks = currentDailyTasks();
    const active = new Set(activeTasks.map(task => task.title));
    const lines = input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const titles = Array.from(new Set(lines)).filter(title => !active.has(title));
    if (!lines.length || titles.some(title => Array.from(title).length > 250)) {
      status.textContent = "Введи хотя бы одно дело, до 250 символов в строке.";
      return;
    }
    if (!titles.length) {
      status.textContent = "Эти задания уже есть.";
      return;
    }
    if (activeTasks.length + titles.length > dailyTaskLimit) {
      const remaining = Math.max(0, dailyTaskLimit - activeTasks.length);
      status.textContent = "Свободных мест на сегодня: " + remaining + ".";
      return;
    }
    if (!pendingDaily || pendingDaily.day !== snapshot.today || JSON.stringify(pendingDaily.titles) !== JSON.stringify(titles)) {
      pendingDaily = { id: id(), action: "daily-add", day: snapshot.today, titles };
    }
    const submit = event.currentTarget.querySelector("button");
    writing = submit.disabled = true;
    changes++;
    try {
      show(await request("action", pendingDaily));
      pendingDaily = null;
      input.value = "";
      status.textContent = "Задания добавлены";
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      writing = submit.disabled = false;
    }
  });
  get("#logout").addEventListener("click", async () => {
    try {
      await request("logout", {});
      location.replace("/parent/");
    } catch (_) {
      status.textContent = "Не удалось завершить сеанс.";
    }
  });
  window.addEventListener("focus", refresh);
  setInterval(refresh, 8000);
  refresh();
})();

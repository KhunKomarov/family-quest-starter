(() => {
  "use strict";

  const { children, menuFor, videoRate, afternoonTaskRate } = window.FamilyRules;
  const get = selector => document.querySelector(selector);
  const form = get("#catalog-form");
  const title = get("#catalog-title");
  const section = get("#catalog-section");
  const rate = get("#catalog-rate");
  const status = get("#catalog-status");
  const submit = form.querySelector("button");
  const descriptions = {
    morning: "До школы пять общих дел. Новое постоянное дело попадёт в раздел «После школы».",
    afternoon: "Ставка дневного дела показана в списке. После выполнения нормы дело приносит минуты или жетоны.",
    rewards: "Дело засчитывается после нормы и восстановления пропусков. Когда накоплено 30 минут, следующее дело даёт столько же жетонов, сколько стоило бы минут."
  };
  let snapshot;
  let pending;
  let writing = false;

  for (const [index, child] of children.entries()) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = "children";
    box.value = index;
    label.append(box, document.createTextNode(child.name));
    get("#catalog-children").append(label);
  }

  async function request(path, body) {
    const response = await fetch("/parent/api/" + path, body ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    } : {});
    if (response.status === 401) location.replace("/parent/");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }

  function renderCategory() {
    const category = section.value;
    const reward = category === "rewards";
    rate.disabled = !reward;
    rate.required = reward;
    get("#catalog-rate-field").hidden = !reward;
    get("#catalog-hint").textContent = descriptions[category];
    if (!snapshot) return;
    const rows = new Map();
    children.forEach((child, index) => {
      const menu = menuFor(index, snapshot.today, snapshot.catalog);
      const tasks = reward ? menu.rewards.concat([["video", menu.video.title, videoRate(menu)]]) : menu[category];
      for (const [id, name, minutes] of tasks) {
        let label = reward ? name + " · " + minutes + " мин / " + minutes + " жет." : name;
        if (category === "afternoon") {
          const amount = afternoonTaskRate(snapshot.today, id, name, menu.afternoonMinutes, snapshot.afternoonRateCutover);
          label += " · " + amount + " мин / " + amount + " жет.";
        }
        if (!rows.has(label)) rows.set(label, []);
        rows.get(label).push(child.name);
      }
    });
    const items = get("#catalog-items");
    items.replaceChildren();
    for (const [label, names] of rows) {
      const item = document.createElement("li");
      const details = document.createElement("div");
      const name = document.createElement("strong");
      const people = document.createElement("p");
      name.textContent = label;
      people.textContent = names.join(", ");
      details.append(name, people);
      item.append(details);
      items.append(item);
    }
    get("#catalog-list").hidden = false;
  }

  async function refresh() {
    try {
      snapshot = await request("state");
      get("#task-account").textContent = "Вход: " + snapshot.actor;
      renderCategory();
      submit.disabled = false;
      status.textContent = "";
    } catch (_) {
      status.textContent = "Не удалось загрузить дела. Обнови страницу.";
    }
  }

  section.addEventListener("change", renderCategory);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!snapshot || writing) return;
    const assigned = new FormData(form).getAll("children").map(Number);
    const fields = { title: title.value.trim(), section: section.value, children: assigned };
    if (!fields.title || !assigned.length) {
      status.textContent = "Введи название и выбери хотя бы одного ребёнка.";
      return;
    }
    if (fields.section === "rewards") fields.rate = rate.valueAsNumber;
    const signature = JSON.stringify(fields);
    if (!pending || pending.signature !== signature || pending.body.day !== snapshot.today) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        value => value.toString(16).padStart(2, "0")).join("");
      pending = { signature, body: { id, day: snapshot.today, action: "catalog-add", ...fields } };
    }
    status.textContent = "Сохраняем дело…";
    writing = submit.disabled = true;
    try {
      snapshot = await request("action", pending.body);
      pending = null;
      if (title.value.trim() === fields.title) title.value = "";
      renderCategory();
      status.textContent = "Дело добавлено с сегодняшнего дня.";
    } catch (error) {
      if (error.message === "conflict") {
        await refresh();
        status.textContent = "Дата или список изменились. Проверь и нажми «Добавить дело» ещё раз.";
      } else if (error.message === "duplicate_task") {
        status.textContent = "У одного из выбранных детей уже есть такое дело в этой категории.";
      } else if (error.message === "invalid_request") {
        status.textContent = "Проверь название, категорию, детей и количество минут.";
      } else {
        status.textContent = "Не удалось сохранить дело. Попробуй ещё раз.";
      }
    } finally {
      writing = submit.disabled = false;
    }
  });
  renderCategory();
  refresh();
})();

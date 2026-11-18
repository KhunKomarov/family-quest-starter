(() => {
  "use strict";

  const { children, blank, utcOffset } = window.FamilyRules;
  const key = (day, child, task) => [day, child, task].join("/");
  const timeText = at => new Date(at + utcOffset).toISOString().slice(11, 16);

  function project(snapshot, pending = []) {
    const cells = new Map(snapshot.cells.map(cell => [key(...cell.slice(0, 3)), cell]));
    for (const { day, child, task, at, checked, id, guard } of pending) {
      if (!checked || day < snapshot.start || day > snapshot.today) continue;
      const idKey = key(day, child, task);
      const previous = cells.get(idKey);
      if (previous && (previous[4] || previous[5] || previous[7] !== guard || previous[3] > at)) continue;
      if (!previous && guard) continue;
      cells.set(idKey, [day, child, task, at, 1, 0, id, guard]);
    }

    const daily = new Map(snapshot.daily.map(([day, id, title]) => [id, { day, id, title, done: [] }]));
    const records = {};
    const events = [];
    for (const [day, child, task, at, checked, , version] of cells.values()) {
      if (!checked) continue;
      if (task.startsWith("daily:")) {
        const item = daily.get(task.slice(6));
        if (item && item.day === day) item.done.push(child);
      } else {
        events.push({ day, child, task, at, version });
      }
    }
    for (const [day, child, sign, at, version] of snapshot.adjustments) {
      events.push({ day, child, task: sign === 1 ? "parent" : "remark", at, version });
    }
    events.sort((a, b) => a.at - b.at || (a.version < b.version ? -1 : a.version === b.version ? 0 : 1));
    for (const { day, child, task, at } of events) {
      if (!records[day]) records[day] = children.map(blank);
      const entry = records[day][child];
      if (task === "remark") {
        entry.remarks++;
      } else if (task === "parent") {
        entry.parentPoints++;
        entry.order.push("parent");
      } else if (task.startsWith("video:")) {
        entry.videos++;
        entry.order.push("video");
      } else if (task.startsWith('repeat:')) {
        const id = task.split(':')[1];
        entry.repeatables[id] = (entry.repeatables[id] || 0) + 1;
        entry.order.push('repeat:' + id);
      } else if (task.startsWith("bonus:")) {
        entry.rewards.push(task.slice(6));
        entry.order.push(task);
      } else {
        entry.base[task] = timeText(at);
        entry.order.push("base:" + task);
      }
    }
    return { cells, daily: Array.from(daily.values()), records };
  }

  window.FamilyProjection = { key, project, timeText };
})();

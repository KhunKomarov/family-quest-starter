(() => {
  "use strict";

  const { key } = window.FamilyProjection;
  const id = () => Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
    byte => ("0" + byte.toString(16)).slice(-2)).join("");

  window.createFamilyJournal = (transport, apply, persist, showStatus) => {
    const enabled = Boolean(transport && transport.enabled());
    const car = Boolean(transport && transport.car());
    const scope = enabled ? transport.scope() : "";
    let data = { scope, queue: [], canonical: null };
    let outstanding = null;
    let backoffUntil = 0;
    let cells = new Map();

    function refresh() {
      if (!data.canonical) return;
      const projected = window.FamilyProjection.project(data.canonical, data.queue);
      cells = projected.cells;
      apply(data.canonical, projected);
    }

    function restore(saved) {
      if (enabled && saved && saved.scope === scope && Array.isArray(saved.queue)) {
        data = { scope, queue: saved.queue, canonical: saved.canonical };
      }
    }

    function cell(day, child, task) {
      return cells.get(key(day, child, task));
    }

    function locked(day, child, task) {
      const current = cell(day, child, task);
      return Boolean(current && current[5]);
    }

    function mark(change) {
      if (!enabled) return;
      const identifier = id();
      if (change.task === "video") change = { ...change, task: "video:" + identifier };
      if (/^repeat:[^:]+$/.test(change.task)) change = { ...change, task: change.task + ':' + identifier };
      const current = cell(change.day, change.child, change.task);
      if (current && (current[4] || current[5])) return;
      data.queue.push({ ...change, checked: true, id: identifier, guard: current ? current[7] : "" });
      refresh();
    }

    function send() {
      if (!enabled || outstanding || Date.now() < backoffUntil) return;
      const operations = data.queue.slice(0, 200);
      if (operations.length && !persist()) {
        showStatus("Не удалось сохранить очередь");
        return;
      }
      outstanding = { operations };
      showStatus(operations.length ? "Отправляем отметки…" : "Проверяем журнал…");
      try {
        transport.exchange(JSON.stringify(outstanding));
      } catch (_) {
        receive(0, "");
      }
    }

    function receive(status, raw) {
      if (!outstanding) return;
      const request = outstanding;
      outstanding = null;
      if (status !== 200) {
        backoffUntil = Date.now() + 5000;
        showStatus(data.queue.length ? "Отметки сохранены на устройстве" : "Нет связи с журналом");
        return;
      }
      try {
        const response = JSON.parse(raw);
        if (![response.start, response.first, response.today].every(Number.isSafeInteger)
            || ![response.cells, response.daily, response.adjustments, response.acknowledged, response.startTargets].every(Array.isArray)) {
          throw new Error("Invalid journal");
        }
        const sent = new Set(request.operations.map(operation => operation.id));
        const acknowledged = new Set(response.acknowledged.filter(identifier => sent.has(identifier)));
        if (acknowledged.size !== sent.size) throw new Error("Missing acknowledgement");
        delete response.acknowledged;
        const changed = JSON.stringify(data.canonical) !== JSON.stringify(response);
        if (changed || acknowledged.size) {
          data.canonical = response;
          data.queue = data.queue.filter(operation => !acknowledged.has(operation.id));
          refresh();
          if (!persist()) {
            showStatus("Не удалось сохранить журнал");
            return;
          }
        }
        showStatus(data.queue.length ? "Есть отметки к отправке" : "Журнал обновлён");
        if (data.queue.length) setTimeout(send, 0);
      } catch (_) {
        backoffUntil = Date.now() + 5000;
        showStatus("Журнал ответил с ошибкой");
      }
    }

    return { enabled, car, restore, mark, start: refresh, send, receive, locked,
      snapshot: () => data.scope ? data : undefined };
  };
})();

(() => {
  "use strict";

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const dayMs = 86400000;
  const combinedBinsDay = Date.UTC(2026, 10, 12) / dayMs;
  const sharedChoresDay = Date.UTC(2026, 10, 12) / dayMs;
  const config = window.FamilyConfig;
  const utcOffset = config.utcOffsetMinutes * 60000;
  const ordinary = 7;
  const recoveryStart = Date.UTC(2026, 10, 12) / dayMs;
  const minuteLimit = 30;
  const parentRewardSince = Date.UTC(2026, 10, 19) / dayMs;
  const parentRewardRate = 5;
  const valuePrioritySince = Date.UTC(2026, 10, 19) / dayMs;
  const rewardOverflowSince = Date.UTC(2026, 10, 19) / dayMs;
  const morningCutoff = "07:10";
  const morningMinimumSince = Date.UTC(2026, 10, 16) / dayMs;
  const morningWindowsSince = Date.UTC(2026, 10, 17) / dayMs;
  const afternoonRatesSince = Date.UTC(2026, 10, 17) / dayMs;
  const entertainmentCutoffSince = Date.UTC(2026, 10, 16) / dayMs;
  const higherRateChores = new Set(["dish-out", "dish-in", "trash", "bins", "bags", "bins-and-bags", "reflective-vest"]);
  const weekdayShort = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const weekdayLong = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const morningTasks = [
    ["bed", "Заправить кровать"], ["teeth", "Почистить зубы"], ["dress", "Одеться"],
    ["breakfast", "Позавтракать"], ["car", "Положить рюкзак в машину, сесть и пристегнуться"]
  ];
  const requiredMorningIds = new Set(morningTasks.map(([id]) => id));
  const commonDayTasks = [
    ["wash", "Принять душ"],
    ["school", "После школы забрать вещи из машины, поставить свою обувь на место и занести рюкзаки в дом"],
    ["clothes", "Разложить свою одежду по полкам"],
    ["toys", "Убрать игрушки на место"]
  ];
  const dishwasherTasks = [["dish-out", "Разобрать посудомойку"], ["dish-in", "Загрузить посудомойку"]];
  const sharedChores = dishwasherTasks.concat([
    ["trash", "Вынести большой мусор и вставить новый пакет в ведро"],
    ["bins-and-bags", "Вынести мусор из маленьких вёдер и вставить новые пакеты"]
  ]);
  const templates = [
    { color: "kid-orange", chores: dishwasherTasks, videoMinutes: 15 },
    { color: "kid-green", chores: [["trash", "Вынести мусор"], ["bins-and-bags", "Проверить маленькие мусорные вёдра и заменить пакеты"]], videoBats: 10 },
    { color: "kid-red", chores: [["shoes", "Расставить обувь в гараже"]], videoBats: 10 }
  ];
  const children = config.profiles.map((name, index) => ({ ...templates[index % templates.length], name }));
  const bonusTasks = [
    ["poem", "Выучить стих из 8 строк", 15], ["text", "Выучить отрывок текста", 15],
    ["read", "Прочитать два листа и пересказать", 15], ["help", "Помочь выучить стих", 15],
    ["ai-song", "Сочинить и исполнить песню с нейросетью", 30],
    ["song", "Самому сочинить и исполнить песню", 60]
  ];
  const minutesByTask = new Map(bonusTasks.map(([id, , minutes]) => [id, minutes]));
  const olderRates = { poem: 10, text: 10, "ai-song": 15 };
  const sampleStart = Date.UTC(2026, 10, 23) / dayMs;
  const sampleDays = [[12, 8, 7], [16, 6, 7]];
  const timeNow = () => new Date(Date.now() + utcOffset);
  const realDay = () => Math.floor(timeNow().getTime() / dayMs);
  const date = day => new Date(day * dayMs);
  const weekday = day => (date(day).getUTCDay() + 6) % 7;
  const entertainmentCutoff = day => day >= entertainmentCutoffSince &&
    (weekday(day) < 4 || weekday(day) === 6) ? "21:00" : "";
  const morningCutoffFor = (day, previous) => day < morningWindowsSince
    ? previous || morningCutoff : weekday(day) >= 5 ? "09:00" : morningCutoff;
  const monday = day => day - weekday(day);
  const dateText = day => date(day).getUTCDate() + " " + months[date(day).getUTCMonth()];
  const blank = () => ({ base: {}, rewards: [], repeatables: {}, videos: 0, remarks: 0, parentPoints: 0, order: [] });

  function dayTasks(index, day) {
    const chores = children[index].chores;
    if (day >= sharedChoresDay) return commonDayTasks.concat(sharedChores, index === 2 ? chores : []);
    if (index === 1 && day < combinedBinsDay) {
      return commonDayTasks.concat([chores[0]], [
        ["bins", "Проверить маленькие мусорные вёдра"], ["bags", "Заменить мусорные пакеты"]
      ]);
    }
    return commonDayTasks.concat(chores);
  }

  function awardRate(index, id) {
    return index < 2 && own(olderRates, id) ? olderRates[id] : minutesByTask.get(id);
  }

  function menuFor(index, day, catalog = []) {
    for (let version = catalog.length - 1; version >= 0; version--) {
      const [since, menus] = catalog[version];
      if (since <= day) return dailyMenu(menus[index], day);
    }
    const child = children[index];
    return {
      morning: morningTasks,
      afternoon: dayTasks(index, day),
      afternoonMinutes: day >= sharedChoresDay ? 10 : 5,
      rewards: bonusTasks.filter(([id]) => index !== 2 || id !== "help").map(([id, title]) =>
        [id, index === 2 && id === "poem" ? "Выучить стих из 4 строк" : title, awardRate(index, id)]),
      video: { title: "Снять короткое творческое видео", minutes: child.videoMinutes || 0, bats: child.videoBats || 0 }
    };
  }

  function dailyMenu(menu, day) {
    if (day < morningMinimumSince) return menu;
    const moved = menu.morning.filter(([id]) => !requiredMorningIds.has(id));
    if (!moved.length) return menu;
    return {
      ...menu,
      morning: menu.morning.filter(([id]) => requiredMorningIds.has(id)),
      afternoon: menu.afternoon.concat(moved),
      previousMorning: day === morningMinimumSince ? moved : []
    };
  }

  const videoRate = menu => menu.video.minutes || menu.video.bats;

  function splitReward(rate, minutes, day = realDay()) {
    const earnedMinutes = Math.min(rate, Math.max(0, minuteLimit - minutes));
    const bats = day >= rewardOverflowSince || minutes >= minuteLimit ? rate - earnedMinutes : 0;
    return { minutes: earnedMinutes, bats };
  }

  function offer(rate, minutes, day = realDay()) {
    const reward = splitReward(rate, minutes, day);
    const parts = [];
    if (reward.minutes) parts.push("+" + reward.minutes + " мин");
    if (reward.bats) parts.push("+" + reward.bats + " жет.");
    return parts.join(" · ");
  }

  function afternoonTaskRate(day, id, title, previous = 5, cutover, markedTime) {
    if (day < afternoonRatesSince) {
      if (!cutover || cutover.day !== day) return previous;
      if (markedTime) {
        const [hours, minutes] = markedTime.split(":").map(Number);
        if (hours * 60 + minutes < cutover.minute) return previous;
      }
    }
    if (higherRateChores.has(id)) return 10;
    const name = title.toLowerCase();
    const dishwasher = name.includes("посудомой") && /разобра|разбор|разгруз|выгруз|загруз|сложи/.test(name);
    const reflectiveVest = name.includes("жилет") && /светоотраж|световозвращ/.test(name);
    const piano = name.includes("фортепиано") || name.includes("пианино");
    return dishwasher || reflectiveVest || piano || name.includes("мусор") ? 10 : 5;
  }

  function chartHeight(points) {
    return points <= 12 ? points * 7 : 84 + (points - 12) / (points - 12 + 9) * 12;
  }

  function dayColumn(data, scale, minimum = 0) {
    if (!data) return { height: minimum, earned: 0, remarks: 0, praise: 0 };
    const score = scale(data.score);
    const top = scale(data.score + data.remarks);
    const height = Math.max(minimum, top);
    const percent = value => height ? value / height * 100 : 0;
    const praise = scale(Math.min(data.score, data.parentPoints));
    return {
      height,
      earned: percent(score - praise),
      remarks: percent(top - score),
      praise: percent(praise)
    };
  }

  function longGoalStatus(progress, goal) {
    if (progress.earned) return "Цель достигнута";
    const counter = progress.streak + " / " + goal.days + " дней";
    if (progress.streak === goal.days) return counter + " · итог в полночь";
    const surplus = progress.surplus ? " · +" + progress.surplus + " на завтра" : "";
    const skips = goal.allowedSkips === undefined ? 1 : goal.allowedSkips;
    const used = progress.missCount === undefined ? Number(Boolean(progress.missUsed)) : progress.missCount;
    const skip = progress.skipEnabled && progress.streak ? ' · пропуски: ' + used + '/' + skips : '';
    return counter + surplus + skip;
  }

  function longGoalCells(progress, goal) {
    const confirmed = progress.streak - (!progress.earned && progress.todayMet ? 1 : 0);
    const percent = points => Math.min(100, points / goal.points * 100);
    return Array.from({ length: goal.days }, (_, index) => {
      if (index < confirmed) return { phase: "complete", carry: 0, fill: 100 };
      if (!progress.earned && index === confirmed) {
        return { phase: "today", carry: percent(progress.carried), fill: percent(progress.todayPoints) };
      }
      if (!progress.earned && index === confirmed + 1 && progress.todayMet && progress.surplus) {
        const fill = percent(progress.surplus);
        return { phase: "tomorrow", carry: fill, fill };
      }
      return { phase: "future", carry: 0, fill: 0 };
    });
  }

  function longGoalTodayText(progress, goal) {
    return "Сегодня " + Math.min(progress.todayPoints, goal.points) + "/" + goal.points
      + (progress.carried ? " · +" + progress.carried + " со вчера" : "");
  }

  function morningTimeText({ morningMinutes, morningExtraMinutes }) {
    return morningMinutes + " мин" + (morningExtraMinutes ? " · из них " + morningExtraMinutes + " за доп. дела" : "");
  }

  function createStats(state, getCutoff, demo = false) {
    const cache = new Map();
    function getEntry(day, index) {
      return state.records[day] ? state.records[day][index] : blank();
    }

    function creditFor(entry, target, debt, opened, marked, menu, morningRequired, day) {
      let minutes = 0;
      let bats = 0;
      let baseCount = 0;
      let morningCount = 0;
      let parentCount = 0;
      let countedVideos = 0;
      let countedRepeats = 0;
      let pendingVideos = 0;
      const awards = new Map();
      const morningIds = new Set(menu.morning.map(([id]) => id));
      const afternoonRates = new Map(menu.afternoon.map(([id, title]) =>
        ["base:" + id, afternoonTaskRate(day, id, title, menu.afternoonMinutes,
          state.afternoonRateCutover, entry.base[id])]));
      const rates = new Map(menu.rewards.map(([id, , rate]) => [id, rate]));
      const repeatRates = new Map((menu.repeatables || []).map(([id, , rate]) => [id, rate]));
      const video = menu.video;
      const pendingAfternoon = [];
      const pendingRewards = [];
      const rewardTarget = target + debt;

      function settleVideos() {
        if (minutes < minuteLimit || !pendingVideos) return;
        bats += pendingVideos * video.bats;
        countedVideos += pendingVideos;
        pendingVideos = 0;
      }

      function credit(key, rate) {
        const reward = splitReward(rate, minutes, day);
        awards.set(key, offer(rate, minutes, day));
        minutes += reward.minutes;
        bats += reward.bats;
        settleVideos();
      }

      function applyReward(mark) {
        if (mark.startsWith('repeat:')) {
          const rate = repeatRates.get(mark.slice(7));
          if (rate !== undefined) { credit(mark, rate); countedRepeats++; }
        } else if (mark !== "video") {
          const rate = rates.get(mark.slice("bonus:".length));
          if (rate !== undefined) credit(mark, rate);
        } else if (day >= morningMinimumSince || video.minutes) {
          credit(mark, videoRate(menu));
          countedVideos++;
        } else {
          pendingVideos++;
          settleVideos();
        }
      }

      function dailyReached() {
        return morningCount === morningRequired.size && baseCount + parentCount - entry.remarks >= rewardTarget;
      }

      function settleRewards() {
        if (!dailyReached() || !pendingRewards.length) return;
        pendingRewards.forEach(applyReward);
        pendingRewards.length = 0;
      }

      function applyParent() {
        parentCount++;
        const score = baseCount + parentCount - entry.remarks;
        if (day >= parentRewardSince && morningCount === morningRequired.size && score > target) {
          if (score <= rewardTarget) awards.set("parent:" + parentCount, "На восстановление");
          else credit("parent:" + parentCount, parentRewardRate);
        }
        settleRewards();
      }

      function applyBase(mark) {
        baseCount++;
        const score = baseCount + parentCount - entry.remarks;
        const rate = afternoonRates.get(mark);
        if (rate && baseCount > morningRequired.size && score > target) {
          if (score <= rewardTarget) awards.set(mark, "На восстановление");
          else credit(mark, rate);
        }
        settleRewards();
      }

      if (opened) {
        // Norm and recovery consume the cheapest ordinary marks, regardless of tap order.
        const valueOrder = mark => {
          const [kind, id] = mark.split(":");
          if (kind === "base" && morningIds.has(id)) return [0, 0, id];
          if (kind === "base" && marked.has(id)) return [1, afternoonRates.get(mark) || 0, id];
          if (kind === "parent") return [1, parentRewardRate, "parent"];
          return [2, 0, mark];
        };
        const order = day < valuePrioritySince ? entry.order : entry.order.slice().sort((a, b) => {
          const x = valueOrder(a), y = valueOrder(b);
          return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
        });
        for (const mark of order) {
          const [kind, id] = mark.split(":");
          if (kind === "base" && marked.has(id)) {
            if (morningIds.has(id)) {
              if (morningRequired.has(id)) morningCount++;
              applyBase(mark);
              if (morningCount === morningRequired.size && pendingAfternoon.length) {
                pendingAfternoon.forEach(pending => pending === "parent" ? applyParent() : applyBase(pending));
                pendingAfternoon.length = 0;
              }
            } else if (morningCount < morningRequired.size) pendingAfternoon.push(mark);
            else applyBase(mark);
          } else if (kind === "parent") {
            if (day >= parentRewardSince && morningCount < morningRequired.size) pendingAfternoon.push("parent");
            else applyParent();
          } else if (kind === "bonus" || kind === "video" || kind === 'repeat') {
            if (dailyReached()) applyReward(mark);
            else pendingRewards.push(mark);
          }
        }
      }
      return { minutes, bats, awards, countedVideos, pendingVideos, countedRepeats };
    }

    function getDay(day) {
      if (day < state.first || day > state.today) return null;
      if (cache.has(day)) return cache.get(day);
      let first = day;
      while (first > state.first && !cache.has(first - 1)) first--;
      for (let d = first; d <= day; d++) {
        const prior = cache.get(d - 1);
        const row = children.map((child, index) => {
          const entry = getEntry(d, index);
          const cutoff = morningCutoffFor(d, getCutoff());
          const displayed = menuFor(index, d, state.catalog);
          const paidMorning = (displayed.previousMorning || []).filter(([id]) => entry.base[id] && entry.base[id] < cutoff);
          const paidIds = new Set(paidMorning.map(([id]) => id));
          const menu = paidMorning.length ? { ...displayed, morning: displayed.morning.concat(paidMorning),
            afternoon: displayed.afternoon.filter(([id]) => !paidIds.has(id)) } : displayed;
          const { morning, afternoon } = menu;
          const max = morning.length + afternoon.length;
          const recovery = d >= (state.recoverySince === undefined ? recoveryStart : state.recoverySince);
          const pending = weekday(d) === 0 ? [] : state.syncedStart === d && state.startRecovery ? state.startRecovery[index]
            : prior ? prior[index].outstanding : [];
          const target = recovery ? ordinary : state.syncedStart === d ? Math.min(max, state.startTargets[index])
            : prior && !prior[index].met ? Math.min(max, prior[index].target + 1) : ordinary;
          const seed = demo && sampleDays[d - sampleStart];
          if (seed) {
            const total = seed[index] || 0;
            const met = total >= target;
            const outstanding = met || weekday(d) >= 5 ? pending : pending.concat(d);
            return { target, score: total, raw: total, total, met, outstanding, restored: [], remarks: 0, parentPoints: 0, credit: { bats: 0 } };
          }
          const morningRequired = d < morningMinimumSince ? new Set(morning.map(([id]) => id)) : requiredMorningIds;
          const morningDone = [...morningRequired].filter(id => own(entry.base, id)).length;
          const morningMet = morningDone === morningRequired.size;
          const earlyTasks = morning.filter(([id]) => entry.base[id] && entry.base[id] < cutoff);
          const onTime = earlyTasks.filter(([id]) => morningRequired.has(id)).length;
          const morningMinutes = onTime === morningRequired.size ? earlyTasks.length * 3 : 0;
          const morningExtraMinutes = morningMinutes ? (earlyTasks.length - onTime) * 3 : 0;
          const marked = new Set((morningMet ? morning.concat(afternoon) : morning)
            .filter(([id]) => own(entry.base, id)).map(([id]) => id));
          const done = marked.size;
          const score = Math.max(0, done + entry.parentPoints - entry.remarks);
          const met = morningMet && score >= target;
          const restored = recovery && met ? pending.slice(0, score - target) : [];
          const remaining = pending.slice(restored.length);
          const outstanding = met || weekday(d) >= 5 ? remaining : remaining.concat(d);
          const rewardsOpen = met && (!recovery || remaining.length === 0);
          const credit = creditFor(entry, target, recovery ? pending.length : 0, met, marked, menu, morningRequired, d);
          const rewards = rewardsOpen ? menu.rewards.filter(([id]) => entry.rewards.includes(id)).length + credit.countedVideos + credit.countedRepeats : 0;
          return { entry, morningRequired, morningDone, morningMet, onTime, morningMinutes, morningExtraMinutes, morningCutoff: cutoff,
            done, score, target, met, credit,
            restored, outstanding, recoveryLeft: recovery ? remaining.length : 0, rewardsOpen,
            raw: done + entry.parentPoints + rewards, total: score + rewards, remarks: entry.remarks, parentPoints: entry.parentPoints };
        });
        cache.set(d, row);
      }
      return cache.get(day);
    }

    const info = index => getDay(state.today)[index];

    function longGoalProgress(index) {
      const goal = state.longGoal;
      if (!goal || goal.start > state.today) return null;
      const saved = goal.carry[index];
      let streak = saved.streak;
      let earned = saved.earned;
      let carried = saved.surplus || 0;
      let missUsed = Boolean(saved.missUsed);
      let missCount = saved.missCount === undefined ? Number(missUsed) : saved.missCount;
      const allowedSkips = goal.allowedSkips === undefined ? 1 : goal.allowedSkips;
      const start = Math.max(goal.start, state.syncedStart || state.first);
      for (let day = start; day < state.today && !earned; day++) {
        const row = getDay(day);
        const points = carried + (row ? row[index].score : 0);
        const met = points >= goal.points;
        carried = met ? points - goal.points : 0;
        if (met) {
          streak++;
        } else if (streak > 0 && day >= goal.skipSince && missCount < allowedSkips) {
          missCount++;
          missUsed = true;
        } else {
          streak = 0;
          missUsed = false;
          missCount = 0;
        }
        earned = streak >= goal.days;
      }
      const todayPoints = info(index).score + carried;
      const todayMet = todayPoints >= goal.points;
      if (!earned && todayMet) streak++;
      return { streak, earned, todayMet, carried, todayPoints, missUsed, missCount,
        skipEnabled: state.today >= goal.skipSince, surplus: Math.max(0, todayPoints - goal.points) };
    }

    function weekStatus(day, index, through = state.today, readDay = getDay) {
      if (day > through) return "future";
      const row = readDay(day);
      if (!row) return "future";
      if (row[index].met) return "done";
      const last = Math.min(through, monday(day) + 6);
      for (let d = day + 1; d <= last; d++) {
        const later = readDay(d);
        if (later && later[index].restored.includes(day)) return "restored";
      }
      return day === state.today ? "today" : "missed";
    }

    function weekTotal(index, through = state.today) {
      const first = monday(through);
      return weekdayShort.slice(0, 5).reduce((sum, _, i) => {
        const status = weekStatus(first + i, index, through);
        return sum + (status === "done" || status === "restored" ? 1 : 0);
      }, 0);
    }

    function weekend(index) {
      const saturday = monday(state.today) + 5;
      const saturdayRow = getDay(saturday);
      return {
        saturday: state.today >= saturday && weekTotal(index, saturday) === 5,
        sunday: state.today === saturday + 1 && Boolean(saturdayRow && saturdayRow[index].met) && weekTotal(index) === 5
      };
    }

    function weekValues(index) {
      let videos = 0;
      let repeats = 0;
      let bats = 0;
      for (let d = monday(state.today); d <= state.today; d++) {
        const row = getDay(d);
        if (row) {
          const credit = row[index].credit;
          videos += getEntry(d, index).videos;
          repeats += Object.values(getEntry(d, index).repeatables || {}).reduce((sum, count) => sum + count, 0);
          bats += credit.bats;
        }
      }
      return { videos, repeats, bats };
    }
    return { getDay, info, longGoalProgress, weekStatus, weekTotal, weekValues, weekend, cache };
  }

  window.FamilyRules = { dayMs, utcOffset, ordinary, minuteLimit, morningCutoff, weekdayShort, weekdayLong,
    morningTasks, bonusTasks, children, sampleStart, timeNow, realDay, date, weekday, monday, dateText,
    blank, dayTasks, awardRate, menuFor, videoRate, splitReward, offer, afternoonTaskRate, chartHeight, dayColumn, longGoalStatus,
    longGoalCells, longGoalTodayText, morningCutoffFor, morningTimeText, entertainmentCutoff, createStats };
})();

const assert = require("node:assert/strict");
const { test } = require("node:test");

global.window = {};
require("../web/family-config.js");
require("../web/rules.js");
const { blank, createStats, menuFor, morningTimeText } = window.FamilyRules;
const firstNewDay = Date.UTC(2026, 10, 17) / 86400000;
const firstMorningDay = firstNewDay - 1;
const minimum = ["bed", "teeth", "dress", "breakfast", "car"];
const extra = "sport-kit";
const afterSchool = ["clothes", "toys", "dish-out"];

function stats(day, marks, afternoonRateCutover) {
  const menus = [0, 1, 2].map(index => menuFor(index, day));
  menus[0].morning = [...menus[0].morning, [extra, "Собрать спортивную форму"]];
  const entry = blank();
  for (const [task, time] of marks) {
    entry.base[task] = time;
    entry.order.push("base:" + task);
  }
  const state = { first: day, today: day, catalog: [[day, menus]], afternoonRateCutover,
    records: { [day]: [entry, blank(), blank()] } };
  return createStats(state, () => "07:10").info(0);
}

const early = tasks => tasks.map(task => [task, "06:45"]);

test("only the five assigned essentials determine the morning minimum", () => {
  for (const [description, marks, required, onTime, minutes, score] of [
    ["four essentials and the extra", early(minimum.slice(0, 4).concat(extra)), 4, 4, 0, 4],
    ["all essentials", early(minimum), 5, 5, 15, 5],
    ["early moved task", early(minimum.concat(extra)), 5, 5, 15, 6],
    ["late moved task", [...early(minimum), [extra, "07:25"]], 5, 5, 15, 6],
    ["essential at the cutoff", [...early(minimum.slice(0, 4).concat(extra)), ["car", "07:10"]], 5, 4, 0, 6]
  ]) {
    const data = stats(firstNewDay, marks);
    assert.deepEqual([...data.morningRequired], minimum, description);
    assert.deepEqual([data.morningDone, data.onTime, data.morningMinutes, data.morningExtraMinutes],
      [required, onTime, minutes, 0], description);
    assert.equal(data.score, score, description);
  }
  const complete = stats(firstMorningDay, early(minimum.concat(extra)));
  assert.equal(morningTimeText(complete), "18 мин · из них 3 за доп. дела");
});

test("the new minimum unlocks waiting marks and a moved task earns the daytime rate", () => {
  const marks = [...early(afterSchool), ...early(minimum)];
  const historical = stats(firstMorningDay - 1, marks);
  assert.deepEqual([historical.morningRequired.size, historical.score, historical.morningMinutes, historical.credit.minutes],
    [6, 5, 0, 0]);
  const previousGrant = stats(firstMorningDay - 1, early(minimum.concat(extra)));
  assert.deepEqual([previousGrant.morningMinutes, previousGrant.morningExtraMinutes], [18, 0]);
  const updated = stats(firstMorningDay, marks);
  assert.deepEqual([updated.score, updated.morningMinutes, updated.credit.minutes], [8, 15, 10]);
  const withLateExtra = stats(firstNewDay, [...marks, [extra, "19:25"]]);
  assert.deepEqual([withLateExtra.score, withLateExtra.morningMinutes, withLateExtra.credit.minutes], [9, 15, 15]);
});

test("weekend and school-day cutoffs are evaluated by local date", () => {
  const saturday = firstNewDay + 4;
  for (const day of [saturday, saturday + 1]) {
    const beforeNine = stats(day, minimum.map(task => [task, "08:59"]));
    assert.deepEqual([beforeNine.onTime, beforeNine.morningMinutes, beforeNine.morningCutoff], [5, 15, "09:00"]);
    assert.equal(stats(day, minimum.map(task => [task, "09:00"])).morningMinutes, 0);
  }
  for (const day of [saturday - 7, saturday + 2]) {
    const late = stats(day, minimum.map(task => [task, "08:00"]));
    assert.deepEqual([late.onTime, late.morningMinutes, late.morningCutoff], [0, 0, "07:10"]);
  }
});

test("after-school rates follow each queued task and preserve past payouts", () => {
  const tasks = ["wash", "school", "clothes", "toys", "dish-in", "trash", "dish-out", "bins-and-bags"];
  const marks = [...early(tasks), ...early(minimum)];
  const current = stats(firstNewDay, marks);
  assert.deepEqual([current.credit.minutes, current.credit.bats], [30, 20]);
  assert.equal(current.credit.awards.get("base:clothes"), "+5 мин");
  assert.equal(current.credit.awards.get("base:dish-in"), "+10 мин");
  assert.equal(current.credit.awards.get("base:trash"), "+10 мин");
  assert.equal(current.credit.awards.get("base:bins-and-bags"), "+10 жет.");
  const prior = stats(firstNewDay - 1, marks);
  assert.deepEqual([prior.credit.minutes, prior.credit.bats], [30, 30]);
  assert.equal(prior.credit.awards.get("base:clothes"), "+10 мин");
});

test("the higher after-school rate covers the agreed exceptions", () => {
  const rate = window.FamilyRules.afternoonTaskRate;
  for (const [id, title, expected] of [
    ["shoes", "Расставить обувь в гараже", 5],
    ["custom-piano", "Позаниматься на фортепиано", 10],
    ["custom-vest", "Повесить светоотражающий жилет", 10],
    ["custom-bins", "Вымыть мусорное ведро", 10],
    ["custom-dish", "Разобрать посудомойку", 10],
    ["custom-uniform", "Повесить школьный жилет", 5]
  ]) assert.equal(rate(firstNewDay, id, title, 10), expected);
});

test("when prices change during a day, earlier earned amounts keep their old rate", () => {
  const day = firstNewDay - 1;
  const cutover = { day, minute: 20 * 60 + 30 };
  const marked = [...early(minimum.concat(extra)), ["wash", "17:30"], ["school", "17:31"],
    ["clothes", "20:29"], ["toys", "20:30"]];
  const result = stats(day, marked, cutover);
  assert.equal(result.credit.awards.get("base:clothes"), "+10 мин");
  assert.equal(result.credit.awards.get("base:toys"), "+5 мин");
  const rate = window.FamilyRules.afternoonTaskRate;
  assert.equal(rate(day, "toys", "Убрать игрушки", 10, cutover), 5);
  assert.equal(rate(day, "custom-piano", "Позаниматься на фортепиано", 10, cutover), 10);
});

test("each child's creative video earns minutes after the reward gate, then tokens", () => {
  const day = firstNewDay;
  const menus = [0, 1, 2].map(index => ({
    ...menuFor(index, day), rewards: [["fill-limit", "Заполнить лимит", 30]]
  }));
  for (const [i, expected] of [15, 10, 10].entries()) {
    const entry = blank();
    for (const task of minimum.concat(["wash", "toys"])) {
      entry.base[task] = "06:45";
      entry.order.push("base:" + task);
    }
    const records = { [day]: [blank(), blank(), blank()] };
    records[day][i] = entry;
    const state = { first: day, today: day, catalog: [[day, menus]], records };
    entry.order.push("video");
    const beforeLimit = createStats(state, () => "07:10").info(i).credit;
    assert.deepEqual([beforeLimit.minutes, beforeLimit.bats, beforeLimit.pendingVideos], [expected, 0, 0]);
    entry.order.splice(-1, 0, "bonus:fill-limit");
    const afterLimit = createStats(state, () => "07:10").info(i).credit;
    assert.deepEqual([afterLimit.minutes, afterLimit.bats, afterLimit.pendingVideos], [30, expected, 0]);
  }
});

test("21:00 entertainment cutoff applies on Monday to Thursday and Sunday", () => {
  const cutoff = window.FamilyRules.entertainmentCutoff;
  assert.equal(cutoff(firstMorningDay - 1), "");
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => cutoff(firstMorningDay + i)),
    ["21:00", "21:00", "21:00", "21:00", "", "", "21:00"]);
});

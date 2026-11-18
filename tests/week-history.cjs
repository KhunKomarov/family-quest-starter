const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const catalog = require("../sync/catalog.json");

const date = new Date("2026-11-30T09:00:00Z");
const today = Math.floor(date.getTime() / 86400000);
const first = today - 21;
const start = today - 13;
const goalStart = first + 4;
const [menu] = catalog.at(-1)[1];
const tasks = menu.morning.concat(menu.afternoon).map(([id]) => id);

function snapshot({ withSaturday, sunday = 10, monday = 6, skipSince }) {
  const cells = [];
  for (const day of [today - 3, today - 2, today - 1, today]) {
    const count = day === today ? monday : day === today - 1 ? Math.min(sunday, 10)
      : day === today - 2 && !withSaturday ? 7 : 10;
    tasks.slice(0, count).forEach((task, index) => {
      const at = day * 86400000 + 3600000 + index;
      cells.push([day, 0, task, at, 1, 0, String(index), ""]);
    });
  }
  const adjustments = Array.from({ length: sunday - 10 }, (_, index) =>
    [today - 1, 0, 1, (today - 1) * 86400000 + 7200000 + index, String(index)]);
  const archive = day => [
    day === first ? 6 : day === first + 1 ? 9 : 0, 7, 0, 0,
    day === first + 1, day === first + 1 ? [first] : []
  ];
  return {
    today, first, start, catalog, cells, daily: [], adjustments, acknowledged: [],
    cutoff: "07:10", recoverySince: first,
    startTargets: [7, 7, 7], startRecovery: [[start - 1], [], []], wallets: [50, 0, 0],
    longGoal: { start: goalStart, skipSince, points: 10, days: 10,
      carry: Array.from({ length: 3 }, () => ({ streak: 0, earned: false })) },
    calendarHistory: Array.from({ length: start - first }, (_, index) => {
      const day = first + index;
      return [day, [archive(day), [0, 7, 0, 0, false, []], [0, 7, 0, 0, false, []]]];
    })
  };
}

test("TV week navigation preserves the current streak, wallet and journal", async () => {
  const browser = await chromium.launch({ executablePath: process.env.FAMILY_TEST_CHROME });
  try {
    for (const scenario of [
      { withSaturday: true, expected: "3 / 10 дней" },
      { withSaturday: false, expected: "1 / 10 дней" },
      { withSaturday: false, sunday: 19, expected: "2 / 10 дней · +5 на завтра", todayFill: "100%", tomorrowFill: "50%" },
      { withSaturday: false, sunday: 19, monday: 0, expected: "1 / 10 дней", todayFill: "90%" },
      { withSaturday: false, sunday: 20, monday: 0, expected: "2 / 10 дней" },
      { withSaturday: false, skipSince: today, sunday: 19, expected: "2 / 10 дней · +5 на завтра · есть 1 пропуск" },
      { withSaturday: false, skipSince: today - 2, expected: "2 / 10 дней · пропуск использован" },
      { withSaturday: false, skipSince: today - 2, sunday: 0, monday: 10, expected: "1 / 10 дней · есть 1 пропуск" },
      { withSaturday: false, skipSince: today - 2, monday: 0, expected: "2 / 10 дней · пропуск использован" }
    ]) {
      const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
      await page.clock.setFixedTime(date);
      await page.addInitScript(canonical => {
        window.requests = [];
        window.FamilyQuestSync = {
          enabled: () => true, car: () => false, scope: () => "test",
          exchange(body) {
            window.requests.push(JSON.parse(body));
            window.familyQuestSyncResult(200, JSON.stringify(canonical));
          }
        };
      }, snapshot(scenario));
      await page.goto(pathToFileURL(resolve(__dirname, "../web/index.html")).href);
      const { expected } = scenario;
      await page.evaluate(() => window.familyTvStart());
      const range = () => page.locator("[data-week-range]").textContent();
      const streak = () => page.locator(".cal-long-goal-child span").first().textContent();
      const go = key => page.evaluate(key => window.familyTvRemote(key), key);
      const stored = () => page.evaluate(() => localStorage.getItem("family-quest-starter-v1"));
      const before = await stored();
      assert.equal(await range(), "30 ноября — 6 декабря 2026");
      assert.equal(await streak(), expected);
      if (scenario.todayFill) {
        const cells = page.locator(".cal-long-goal-child").first();
        const todayCell = cells.locator('i[data-phase="today"]');
        const tomorrowCell = cells.locator('i[data-phase="tomorrow"]');
        assert.equal(await todayCell.evaluate(cell => cell.style.getPropertyValue("--carry")), "90%");
        assert.equal(await todayCell.evaluate(cell => cell.style.getPropertyValue("--fill")), scenario.todayFill);
        if (scenario.tomorrowFill) {
          assert.equal(await tomorrowCell.evaluate(cell => cell.style.getPropertyValue("--fill")), scenario.tomorrowFill);
        } else {
          assert.equal(await tomorrowCell.count(), 0);
        }
      }
      await go("ArrowDown");
      await go("ArrowDown");
      assert.equal(await page.locator(":focus").getAttribute("data-child"), "2");
      await go("ArrowUp");
      assert.equal(await page.locator(":focus").getAttribute("data-child"), "1");
      await go("ArrowUp");
      assert.equal(await page.locator(":focus").getAttribute("data-child"), "0");
      assert.ok(await page.locator('[data-week-nav="1"]').isDisabled());
      await go("ArrowUp");
      assert.equal(await page.locator(":focus").getAttribute("data-week-nav"), "-1");
      await go("ArrowDown");
      assert.equal(await page.locator(":focus").getAttribute("data-child"), "0");
      await go("ArrowUp");
      assert.equal(await page.locator(":focus").getAttribute("data-week-nav"), "-1");
      await go("Enter");
      assert.equal(await range(), "23–29 ноября 2026");
      await go("Enter");
      assert.equal(await range(), "16–22 ноября 2026");
      await go("Enter");
      assert.equal(await range(), "9–15 ноября 2026");
      assert.equal(await page.locator(".cal-day").first().locator("output").first().textContent(), "6");
      assert.equal(await page.locator(".cal-week-mark").first().getAttribute("data-status"), "restored");
      assert.equal(await streak(), expected);
      assert.ok(await page.locator('[data-week-nav="-1"]').isDisabled());
      assert.equal(await page.locator(":focus").getAttribute("data-week-nav"), "0");
      await go("ArrowDown");
      assert.equal(await page.locator(":focus").getAttribute("data-child"), "0");
      await go("ArrowUp");
      assert.equal(await page.locator(":focus").getAttribute("data-week-nav"), "0");
      await go("ArrowRight");
      await go("Enter");
      assert.equal(await range(), "16–22 ноября 2026");
      await go("ArrowLeft");
      await go("Enter");
      assert.equal(await range(), "30 ноября — 6 декабря 2026");
      assert.equal(await stored(), before);
      await page.evaluate(() => window.familyTvRefresh());
      assert.ok((await page.evaluate(() => window.requests)).every(request => !request.operations.length));
      assert.equal(await stored(), before);
      await page.reload();
      await page.evaluate(() => window.familyTvStart());
      assert.equal(await streak(), expected);
      assert.equal(JSON.parse(await stored()).sync.canonical.wallets[0], 50);
      await page.locator("[data-child='2']").click();
      assert.ok(await page.locator(".quest-task-picture").first().isVisible());
      await page.close();
    }
    const fresh = await browser.newPage();
    await fresh.clock.setFixedTime(date);
    await fresh.goto(pathToFileURL(resolve(__dirname, "../web/index.html")).href);
    await fresh.evaluate(() => window.familyTvStart());
    assert.equal(await fresh.locator("[data-week-nav]:disabled").count(), 3);
    await fresh.evaluate(() => window.familyTvRemote("ArrowUp"));
    assert.equal(await fresh.locator(":focus").getAttribute("data-child"), "0");
  } finally {
    await browser.close();
  }
});

test("the remote reaches a completed task at the end of the daily list without remarking it", async () => {
  const browser = await chromium.launch({ executablePath: process.env.FAMILY_TEST_CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 400 } });
    await page.clock.setFixedTime(date);
    const state = snapshot({ withSaturday: true, monday: 4 });
    const kit = "11111111111111111111111111111111";
    state.catalog = structuredClone(state.catalog);
    state.catalog.at(-1)[1][0].morning.push([kit, "Собрать спортивную форму"]);
    state.cells.push([today, 0, kit, date.getTime(), 1, 0, "kit-mark", ""]);
    await page.addInitScript(canonical => {
      window.requests = [];
      window.FamilyQuestSync = {
        enabled: () => true, car: () => false, scope: () => "test",
        exchange(body) {
          window.requests.push(JSON.parse(body));
          window.familyQuestSyncResult(200, JSON.stringify(canonical));
        }
      };
    }, state);
    await page.goto(pathToFileURL(resolve(__dirname, "../web/index.html")).href);
    await page.evaluate(() => window.familyTvStart());
    const go = key => page.evaluate(key => window.familyTvRemote(key), key);
    await go("Enter");
    await go("ArrowLeft");
    await go("ArrowRight");
    const chores = page.locator("#quest-day button");
    const kitRow = chores.last();
    assert.equal(await kitRow.getAttribute("data-base"), kit);
    assert.equal(await kitRow.getAttribute("aria-pressed"), "true");
    assert.equal(await kitRow.getAttribute("aria-disabled"), "true");
    for (let i = 0, count = await chores.count(); i < count; i++) await go("ArrowDown");
    assert.equal(await page.locator(":focus").getAttribute("data-base"), kit);
    assert.ok(await kitRow.evaluate(row => row.getBoundingClientRect().top < innerHeight));
    await go("Enter");
    assert.equal(await kitRow.getAttribute("aria-pressed"), "true");
    assert.ok((await page.evaluate(() => window.requests)).every(request => !request.operations.length));
  } finally {
    await browser.close();
  }
});

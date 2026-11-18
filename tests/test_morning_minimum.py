import sys
import json
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import family


class MorningMinimumTest(unittest.TestCase):
    def test_video_uses_each_childs_rate_before_and_after_the_limit(self):
        day = family.MORNING_WINDOWS_SINCE
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)
            with family.transaction(database) as db:
                menus = family.menus_on(family.read_catalog(db), day)
            for menu, rate in zip(menus, [15, 10, 10]):
                with self.subTest(rate=rate, video=menu["video"]):
                    menu["rewards"] = [["fill", "Заполнить лимит", 30]]
                    required = family.REQUIRED_MORNING_IDS
                    basic = [task for task, _ in menu["morning"] if task in required] + ["wash", "toys"]
                    video = "video:" + "1" * 32
                    for awards, minutes, bats in [([video], rate, 0), (["bonus:fill", video], 30, rate)]:
                        marks = [(i, str(i), task) for i, task in enumerate(basic + awards)]
                        result = family.daily_reward(marks, menu, day, 7, required, required, set(basic))
                        self.assertEqual(result, (True, bats, 0, minutes))

    def test_mixed_afternoon_rewards_preserve_history_and_task_order(self):
        start = family.AFTERNOON_RATES_SINCE
        for day, expected_wallet in [(start - 1, 50), (start, 40)]:
            with self.subTest(day=day), tempfile.TemporaryDirectory() as directory:
                database = Path(directory) / "journal.sqlite3"
                family.initialize(database)
                with family.transaction(database, write=True) as db:
                    family.set_first(db, day)
                    menus = family.menus_on(family.read_catalog(db), day)
                    menu = menus[0]
                    menu["morning"] = [row for row in menu["morning"] if row[0] in family.REQUIRED_MORNING_IDS]
                    titles = {
                        "piano": "Позаниматься на фортепиано",
                        "reflective-vest": "Надел светоотражающий жилет перед выездом из деревни",
                    }
                    known = {task for task, _ in menu["afternoon"]}
                    menu["afternoon"].extend([task, title] for task, title in titles.items() if task not in known)
                    tasks = ["wash", "school", "clothes", "toys", "dish-in", "trash", "dish-out",
                             "piano", "reflective-vest", "bins-and-bags"]
                    tasks.extend(task for task, _ in menu["morning"])
                    for index, task in enumerate(tasks):
                        at = day * family.DAY - family.OFFSET + (7 * 60 + index) * 60_000
                        family.put_cell(db, day, 0, task, at, True, False, str(index), "")
                with family.transaction(database) as db:
                    result = family.snapshot(db, day, parent=True, catalog=[(day, menus)])
                    self.assertEqual(result["wallets"][0], expected_wallet)
                    self.assertEqual(next(row["earned"] for row in result["familyLink"]
                                          if row["child"] == 0 and row["kind"] == "youtube"), 30)

    def test_afternoon_cutover_does_not_reprice_existing_marks(self):
        day = family.AFTERNOON_RATES_SINCE - 1
        cutover = {"day": day, "minute": 20 * 60 + 30}
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)
            with family.transaction(database, write=True) as db:
                family.set_first(db, day)
                db.execute("INSERT INTO family_meta VALUES ('afternoon-rate-cutover', ?)", (json.dumps(cutover),))
                menus = family.menus_on(family.read_catalog(db), day)
                morning = [task for task, _ in menus[0]["morning"]]
                tasks = [(task, 400 + i) for i, task in enumerate(morning)]
                tasks += [("wash", 1040), ("school", 1041), ("clothes", 1229), ("toys", 1230)]
                for i, (task, minute) in enumerate(tasks):
                    at = day * family.DAY - family.OFFSET + minute * 60_000
                    family.put_cell(db, day, 0, task, at, True, False, str(i), "")
            with family.transaction(database) as db:
                snapshot = family.snapshot(db, day, parent=True, catalog=[(day, menus)])
                self.assertEqual(snapshot["afternoonRateCutover"], cutover)
                youtube = next(row for row in snapshot["familyLink"] if row["child"] == 0 and row["kind"] == "youtube")
                self.assertEqual(youtube["earned"], (len(morning) - 5) * 10 + 15)

    def test_family_link_entitlement_and_history(self):
        first_minimum = family.MORNING_MINIMUM_SINCE
        first_new = family.MORNING_WINDOWS_SINCE
        required = ("bed", "teeth", "dress", "breakfast", "car")
        extra = "sport-kit"
        cutoff = 7 * 60 + 10
        saturday = first_new + 4
        early = [(task, 405 + i) for i, task in enumerate(required)]
        after_school = [("clothes", 387), ("toys", 388), ("dish-out", 389)]
        scenarios = [
            ("old minimum without the extra", first_minimum - 1, early + after_school, 0, 0),
            ("old minimum with the extra", first_minimum - 1, early + [(extra, 415)], 18, 0),
            ("five on the transition day", first_minimum, early + after_school, 15, 10),
            ("four plus the extra", first_new, early[:4] + [(extra, 415)], 0, 0),
            ("five without the extra", first_new, early, 15, 0),
            ("previously earned extra preserved", first_minimum, early + [(extra, 415)], 18, 0),
            ("early moved task", first_new, early + [(extra, 415)], 15, 0),
            ("late extra", first_new, early + [(extra, 445)], 15, 0),
            ("essential at the cutoff", first_new, early[:4] + [("car", cutoff), (extra, 415)], 0, 0),
            ("afternoon gating", first_new, early + after_school + [(extra, 445)], 15, 15),
            ("weekend before eight", saturday, early[:4] + [("car", 460)], 15, 0),
            ("weekend after eight", saturday, early[:4] + [("car", 525)], 15, 0),
            ("weekend at nine", saturday, early[:4] + [("car", 540)], 0, 0),
        ]
        for label, day, tasks, morning, youtube in scenarios:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                database = Path(directory) / "journal.sqlite3"
                family.initialize(database)
                with family.transaction(database, write=True) as db:
                    family.set_first(db, day)
                    menus = family.menus_on(family.read_catalog(db), day)
                    menus[0]["morning"].append([extra, "Собрать спортивную форму"])
                    for index, (task, minute) in enumerate(tasks):
                        at = day * family.DAY - family.OFFSET + minute * 60_000
                        family.put_cell(db, day, 0, task, at, True, False, str(index), "")
                with family.transaction(database) as db:
                    snapshot = family.snapshot(db, day, parent=True, catalog=[(day, menus)])
                    grants = {row["kind"]: row["earned"] for row in snapshot["familyLink"] if row["child"] == 0}
                    self.assertEqual(grants, {kind: minutes for kind, minutes in
                                              [("morning", morning), ("youtube", youtube)] if minutes})
                    self.assertEqual(snapshot["wallets"], [0, 0, 0])
                    midnight = day * family.DAY - family.OFFSET
                    if morning:
                        reward = next(row for row in snapshot["familyLink"] if row["child"] == 0 and row["kind"] == "morning")
                        if day < first_new:
                            self.assertNotIn("availableAt", reward)
                            self.assertNotIn("expiresAt", reward)
                        else:
                            release = {"weekend before eight": 480, "weekend after eight": 525}.get(label, 430)
                            expiry = 600 if day == saturday else 510
                            self.assertEqual(reward["availableAt"], midnight + release * 60_000)
                            self.assertEqual(reward["expiresAt"], midnight + expiry * 60_000)
                    if youtube:
                        reward = next(row for row in snapshot["familyLink"] if row["child"] == 0 and row["kind"] == "youtube")
                        self.assertEqual(reward["expiresAt"], midnight + 21 * 3_600_000)


if __name__ == "__main__":
    unittest.main()

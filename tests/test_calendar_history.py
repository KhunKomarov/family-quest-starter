import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import family


class CalendarHistoryTest(unittest.TestCase):
    def test_goal_tracks_carry_and_one_skip_until_midnight(self):
        first = family.LONG_GOAL["start"]
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)
            with family.transaction(database, write=True) as db:
                family.set_first(db, first)
                scores = [
                    [10, 7, 19, 6] + [10] * 8,
                    [0, 0, 19, 6, 0] + [10] * 8,
                    [0, 0, 19, 6, 0, 10, 0, 10],
                ]
                for child, history in enumerate(scores):
                    for offset, score in enumerate(history):
                        day = first + offset
                        db.executemany("INSERT INTO family_adjustments VALUES (?, ?, ?, 1, ?, 1)",
                                       [(f"{child}-{day}-{point}", day, child, day * family.DAY + point)
                                        for point in range(score)])
            with family.transaction(database) as db:
                before_midnight = family.snapshot(db, first + 11, parent=True)
                after_midnight = family.snapshot(db, first + 12, parent=True)
                archived = family.snapshot(db, first + 3 + family.WINDOW - 1)
                after_first_skip = family.snapshot(db, first + 5 + family.WINDOW - 1)
                after_second_skip = family.snapshot(db, first + 7 + family.WINDOW - 1)
                self.assertFalse(any(item["kind"] == "long-goal" for item in before_midnight["familyLink"]))
                self.assertFalse(any(item["kind"] == "long-goal" for item in after_midnight["familyLink"]))
                self.assertEqual(archived["longGoal"]["carry"][0],
                                 {"streak": 1, "earned": False, "surplus": 9, "missUsed": False})
                self.assertEqual(after_first_skip["longGoal"]["carry"][1],
                                 {"streak": 2, "earned": False, "surplus": 0, "missUsed": True})
                self.assertEqual(after_second_skip["longGoal"]["carry"][2],
                                 {"streak": 0, "earned": False, "surplus": 0, "missUsed": False})
                after_archive = family.snapshot(db, first + 12 + family.WINDOW - 1)
                self.assertTrue(after_archive["longGoal"]["carry"][0]["earned"])
                self.assertFalse(after_archive["longGoal"]["carry"][1]["earned"])
                final_archive = family.snapshot(db, first + 13 + family.WINDOW - 1)
                self.assertTrue(final_archive["longGoal"]["carry"][1]["earned"])
                self.assertEqual(after_midnight["wallets"], [0, 0, 0])
                self.assertEqual(after_midnight, family.snapshot(db, first + 12, parent=True))

    def test_archive_boundary_keeps_recovery_and_does_not_change_balances(self):
        monday = family.LONG_GOAL["start"] + 3
        today = monday + family.WINDOW
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)
            with family.transaction(database, write=True) as db:
                family.set_first(db, monday)
                catalog = family.read_catalog(db)
                menu = family.menus_on(catalog, monday)[0]
                morning = [key for key, _ in menu["morning"]]
                afternoon = [key for key, _ in menu["afternoon"]]
                for day, tasks in (
                    (monday, morning[:-1] + afternoon[:2]),
                    (monday + 1, morning + afternoon[:3]),
                ):
                    for i, task in enumerate(tasks):
                        at = day * family.DAY + i
                        family.put_cell(db, day, 0, task, at, True, False, str(i), "")
                db.execute("INSERT INTO family_adjustments VALUES (?, ?, 0, -1, ?, 1)",
                           ("remark", monday, monday * family.DAY + 10))
                db.execute("INSERT INTO family_adjustments VALUES (?, ?, 0, 1, ?, 1)",
                           ("praise", monday + 1, (monday + 1) * family.DAY + 10))
            with family.transaction(database) as db:
                partial = family.snapshot(db, today)
                complete = family.snapshot(db, today + 1)
                monday_row = dict(partial["calendarHistory"])[monday][0]
                tuesday_row = dict(complete["calendarHistory"])[monday + 1][0]
                self.assertEqual(monday_row, [len(morning) - 2, 7, 1, 0, False, []])
                self.assertEqual(tuesday_row, [len(morning) + 4, 7, 0, 1, True, [monday]])
                self.assertEqual(partial["startRecovery"][0], [monday])
                self.assertEqual(partial["wallets"], complete["wallets"])
                self.assertEqual(complete, family.snapshot(db, today + 1))
                self.assertNotIn("calendarHistory", family.snapshot(db, today, parent=True))
                self.assertTrue(all(row[0] >= partial["start"] for row in partial["cells"]))


if __name__ == "__main__":
    unittest.main()

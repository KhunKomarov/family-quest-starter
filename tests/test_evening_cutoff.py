import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import family


class EveningCutoffTest(unittest.TestCase):
    def test_weekday_deadlines(self):
        monday = family.ENTERTAINMENT_CUTOFF_SINCE
        self.assertIsNone(family.youtube_deadline(monday - 1))
        for offset, hour in enumerate((21, 21, 21, 21, 24, 24, 21)):
            day = monday + offset
            self.assertEqual(family.youtube_deadline(day), day * family.DAY - family.OFFSET + hour * 3_600_000)

    def test_cannot_record_new_youtube_issuance_at_cutoff(self):
        day = family.ENTERTAINMENT_CUTOFF_SINCE
        cutoff = family.youtube_deadline(day)
        tasks = ["bed", "teeth", "dress", "breakfast", "car", "wash", "school", "dish-out"]
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)
            with family.transaction(database, write=True) as db:
                family.set_first(db, day)
                for index, task in enumerate(tasks):
                    family.put_cell(db, day, 0, task, cutoff - 3_600_000 + index, True, False, str(index), "")
            action = {"id": "a" * 32, "action": "family-link-issued", "day": day, "child": 0,
                      "kind": "youtube", "minutes": 10, "expected": 0}
            with patch.object(family, "now_ms", return_value=cutoff):
                with self.assertRaisesRegex(family.Conflict, "reward window closed"):
                    family.parent_action(database, "test", action)
            with patch.object(family, "now_ms", return_value=cutoff - 1):
                confirmed = family.parent_action(database, "test", action)
            with patch.object(family, "now_ms", return_value=cutoff):
                retry = family.parent_action(database, "test", action)
            self.assertEqual(confirmed["familyLink"], retry["familyLink"])
            self.assertEqual(retry["familyLink"][0]["issued"], 10)

    def test_morning_issuance_is_only_recorded_inside_its_window(self):
        day = family.MORNING_WINDOWS_SINCE
        midnight = day * family.DAY - family.OFFSET
        opens = midnight + (7 * 60 + 10) * 60_000
        closes = midnight + (8 * 60 + 30) * 60_000
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)
            with family.transaction(database, write=True) as db:
                family.set_first(db, day)
                for index, task in enumerate(sorted(family.REQUIRED_MORNING_IDS)):
                    family.put_cell(db, day, 0, task, opens - 60_000 + index, True, False, str(index), "")
            action = {"id": "b" * 32, "action": "family-link-issued", "day": day, "child": 0,
                      "kind": "morning", "minutes": 15, "expected": 0}
            for stamp, reason in ((opens - 1, "reward window has not opened"), (closes, "reward window closed")):
                with patch.object(family, "now_ms", return_value=stamp):
                    with self.assertRaisesRegex(family.Conflict, reason):
                        family.parent_action(database, "test", action)
            with patch.object(family, "now_ms", return_value=opens):
                result = family.parent_action(database, "test", action)
            self.assertEqual(result["familyLink"][0]["issued"], 15)


if __name__ == "__main__":
    unittest.main()

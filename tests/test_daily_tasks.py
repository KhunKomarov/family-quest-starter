import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import family


class DailyTasksTest(unittest.TestCase):
    def test_capacity_counts_every_task_even_when_edited_titles_match(self):
        day = family.MORNING_MINIMUM_SINCE
        with tempfile.TemporaryDirectory() as directory, patch.object(
            family, "now_ms", return_value=day * family.DAY
        ):
            database = Path(directory) / "journal.sqlite3"
            family.initialize(database)

            def action(index, action_name, **fields):
                return family.parent_action(database, "audit",
                                            {"id": f"{index:032x}", "day": day, "action": action_name, **fields})

            original = action(1, "daily-add", titles=[f"Дело {i}" for i in range(family.DAILY_TASK_LIMIT)])
            _, target, title = original["daily"][1]
            common_title = original["daily"][0][2]
            action(2, "daily-edit", target=target, expected=title, title=common_title)
            with self.assertRaises(ValueError):
                action(3, "daily-add", titles=["Лишнее дело"])
            action(4, "daily-remove", target=target, expected=common_title)
            latest = action(5, "daily-add", titles=["Допустимое дело"])
            self.assertEqual(len(latest["daily"]), family.DAILY_TASK_LIMIT)


if __name__ == "__main__":
    unittest.main()

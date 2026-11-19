from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sync"))
import family
class RewardOverflowTest(unittest.TestCase):
    def test_every_unit_is_kept_without_rewriting_previous_days(self):
        day = family.REWARD_OVERFLOW_SINCE
        for minutes in range(31):
            for rate in [1, 5, 10, 15, 30, 60, 120]:
                earned, coins = family.split_reward(rate, minutes, day)
                self.assertEqual(earned + coins, rate)
                self.assertLessEqual(minutes + earned, 30)
                old_earned, old_coins = family.split_reward(rate, minutes, day - 1)
                self.assertEqual(old_earned, earned)
                self.assertEqual(old_coins, rate if minutes == 30 else 0)
        self.assertEqual(family.split_reward(15, 25, day), (5, 10))
        self.assertEqual(family.split_reward(60, 0, day), (30, 30))

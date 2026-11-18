import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sync'))
import configuration
import family
import goals


def timestamp(text):
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp() * 1000)


def goal(kind='weekly', start=None, **values):
    return {'id': 'a' * 32, 'kind': kind, 'startedAt': start or timestamp('2026-11-18T08:30:00'),
            'durationDays': 7 if kind == 'weekly' else 30 if kind == 'monthly' else 14,
            'title': 'Пробная цель', 'reward': 'Выбрать прогулку', 'points': 10, 'days': 5,
            'allowedSkips': 2, 'allowOneSkip': True, **values}


class GoalsTest(unittest.TestCase):
    def test_weekly_and_monthly_periods_start_at_creation_and_recur(self):
        start = timestamp('2026-11-18T08:30:00')
        definition = goal(start=start)
        self.assertEqual(goals.window(definition, start + 7 * goals.DAY - 1, 0), (start, start + 7 * goals.DAY))
        self.assertEqual(goals.window(definition, start + 7 * goals.DAY, 0), (start + 7 * goals.DAY, start + 14 * goals.DAY))
        definition = goal('monthly', timestamp('2028-01-31T09:15:00'))
        self.assertEqual(goals.window(definition, timestamp('2028-02-29T09:15:00'), 7 * 3600000),
                         (timestamp('2028-02-29T09:15:00'), timestamp('2028-03-31T09:15:00')))

    def test_skip_budget_is_numeric_and_independent_per_child(self):
        start = timestamp('2026-11-18T00:00:00')
        first = start // goals.DAY
        config = {'utcOffsetMinutes': 0, 'childGoals': [[goal(start=start)], [goal(start=start, allowedSkips=1)]]}
        scores = [10, 0, 0, 10]
        rows = goals.evaluate(config, start + 4 * goals.DAY + 12 * 3600000, first,
                              lambda day, child, begin, end: {'score': scores[day-first] if day-first < len(scores) else 0,
                                                              'morningMet': True})
        self.assertEqual([(row['streak'], row['missCount']) for row in rows], [(2, 2), (1, 0)])

    def test_different_children_take_different_steps_and_carry_partial_points(self):
        start = timestamp('2026-11-18T00:00:00')
        config = {'utcOffsetMinutes': 0, 'childGoals': [[goal(start=start, points=5)], [goal(start=start, points=10)]]}
        rows = goals.evaluate(config, start + 12 * 3600000, start // goals.DAY,
                              lambda *args: {'score': 12, 'morningMet': True, 'extra': 0})
        self.assertEqual([row['streak'] for row in rows], [2, 1])
        self.assertEqual(rows[0]['cells'][2]['fill'], 40)
        self.assertEqual(rows[1]['cells'][1]['fill'], 20)
        blocked = goals.evaluate(config, start + 12 * 3600000, start // goals.DAY,
                                 lambda *args: {'score': 20, 'morningMet': False, 'extra': 50})
        self.assertEqual([row['streak'] for row in blocked], [0, 0])

    def test_individual_goal_finishes_without_automatic_restart(self):
        start = timestamp('2026-11-18T00:00:00')
        config = {'utcOffsetMinutes': 0, 'childGoals': [[goal('individual', start, durationDays=2, days=2)]]}
        rows = goals.evaluate(config, start + 10 * goals.DAY, start // goals.DAY,
                              lambda *args: {'score': 20, 'morningMet': True})
        self.assertTrue(rows[0]['earned'])
        self.assertTrue(rows[0]['expired'])
        self.assertEqual(rows[0]['windowStart'], start)
        self.assertEqual(rows[0]['streak'], 2)

    def test_only_server_can_start_a_new_goal_and_period_changes_restart_it(self):
        base = json.loads((ROOT / 'config/family.json').read_text())
        base['childGoals'] = [[goal(start=timestamp('2001-01-01T00:00:00'))], [], []]
        now = timestamp('2026-11-18T12:00:00')
        candidate = configuration.start_new_goals(configuration.validate_config(base), None, now)
        self.assertEqual(candidate['childGoals'][0][0]['startedAt'], now)
        edited = copy.deepcopy(candidate)
        edited['childGoals'][0][0]['title'] = 'Новое название'
        configuration.start_new_goals(edited, candidate, now + 10000)
        self.assertEqual(edited['childGoals'][0][0]['startedAt'], now)
        edited['childGoals'][0][0]['kind'] = 'individual'
        edited['childGoals'][0][0]['durationDays'] = 8
        configuration.start_new_goals(edited, candidate, now + 10000)
        self.assertEqual(edited['childGoals'][0][0]['startedAt'], now + 10000)


class RepeatableTest(unittest.TestCase):
    def test_multiple_marks_are_idempotent_and_parent_can_reject_and_restore_one(self):
        now = timestamp('2026-11-18T12:00:00')
        day = family.day_of(now)
        with tempfile.TemporaryDirectory() as directory, patch.object(family, 'now_ms', return_value=now):
            database = Path(directory) / 'journal.sqlite3'
            family.initialize(database)
            result = family.parent_action(database, 'test', {'id': secrets.token_hex(16), 'day': day,
                'action': 'catalog-add', 'section': 'repeatables', 'children': [0], 'title': 'Собрать модель', 'rate': 12})
            menu = family.menus_on(result['catalog'], day)[0]
            task = menu['repeatables'][0][0]
            self.assertFalse(family.menus_on(result['catalog'], day)[1].get('repeatables'))
            operations = []
            for index, identifier in enumerate([row[0] for row in menu['morning'] + menu['afternoon'][:2]]):
                operations.append({'id': secrets.token_hex(16), 'day': day, 'child': 0, 'task': identifier,
                                   'at': now + index, 'checked': True, 'guard': ''})
            for index in range(4):
                operation = secrets.token_hex(16)
                operations.append({'id': operation, 'day': day, 'child': 0, 'task': f'repeat:{task}:{operation}',
                                   'at': now + 100 + index, 'checked': True, 'guard': ''})
            snapshot = family.sync_device(database, 'tv', {'operations': operations})
            self.assertEqual(snapshot['wallets'][0], 12)
            duplicate = family.sync_device(database, 'tv', {'operations': operations})
            self.assertEqual(duplicate['wallets'], snapshot['wallets'])
            self.assertEqual(len(duplicate['cells']), len(snapshot['cells']))
            mark = next(row for row in snapshot['cells'] if row[2] == operations[-1]['task'])
            rejected = family.parent_action(database, 'test', {'id': secrets.token_hex(16), 'day': day,
                'child': 0, 'task': mark[2], 'action': 'reject', 'version': mark[6]})
            self.assertEqual(rejected['wallets'][0], 0)
            locked = next(row for row in rejected['cells'] if row[2] == mark[2])
            restored = family.parent_action(database, 'test', {'id': secrets.token_hex(16), 'day': day,
                'child': 0, 'task': mark[2], 'action': 'restore-video', 'version': locked[6]})
            self.assertEqual(restored['wallets'][0], 12)
            malformed = dict(operations[-1], id=secrets.token_hex(16), task='repeat:unknown:' + secrets.token_hex(16))
            final = family.sync_device(database, 'tv', {'operations': [malformed]})
            self.assertEqual(final['wallets'][0], 12)


if __name__ == '__main__':
    unittest.main()

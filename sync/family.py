"""Roles and canonical journal shared by the parent panel and Android clients."""

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from collections import defaultdict
from contextlib import closing, contextmanager
from copy import deepcopy
from datetime import date
from pathlib import Path

CONFIG = json.loads((Path(__file__).resolve().parents[1] / "config/family.json").read_text(encoding="utf-8"))
DAY = 86_400_000
OFFSET = CONFIG["utcOffsetMinutes"] * 60_000
WINDOW = 14
DAILY_TASK_LIMIT = 20
MORNING_CUTOFF = "07:10"
MORNING_MINIMUM_SINCE = (date(2026, 11, 16) - date(1970, 1, 1)).days
MORNING_WINDOWS_SINCE = (date(2026, 11, 17) - date(1970, 1, 1)).days
REQUIRED_MORNING_IDS = frozenset(("bed", "teeth", "dress", "breakfast", "car"))
AFTERNOON_RATES_SINCE = (date(2026, 11, 17) - date(1970, 1, 1)).days
ENTERTAINMENT_CUTOFF_SINCE = (date(2026, 11, 16) - date(1970, 1, 1)).days
HIGHER_RATE_CHORES = frozenset(("dish-out", "dish-in", "trash", "bins", "bags", "bins-and-bags", "reflective-vest"))
ID = re.compile(r"[0-9a-f]{32}")
SECRET = re.compile(r"[0-9a-f]{64}")
PARENT_CODE = re.compile(r"[0-9]{6}")
LOGIN_LIMITS = ((15 * 60_000, 6), (DAY, 20))
CHILD_COUNT = len(CONFIG['profiles'])
COMBINED_BINS_DAY = (date(2026, 11, 12) - date(1970, 1, 1)).days
COMBINED_BINS = "bins-and-bags"
OLD_BINS = {"bins", "bags"}
MINUTE_LIMIT = 30
PARENT_REWARD_SINCE = (date(2026, 11, 19) - date(1970, 1, 1)).days
PARENT_REWARD_RATE = 5
VALUE_PRIORITY_SINCE = (date(2026, 11, 19) - date(1970, 1, 1)).days
REWARD_OVERFLOW_SINCE = (date(2026, 11, 19) - date(1970, 1, 1)).days
ORDINARY = 7
RECOVERY_START = (date(2026, 11, 12) - date(1970, 1, 1)).days
TASK_SECTIONS = {"morning": "Утро", "afternoon": "Дневные дела", "rewards": "Супер дела", "repeatables": "Повторяемые дела"}
CHILD_NAMES = tuple(CONFIG["profiles"])
LONG_GOAL = {
    "start": (date(2026, 11, 13) - date(1970, 1, 1)).days,
    "skipSince": (date(2026, 11, 16) - date(1970, 1, 1)).days if CONFIG["goal"]["allowOneSkip"] else 1_000_000,
    "points": CONFIG["goal"]["points"], "days": CONFIG["goal"]["days"],
    "title": CONFIG["goal"]["title"], "reward": CONFIG["goal"]["reward"],
    'allowedSkips': CONFIG['goal'].get('allowedSkips', int(CONFIG['goal']['allowOneSkip'])),
}
FAMILY_LINK_REWARDS = {
    "morning": "Экранное время утром", "youtube": "Экранное время днём",
}


def configure(config):
    """Load the one family's validated settings at startup or initial registration."""
    from configuration import validate_config
    global CONFIG, CHILD_COUNT, CHILD_NAMES, OFFSET, LONG_GOAL
    CONFIG = validate_config(config)
    CHILD_COUNT = len(CONFIG['profiles'])
    CHILD_NAMES = tuple(CONFIG['profiles'])
    OFFSET = CONFIG['utcOffsetMinutes'] * 60_000
    LONG_GOAL = {**LONG_GOAL, 'points': CONFIG['goal']['points'], 'days': CONFIG['goal']['days'],
                 'title': CONFIG['goal']['title'], 'reward': CONFIG['goal']['reward'],
                 'skipSince': (date(2026, 11, 16) - date(1970, 1, 1)).days
                 if CONFIG['goal']['allowOneSkip'] else 1_000_000,
                 'allowedSkips': CONFIG['goal'].get('allowedSkips', int(CONFIG['goal']['allowOneSkip']))}


def now_ms():
    return int(time.time() * 1000)


def day_of(at):
    return (at + OFFSET) // DAY


def is_id(value):
    return isinstance(value, str) and ID.fullmatch(value)


def is_child(child):
    return type(child) is int and 0 <= child < CHILD_COUNT


def read_catalog(db):
    return [(since, json.loads(menus)) for since, menus in db.execute("SELECT since, menus FROM family_catalog ORDER BY since")]


def menus_on(catalog, day):
    return next(menus for since, menus in reversed(catalog) if since <= day)


def daily_menu(menu, day, previous_morning=frozenset()):
    if day < MORNING_MINIMUM_SINCE:
        return menu
    keep = REQUIRED_MORNING_IDS | previous_morning
    moved = [task for task in menu["morning"] if task[0] not in keep]
    if not moved:
        return menu
    return {**menu, "morning": [task for task in menu["morning"] if task[0] in keep],
            "afternoon": menu["afternoon"] + moved}


def add_catalog_task(db, catalog, day, identifier, body):
    section = body.get("section")
    assigned = body.get("children")
    title = text_field(body.get("title"), 120)
    if (not isinstance(section, str) or section not in TASK_SECTIONS or not title
            or not isinstance(assigned, list) or not assigned or not all(map(is_child, assigned))
            or len(set(assigned)) != len(assigned)):
        raise ValueError("invalid catalog task")
    if day >= MORNING_MINIMUM_SINCE and section == "morning":
        section = "afternoon"
    rate = body.get("rate")
    if section in ("rewards", "repeatables"):
        if type(rate) is not int or not 1 <= rate <= 120:
            raise ValueError("invalid reward rate")
        entry = [identifier, title, rate]
    else:
        if rate is not None:
            raise ValueError("rate applies only to rewards")
        entry = [identifier, title]
    # Keep previous dates intact, including the tasks used to calculate their rewards.
    versions = [(day, menus_on(catalog, day))]
    versions.extend((since, menus) for since, menus in catalog if since > day)
    for since, original in versions:
        menus = deepcopy(original)
        for child in assigned:
            menu = menus[child]
            names = {task[1].casefold() for task in daily_menu(menu, since).get(section, [])}
            if section in ("rewards", "repeatables"):
                names.add(menu["video"]["title"].casefold())
            if title.casefold() in names:
                raise DuplicateTask("task already assigned")
            menu.setdefault(section, []).append(entry)
        db.execute("INSERT OR REPLACE INTO family_catalog VALUES (?, ?)",
                   (since, json.dumps(menus, ensure_ascii=False)))
    names = ", ".join(CHILD_NAMES[child] for child in sorted(assigned))
    label = f"{title}\n{TASK_SECTIONS[section]} · {names}"
    if section in ("rewards", "repeatables"):
        label += f" · {rate} мин"
    return label


def valid_task(task, child, menu):
    if not isinstance(task, str):
        return False
    if any(task == identifier for identifier, _ in menu["morning"] + menu["afternoon"]) or (child == 1 and task in OLD_BINS | {COMBINED_BINS}):
        return True
    if task.startswith("bonus:"):
        return any(task[6:] == identifier for identifier, _, _ in menu["rewards"])
    if task.startswith("video:"):
        return is_id(task[6:])
    if task.startswith('repeat:'):
        parts = task.split(':')
        return len(parts) == 3 and is_id(parts[2]) and any(parts[1] == row[0] for row in menu.get('repeatables', []))
    return task.startswith("daily:") and is_id(task[6:])


@contextmanager
def transaction(database, write=False):
    with closing(sqlite3.connect(database, timeout=10)) as db, db:
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield db


def initialize(database):
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS family_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS family_cells (
                day INTEGER NOT NULL, child INTEGER NOT NULL, task TEXT NOT NULL,
                at INTEGER NOT NULL, checked INTEGER NOT NULL, locked INTEGER NOT NULL,
                version TEXT NOT NULL, guard TEXT NOT NULL,
                PRIMARY KEY (day, child, task)
            );
            CREATE TABLE IF NOT EXISTS family_tasks (
                id TEXT PRIMARY KEY, day INTEGER NOT NULL, title TEXT NOT NULL, active INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS family_tasks_day ON family_tasks(day);
            CREATE TABLE IF NOT EXISTS family_adjustments (
                id TEXT PRIMARY KEY, day INTEGER NOT NULL, child INTEGER NOT NULL,
                sign INTEGER NOT NULL, at INTEGER NOT NULL, active INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS family_adjustments_day ON family_adjustments(day);
            CREATE TABLE IF NOT EXISTS family_audit (
                id TEXT PRIMARY KEY, at INTEGER NOT NULL, day INTEGER NOT NULL, actor TEXT NOT NULL,
                action TEXT NOT NULL, child INTEGER, label TEXT NOT NULL, note TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS family_audit_day ON family_audit(day, at);
            CREATE TABLE IF NOT EXISTS family_receipts (id TEXT PRIMARY KEY, actor TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS family_sessions (digest TEXT PRIMARY KEY, actor TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS family_login_failures (at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS family_payouts (
                id TEXT PRIMARY KEY, child INTEGER NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0)
            );
            CREATE TABLE IF NOT EXISTS family_link_grants (
                kind TEXT NOT NULL, period INTEGER NOT NULL, child INTEGER NOT NULL,
                minutes INTEGER NOT NULL CHECK (minutes > 0),
                PRIMARY KEY (kind, period, child)
            );
            CREATE TABLE IF NOT EXISTS family_catalog (since INTEGER PRIMARY KEY, menus TEXT NOT NULL);
        """)
        if not db.execute("SELECT 1 FROM family_catalog LIMIT 1").fetchone():
            seed = json.loads(Path(__file__).with_name("catalog.json").read_text(encoding="utf-8"))
            db.executemany("INSERT OR IGNORE INTO family_catalog VALUES (?, ?)",
                           [(since, json.dumps(menus, ensure_ascii=False)) for since, menus in seed])


class Conflict(ValueError):
    pass


class InsufficientBalance(Conflict):
    pass


class DuplicateTask(Conflict):
    pass


class LoginThrottled(Exception):
    pass


def text_field(value, maximum):
    if not isinstance(value, str) or len(value.strip()) > maximum:
        raise ValueError("invalid text")
    return value.strip()


def stamp_receipt(db, identifier, actor, body):
    serialized = json.dumps(body, sort_keys=True, separators=(",", ":"))
    prior = db.execute("SELECT actor, body FROM family_receipts WHERE id=?", (identifier,)).fetchone()
    if prior is not None:
        if prior != (actor, serialized):
            raise Conflict("id conflict")
        return False
    db.execute("INSERT INTO family_receipts VALUES (?, ?, ?)", (identifier, actor, serialized))
    return True


def read_cell(db, day, child, task):
    row = db.execute(
        "SELECT at, checked, locked, version, guard FROM family_cells WHERE day=? AND child=? AND task=?",
        (day, child, task),
    ).fetchone()
    if row is not None or child != 1 or task != COMBINED_BINS or day < COMBINED_BINS_DAY:
        return row
    return merged_bins(db.execute(
        "SELECT at, checked, locked, version, guard FROM family_cells WHERE day=? AND child=1 AND task IN ('bins', 'bags')",
        (day,),
    ).fetchall())


def merged_bins(parts):
    locked = [row for row in parts if row[2]]
    if locked:
        return max(locked, key=lambda row: (row[0], row[3]))
    if len(parts) == 2 and all(row[1] for row in parts):
        return max(parts, key=lambda row: (row[0], row[3]))
    return None


def journal_cells(db, start, end):
    cells = db.execute(
        """SELECT day, child, task, at, checked, locked, version, guard FROM family_cells
           WHERE day BETWEEN ? AND ? AND (checked=1 OR guard != '' OR (child=1 AND task=?))""",
        (start, end, COMBINED_BINS),
    ).fetchall()
    parts_by_day = {}
    explicit = set()
    for day, child, task, *cell in cells:
        if child == 1 and day >= COMBINED_BINS_DAY:
            if task == COMBINED_BINS:
                explicit.add(day)
            elif task in OLD_BINS:
                parts_by_day.setdefault(day, []).append(cell)
    for day, parts in parts_by_day.items():
        if day not in explicit:
            merged = merged_bins(parts)
            if merged:
                cells.append((day, 1, COMBINED_BINS, *merged))
    return sorted((cell for cell in cells if cell[4] or cell[7]), key=lambda cell: (cell[3], cell[6]))


def put_cell(db, day, child, task, at, checked, locked, version, guard):
    db.execute("INSERT OR REPLACE INTO family_cells VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
               (day, child, task, at, checked, locked, version, guard))


def daily_title(db, day, task):
    row = db.execute("SELECT title FROM family_tasks WHERE id=? AND day=? AND active=1", (task[6:], day)).fetchone()
    return row[0] if row else None


def set_first(db, day):
    db.execute("""INSERT INTO family_meta VALUES ('first', ?) ON CONFLICT(key) DO UPDATE
                  SET value=excluded.value WHERE CAST(family_meta.value AS INTEGER) > CAST(excluded.value AS INTEGER)""", (str(day),))


def morning_cutoff(day, previous):
    if day < MORNING_WINDOWS_SINCE:
        return previous
    return "09:00" if (day + 3) % 7 >= 5 else MORNING_CUTOFF


def youtube_deadline(day):
    weekday = (day + 3) % 7
    if day >= ENTERTAINMENT_CUTOFF_SINCE and (weekday < 4 or weekday == 6):
        return day * DAY - OFFSET + 21 * 3_600_000
    if day >= MORNING_WINDOWS_SINCE:
        return (day + 1) * DAY - OFFSET
    return None


def morning_credit(day, marks, morning_ids, required_morning, cutoff_ms):
    midnight = day * DAY - OFFSET
    on_time = {task: at for at, _, task in marks if task in morning_ids and at - midnight < cutoff_ms}
    if not on_time or not required_morning <= on_time.keys():
        return {"earned": 0}
    reward = {"earned": 3 * len(on_time)}
    if day >= MORNING_WINDOWS_SINCE:
        weekend = (day + 3) % 7 >= 5
        completion = max(on_time[task] for task in required_morning)
        ready = max(midnight + 8 * 3_600_000, completion) if weekend else midnight + cutoff_ms
        expiry_hour, expiry_minute = (10, 0) if weekend else (8, 30)
        expires = midnight + (expiry_hour * 60 + expiry_minute) * 60_000
        reward.update(availableAt=ready, expiresAt=expires)
    return reward


def afternoon_task_rate(day, task, title, previous=5, cutover=None, marked_minute=None):
    if day < AFTERNOON_RATES_SINCE:
        if not cutover or cutover["day"] != day:
            return previous
        if marked_minute is not None and marked_minute < cutover["minute"]:
            return previous
    if task in HIGHER_RATE_CHORES:
        return 10
    name = title.casefold()
    dishwasher = "посудомой" in name and re.search(r"разобра|разбор|разгруз|выгруз|загруз|сложи", name)
    reflective_vest = "жилет" in name and re.search(r"светоотраж|световозвращ", name)
    piano = "фортепиано" in name or "пианино" in name
    return 10 if dishwasher or reflective_vest or piano or "мусор" in name else 5


def split_reward(rate, minutes, day):
    earned_minutes = min(rate, max(0, MINUTE_LIMIT - minutes))
    earned_coins = rate - earned_minutes if day >= REWARD_OVERFLOW_SINCE or minutes >= MINUTE_LIMIT else 0
    return earned_minutes, earned_coins


def daily_reward(marks, menu, day, target, morning_ids, required_morning, eligible, debt=0, cutover=None):
    tasks = [task for _, _, task in marks]
    marked = eligible.intersection(tasks)
    remarks = tasks.count("remark")
    score = len(marked) + tasks.count("parent") - remarks
    if not required_morning <= marked or score < target:
        return False, 0, 0, 0
    recovered = min(score - target, debt)
    if recovered < debt:
        return True, 0, recovered, 0
    reward_target = target + debt

    minutes = bats = base = morning = parents = waiting_videos = 0
    afternoon = []
    rewards = []
    rates = {identifier: rate for identifier, _, rate in menu["rewards"]}
    repeat_rates = {identifier: rate for identifier, _, rate in menu.get('repeatables', [])}
    marked_minutes = {task: ((at + OFFSET) % DAY) // 60_000 for at, _, task in marks}
    afternoon_rates = {task: afternoon_task_rate(day, task, title, menu.get("afternoonMinutes", 5),
                                                cutover, marked_minutes.get(task))
                       for task, title in menu["afternoon"]}
    video = menu["video"]
    if day >= VALUE_PRIORITY_SINCE:
        # Reserve the cheapest completed ordinary tasks for the norm and recovery.
        # The original timestamps still determine morning eligibility and task rates.
        def value_order(task):
            if task in morning_ids:
                return (0, 0, task)
            if task in marked:
                return (1, afternoon_rates.get(task, 0), task)
            if task == "parent":
                return (1, PARENT_REWARD_RATE, task)
            return (2, 0, task)
        tasks = sorted(tasks, key=value_order)

    def credit(rate):
        nonlocal minutes, bats, waiting_videos
        earned_minutes, earned_coins = split_reward(rate, minutes, day)
        minutes += earned_minutes
        bats += earned_coins
        if minutes == MINUTE_LIMIT and waiting_videos:
            bats += waiting_videos * video["bats"]
            waiting_videos = 0

    def apply_reward(task):
        nonlocal bats, waiting_videos
        if task.startswith("video:"):
            if day >= MORNING_MINIMUM_SINCE or video["minutes"]:
                credit(video["minutes"] or video["bats"])
            elif minutes == MINUTE_LIMIT:
                bats += video["bats"]
            else:
                waiting_videos += 1
        elif task.startswith('repeat:'):
            rate = repeat_rates.get(task.split(':')[1])
            if rate is not None:
                credit(rate)
        elif task[6:] in rates:
            credit(rates[task[6:]])

    def reached():
        return morning == len(required_morning) and base + parents - remarks >= reward_target

    def settle_rewards():
        if reached():
            for task in rewards:
                apply_reward(task)
            rewards.clear()

    def apply_parent():
        nonlocal parents
        parents += 1
        if (day >= PARENT_REWARD_SINCE and morning == len(required_morning)
                and base + parents - remarks > reward_target):
            credit(PARENT_REWARD_RATE)
        settle_rewards()

    def apply_base(task):
        nonlocal base
        base += 1
        rate = afternoon_rates.get(task)
        if rate and base > max(len(required_morning), reward_target + remarks - parents):
            credit(rate)
        settle_rewards()

    # Match the order in FamilyRules: early afternoon and reward marks wait for their gates.
    for task in tasks:
        if task in marked:
            if task in morning_ids:
                if task in required_morning:
                    morning += 1
                apply_base(task)
                if morning == len(required_morning) and afternoon:
                    for pending_task in afternoon:
                        if pending_task == "parent":
                            apply_parent()
                        else:
                            apply_base(pending_task)
                    afternoon.clear()
            elif morning < len(required_morning):
                afternoon.append(task)
            else:
                apply_base(task)
        elif task == "parent":
            if day >= PARENT_REWARD_SINCE and morning < len(required_morning):
                afternoon.append(task)
            else:
                apply_parent()
        elif task.startswith(("bonus:", "video:", "repeat:")):
            if reached():
                apply_reward(task)
            else:
                rewards.append(task)
    return True, bats, recovered, minutes


def reward_history(first, start, today, cells, adjustments, catalog, cutoff, afternoon_cutover=None):
    targets = [ORDINARY] * CHILD_COUNT
    window_targets = targets.copy()
    earned = [0] * CHILD_COUNT
    pending = [[] for _ in range(CHILD_COUNT)]
    window_recovery = pending.copy()
    goal_carry = [{"streak": 0, "earned": False, "surplus": 0, "missUsed": False, 'missCount': 0} for _ in range(CHILD_COUNT)]
    goal_progress = [progress.copy() for progress in goal_carry]
    grants = [{} for _ in range(CHILD_COUNT)]
    calendar_history = []
    hours, minutes = map(int, morning_cutoff(today, cutoff).split(":"))
    cutoff_ms = (hours * 60 + minutes) * 60_000
    youtube_expires = youtube_deadline(today)
    hours, minutes = map(int, morning_cutoff(MORNING_MINIMUM_SINCE, cutoff).split(":"))
    transition_cutoff_ms = (hours * 60 + minutes) * 60_000
    events = defaultdict(list)
    for day, child, task, at, checked, _, version, _ in cells:
        if checked and not task.startswith("daily:"):
            events[day, child].append((at, version, task))
    for day, child, sign, at, version in adjustments:
        events[day, child].append((at, version, "parent" if sign == 1 else "remark"))
    for day in range(first, today + 1):
        weekday = (day + 3) % 7
        if weekday == 0:
            pending = [[] for _ in range(CHILD_COUNT)]
        if day == start:
            window_recovery = [dates.copy() for dates in pending]
        recovery = day >= RECOVERY_START
        historical_row = []
        for child, original_menu in enumerate(menus_on(catalog, day)):
            marks = sorted(events.get((day, child), ()))
            previous_morning = {task for at, _, task in marks if (at + OFFSET) % DAY < transition_cutoff_ms
                                } if day == MORNING_MINIMUM_SINCE else frozenset()
            menu = daily_menu(original_menu, day, previous_morning)
            morning_ids = {task for task, _ in menu["morning"]}
            required_morning = morning_ids if day < MORNING_MINIMUM_SINCE else REQUIRED_MORNING_IDS
            eligible = morning_ids | {task for task, _ in menu["afternoon"]}
            maximum = len(eligible)
            targets[child] = ORDINARY if recovery else min(targets[child], maximum)
            if day == start:
                window_targets[child] = targets[child]
            tasks = [task for _, _, task in marks]
            track_goal = LONG_GOAL["start"] <= day < today and not goal_progress[child]["earned"]
            if day < start or track_goal:
                checked = eligible.intersection(tasks)
                if not required_morning <= checked:
                    checked &= morning_ids
                praise = tasks.count("parent")
                remarks = tasks.count("remark")
                score = max(0, len(checked) + praise - remarks)
            if track_goal:
                progress = goal_progress[child]
                threshold = LONG_GOAL["points"]
                points = score + progress["surplus"]
                met_goal = points >= threshold
                progress["surplus"] = points - threshold if met_goal else 0
                if met_goal:
                    progress["streak"] += 1
                elif progress["streak"] and day >= LONG_GOAL["skipSince"] and progress['missCount'] < LONG_GOAL['allowedSkips']:
                    progress['missCount'] += 1
                    progress["missUsed"] = True
                else:
                    progress["streak"] = 0
                    progress["missUsed"] = False
                    progress['missCount'] = 0
                progress["earned"] = progress["streak"] >= LONG_GOAL["days"]
                if day < start:
                    goal_carry[child] = progress.copy()
            debt = len(pending[child]) if recovery else 0
            met, bats, recovered, youtube = daily_reward(
                marks, menu, day, targets[child], morning_ids, required_morning, eligible, debt, afternoon_cutover)
            if day < start:
                historical_row.append([score, targets[child], remarks, praise, met, pending[child][:recovered]])
            if day == today:
                afternoon_reward = {"earned": youtube}
                if youtube_expires is not None:
                    afternoon_reward["expiresAt"] = youtube_expires
                grants[child] = {
                    "morning": morning_credit(day, marks, morning_ids, required_morning, cutoff_ms),
                    "youtube": afternoon_reward,
                }
            earned[child] += bats
            del pending[child][:recovered]
            if not met and weekday < 5:
                pending[child].append(day)
            targets[child] = ORDINARY if met else targets[child] + 1
        if historical_row:
            calendar_history.append([day, historical_row])
    return window_targets, earned, window_recovery, goal_carry, grants, calendar_history


def family_link_rewards(db, today, grants):
    issued = {(kind, child): minutes for kind, child, minutes in db.execute(
        "SELECT kind, child, minutes FROM family_link_grants WHERE period=?", (today,))}
    return [
        {"child": child, "kind": kind, **reward, "issued": issued.get((kind, child), 0)}
        for child, rewards in enumerate(grants)
        for kind, reward in rewards.items()
        if reward["earned"] or issued.get((kind, child))
    ]


def snapshot(db, today, parent=False, catalog=None):
    start = today - WINDOW + 1
    first = db.execute("SELECT value FROM family_meta WHERE key='first'").fetchone()
    daily = db.execute("SELECT day, id, title FROM family_tasks WHERE day BETWEEN ? AND ? AND active=1 ORDER BY rowid",
                       (start, today)).fetchall()
    first_day = int(first[0]) if first else today
    cells = journal_cells(db, first_day, today)
    adjustments = db.execute(
        """SELECT day, child, sign, at, id FROM family_adjustments
           WHERE day BETWEEN ? AND ? AND active=1 ORDER BY at, id""", (first_day, today)
    ).fetchall()
    if catalog is None:
        catalog = read_catalog(db)
    cutoff = MORNING_CUTOFF
    rate_change = db.execute("SELECT value FROM family_meta WHERE key='afternoon-rate-cutover'").fetchone()
    afternoon_cutover = json.loads(rate_change[0]) if rate_change else None
    targets, earned, recovery, goal_carry, grants, calendar_history = reward_history(
        first_day, start, today, cells, adjustments, catalog, cutoff, afternoon_cutover)
    spent = dict(db.execute("SELECT child, SUM(amount) FROM family_payouts GROUP BY child"))
    result = {"today": today, "start": start, "first": first_day, "startTargets": targets,
              "cutoff": cutoff, "daily": daily,
              "cells": [row for row in cells if row[0] >= start], "adjustments": [row for row in adjustments if row[0] >= start],
              "wallets": [total - spent.get(child, 0) for child, total in enumerate(earned)], "catalog": catalog,
              "recoverySince": RECOVERY_START, "startRecovery": recovery,
              "longGoal": {**LONG_GOAL, "carry": goal_carry}, 'familyConfig': CONFIG}
    if CONFIG.get('childGoals'):
        import goals
        marked_by_day = defaultdict(list)
        adjustment_by_day = defaultdict(list)
        for day, child, task, at, checked, *_ in cells:
            if checked:
                marked_by_day[day, child].append((at, task))
        for day, child, sign, at, *_ in adjustments:
            adjustment_by_day[day, child].append((at, sign))

        def goal_score(day, child, begin, end):
            menu = daily_menu(menus_on(catalog, day)[child], day)
            all_marked = {task for at, task in marked_by_day[day, child] if at < end}
            marked = {task for at, task in marked_by_day[day, child] if begin <= at < end}
            required = {task for task, _ in menu['morning']} if day < MORNING_MINIMUM_SINCE else REQUIRED_MORNING_IDS
            morning_met = required <= all_marked
            eligible = {task for task, _ in menu['morning'] + menu['afternoon']}
            adjustments_total = sum(sign for at, sign in adjustment_by_day[day, child] if begin <= at < end)
            score = max(0, len(eligible & marked) + adjustments_total)
            extra = sum(task.startswith(('bonus:', 'video:', 'repeat:')) for task in marked)
            return {'score': score, 'morningMet': morning_met, 'extra': extra}

        result['periodGoals'] = goals.evaluate(CONFIG, now_ms(), first_day, goal_score)
    if afternoon_cutover:
        result["afternoonRateCutover"] = afternoon_cutover
    if parent:
        result["familyLink"] = family_link_rewards(db, today, grants)
        result["audit"] = db.execute(
            """SELECT id, at, day, actor, action, child, label, note FROM family_audit
               WHERE day BETWEEN ? AND ? ORDER BY at DESC, rowid DESC LIMIT 500""", (start, today)
        ).fetchall()
    else:
        result["calendarHistory"] = calendar_history
    return result


def sync_device(database, device, body):
    if not isinstance(body, dict) or set(body) != {"operations"}:
        raise ValueError("invalid sync")
    operations = body.get("operations")
    if not isinstance(operations, list) or len(operations) > 200:
        raise ValueError("invalid batch")
    at = now_ms()
    today = day_of(at)
    with transaction(database, write=True) as db:
        catalog = read_catalog(db)
        set_first(db, today)
        acknowledged = []
        for op in operations:
            if not isinstance(op, dict) or set(op) != {"id", "day", "child", "task", "at", "checked", "guard"}:
                raise ValueError("invalid mark")
            identifier, day, child, task, when, checked, guard = (op[k] for k in ("id", "day", "child", "task", "at", "checked", "guard"))
            if (not is_id(identifier) or type(day) is not int or not is_child(child) or not isinstance(task, str)
                    or type(when) is not int or when < 946_684_800_000 or when > at + 300_000
                    or day != day_of(when) or not 6 <= ((when + OFFSET) % DAY) // 3_600_000 < 23
                    or type(checked) is not bool or not (guard == "" or is_id(guard))):
                raise ValueError("invalid mark")
            acknowledged.append(identifier)
            if not stamp_receipt(db, identifier, "device:" + device, op):
                continue
            # Only a parent can remove an existing mark.
            if not checked or not today - WINDOW < day <= today:
                continue
            if not valid_task(task, child, menus_on(catalog, day)[child]):
                continue
            if task.startswith("daily:") and not daily_title(db, day, task):
                continue
            prior = read_cell(db, day, child, task)
            if guard != (prior[4] if prior else "") or (prior and (prior[1] or prior[2] or (when, identifier) <= (prior[0], prior[3]))):
                continue
            put_cell(db, day, child, task, when, checked, False, identifier, guard)
            set_first(db, day)
        result = snapshot(db, today, catalog=catalog)
        result["acknowledged"] = acknowledged
        return result


def parent_action(database, actor, body):
    if not isinstance(body, dict) or not is_id(body.get("id")):
        raise ValueError("invalid action")
    identifier = body["id"]
    at = now_ms()
    today = day_of(at)
    day, child, action = (body.get(key) for key in ("day", "child", "action"))
    if type(day) is not int or not today - WINDOW < day <= today:
        raise ValueError("invalid day")
    note = text_field(body.get("note", ""), 500)
    label = ""
    with transaction(database, write=True) as db:
        catalog = read_catalog(db)
        if not stamp_receipt(db, identifier, "parent:" + actor, body):
            return snapshot(db, today, parent=True, catalog=catalog)
        if action in ("point", "remark"):
            if not is_child(child) or not note:
                raise ValueError("reason required")
            sign = 1 if action == "point" else -1
            db.execute("INSERT INTO family_adjustments VALUES (?, ?, ?, ?, ?, 1)", (identifier, day, child, sign, at))
        elif action == "wallet-payout":
            amount = body.get("amount")
            if not is_child(child) or type(amount) is not int or amount <= 0:
                raise ValueError("invalid payout")
            if amount > snapshot(db, today, catalog=catalog)["wallets"][child]:
                raise InsufficientBalance("insufficient balance")
            db.execute("INSERT INTO family_payouts VALUES (?, ?, ?)", (identifier, child, amount))
            label = f"−{amount} жет."
            day = today
        elif action == "family-link-issued":
            kind = body.get("kind")
            if not is_child(child) or not isinstance(kind, str) or kind not in FAMILY_LINK_REWARDS:
                raise ValueError("invalid screen-time reward")
            if day != today:
                raise Conflict("reward date changed")
            rewards = snapshot(db, today, parent=True, catalog=catalog)["familyLink"]
            reward = next((entry for entry in rewards if entry["child"] == child and entry["kind"] == kind), None)
            minutes = body.get("minutes")
            expected = body.get("expected")
            if (type(minutes) is not int or type(expected) is not int or not reward
                    or minutes != reward["earned"] or expected != reward["issued"] or minutes <= expected):
                raise Conflict("reward changed")
            if at < reward.get("availableAt", at):
                raise Conflict("reward window has not opened")
            if at >= reward.get("expiresAt", at + 1):
                raise Conflict("reward window closed")
            db.execute("INSERT OR REPLACE INTO family_link_grants VALUES (?, ?, ?, ?)", (kind, today, child, minutes))
            label = f"{FAMILY_LINK_REWARDS[kind]} · {minutes - expected} мин"
        elif action == "undo":
            target = body.get("target")
            row = db.execute("SELECT child, sign, active FROM family_adjustments WHERE id=? AND day=?", (target, day)).fetchone()
            if not row or not row[2]:
                raise Conflict("already cancelled")
            child, sign, _ = row
            db.execute("UPDATE family_adjustments SET active=0 WHERE id=?", (target,))
            label = "Баллы +1" if sign == 1 else "Замечание −1"
        elif action in ("reject", "reopen", "restore-video"):
            task = body.get("task")
            if not is_child(child) or not valid_task(task, child, menus_on(catalog, day)[child]):
                raise ValueError("invalid task")
            video = task.startswith(("video:", "repeat:"))
            if action == "restore-video" and not video:
                raise ValueError("not a video mark")
            label = daily_title(db, day, task) if task.startswith("daily:") else task
            if not label:
                raise Conflict("task removed")
            if task.startswith("daily:"):
                label = "daily:" + label
            prior = read_cell(db, day, child, task)
            reject = action == "reject"
            if not prior or prior[3] != body.get("version") or not prior[1 if reject else 2]:
                raise Conflict("mark changed")
            when = prior[0] if video else max(at, prior[0] + 1)
            put_cell(db, day, child, task, when, action == "restore-video", reject, identifier, identifier)
        elif action == "catalog-add":
            if day != today:
                raise Conflict("catalog date changed")
            label = add_catalog_task(db, catalog, day, identifier, body)
            catalog = read_catalog(db)
            child = None
        elif action == "daily-add":
            if (day != today or not isinstance(body.get("titles"), list)
                    or not 1 <= len(body["titles"]) <= DAILY_TASK_LIMIT):
                raise ValueError("invalid list")
            active = [title for (title,) in db.execute("SELECT title FROM family_tasks WHERE day=? AND active=1", (day,))]
            seen = set(active)
            new = []
            for value in body["titles"]:
                title = text_field(value, 250)
                if title and title not in seen:
                    seen.add(title)
                    new.append(title)
            if len(active) + len(new) > DAILY_TASK_LIMIT or not new:
                raise ValueError("invalid list")
            for title in new:
                db.execute("INSERT INTO family_tasks VALUES (?, ?, ?, 1)", (secrets.token_hex(16), day, title))
            child = None
            label = "\n".join(new)
        elif action in ("daily-edit", "daily-remove"):
            if day != today or not is_id(body.get("target")):
                raise ValueError("invalid task")
            target = body["target"]
            prior = daily_title(db, day, "daily:" + target)
            if not prior or prior != body.get("expected"):
                raise Conflict("task changed")
            child = None
            if action == "daily-remove":
                db.execute("UPDATE family_tasks SET active=0 WHERE id=?", (target,))
                label = prior
            else:
                label = text_field(body.get("title"), 250)
                if not label:
                    raise ValueError("title required")
                db.execute("UPDATE family_tasks SET title=? WHERE id=?", (label, target))
        else:
            raise ValueError("unknown action")
        db.execute("INSERT INTO family_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   (identifier, at, day, actor, action, child, label, note))
        set_first(db, day)
        return snapshot(db, today, parent=True, catalog=catalog)


def login(database, parents, token):
    if not isinstance(token, str) or not PARENT_CODE.fullmatch(token):
        return None
    now = now_ms()
    with transaction(database, write=True) as db:
        db.execute("DELETE FROM family_login_failures WHERE at <= ?", (now - DAY,))
        for window, maximum in LOGIN_LIMITS:
            count, = db.execute("SELECT count(*) FROM family_login_failures WHERE at > ?", (now - window,)).fetchone()
            if count >= maximum:
                raise LoginThrottled
        actor = next((name for name, code in parents.items() if hmac.compare_digest(token, code)), None)
        if not actor:
            db.execute("INSERT INTO family_login_failures VALUES (?)", (now,))
            return None
        session = secrets.token_hex(32)
        db.execute("DELETE FROM family_sessions WHERE expires <= ?", (now,))
        db.execute("INSERT INTO family_sessions VALUES (?, ?, ?)",
                   (hashlib.sha256(session.encode()).hexdigest(), actor, now + 30 * DAY))
    return session


def session_actor(database, parents, session, logout=False):
    if not SECRET.fullmatch(session):
        return None
    digest = hashlib.sha256(session.encode()).hexdigest()
    with transaction(database, write=logout) as db:
        if logout:
            db.execute("DELETE FROM family_sessions WHERE digest=?", (digest,))
            return None
        row = db.execute("SELECT actor FROM family_sessions WHERE digest=? AND expires > ?", (digest, now_ms())).fetchone()
        return row[0] if row and row[0] in parents else None

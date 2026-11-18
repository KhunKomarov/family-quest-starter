"""Per-child recurring and individual goals, anchored to their creation time."""
from calendar import monthrange
from datetime import datetime, timezone

DAY = 86_400_000


def month_at(anchor, months, offset):
    local = datetime.fromtimestamp((anchor + offset) / 1000, timezone.utc)
    year, month0 = divmod(local.year * 12 + local.month - 1 + months, 12)
    shifted = local.replace(year=year, month=month0 + 1, day=min(local.day, monthrange(year, month0 + 1)[1]))
    return int(shifted.timestamp() * 1000) - offset


def window(goal, now, offset):
    anchor = goal['startedAt']
    if goal['kind'] == 'monthly':
        start_date = datetime.fromtimestamp((anchor + offset) / 1000, timezone.utc)
        current = datetime.fromtimestamp((now + offset) / 1000, timezone.utc)
        index = max(0, (current.year - start_date.year) * 12 + current.month - start_date.month)
        if month_at(anchor, index, offset) > now and index:
            index -= 1
        return month_at(anchor, index, offset), month_at(anchor, index + 1, offset)
    duration = (7 if goal['kind'] == 'weekly' else goal['durationDays']) * DAY
    index = max(0, (now - anchor) // duration) if goal['kind'] == 'weekly' else 0
    return anchor + index * duration, anchor + (index + 1) * duration


def evaluate(config, now, first, score_for):
    results = []
    offset = config['utcOffsetMinutes'] * 60000
    today = (now + offset) // DAY
    for child, assigned in enumerate(config.get('childGoals', [])):
        for goal in assigned:
            if 'startedAt' not in goal or now < goal['startedAt']:
                continue
            begin, end = window(goal, now, offset)
            threshold, target = goal['points'], goal['days']
            allowed = goal.get('allowedSkips', int(goal.get('allowOneSkip', False)))
            expired = goal['kind'] == 'individual' and now >= end
            last = min(today, (end - 1 + offset) // DAY)
            closed_until = last + 1 if expired else today
            steps = carry = missed = 0
            earned = False
            for day in range(max((begin + offset) // DAY, first), closed_until):
                row = score_for(day, child, begin, end)
                raw = row['score'] if row['morningMet'] else 0
                points = carry + raw + (row.get('extra', 0) if raw >= threshold else 0)
                gained = points // threshold
                if gained:
                    steps += gained
                    carry = points % threshold
                elif steps and missed < allowed:
                    missed += 1
                    carry = 0
                else:
                    steps = carry = missed = 0
                if steps >= target:
                    earned = True
                    break
            row = score_for(today, child, begin, end) if not expired else {'score': 0, 'morningMet': False}
            raw = row['score'] if row['morningMet'] else 0
            points = carry + raw + (row.get('extra', 0) if raw >= threshold else 0)
            confirmed, base_earned = min(steps, target), earned
            if not earned and not expired:
                steps += points // threshold
                earned = steps >= target
            complete = min(steps, target)
            remainder = 0 if earned or expired else points % threshold
            cells = [{'phase': 'complete' if index < confirmed else 'today' if index <= complete else 'future',
                      'fill': 100 if index < complete else remainder / threshold * 100 if index == complete else 0}
                     for index in range(target)]
            results.append({**goal, 'child': child, 'windowStart': begin, 'windowEnd': end,
                            'streak': complete, 'earned': earned, 'expired': expired,
                            'missCount': missed, 'allowedSkips': allowed, 'todayPoints': points,
                            'carried': carry, 'confirmed': confirmed, 'baseEarned': base_earned, 'cells': cells})
    return results

"""One-use invitation registration. All family settings commit in one SQLite transaction."""

import base64
from contextlib import closing
import hashlib
import hmac
import io
import json
from pathlib import Path
import re
import sqlite3
import time

from configuration import validate_config, validate_catalog


class InvalidInvitation(ValueError):
    pass


def initialize(database, invitation_file=None):
    with closing(sqlite3.connect(database)) as db, db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS family_registration (
                id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL, expires INTEGER NOT NULL, consumed INTEGER
            );
            CREATE TABLE IF NOT EXISTS family_settings (
                id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, parents TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS family_photos (child INTEGER PRIMARY KEY, png BLOB NOT NULL);
        ''')
        if invitation_file and Path(invitation_file).is_file() and not db.execute(
            'SELECT 1 FROM family_settings LIMIT 1'
        ).fetchone():
            seed = json.loads(Path(invitation_file).read_text())
            if not re.fullmatch(r'[0-9a-f]{64}', seed.get('digest', '')) or type(seed.get('expires')) is not int:
                raise ValueError('invalid invitation seed')
            db.execute('''INSERT INTO family_registration VALUES(1,?,?,NULL)
                ON CONFLICT(id) DO UPDATE SET digest=excluded.digest, expires=excluded.expires
                WHERE family_registration.consumed IS NULL''', (seed['digest'], seed['expires']))


def settings(database):
    with closing(sqlite3.connect(database)) as db:
        row = db.execute('SELECT config,parents FROM family_settings WHERE id=1').fetchone()
    return (json.loads(row[0]), json.loads(row[1])) if row else None


def pending(database):
    with closing(sqlite3.connect(database)) as db:
        return bool(db.execute('SELECT 1 FROM family_registration WHERE id=1 AND consumed IS NULL').fetchone())


def check_invitation(db, token):
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
        raise InvalidInvitation('invitation unavailable')
    row = db.execute('SELECT digest,expires,consumed FROM family_registration WHERE id=1').fetchone()
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not row or not hmac.compare_digest(row[0], digest) or row[1] <= int(time.time()) or row[2] is not None:
        raise InvalidInvitation('invitation unavailable')


def verify(database, token):
    with closing(sqlite3.connect(database)) as db:
        check_invitation(db, token)


def normalize_photo(encoded):
    if encoded is None or encoded == '':
        return None
    if not isinstance(encoded, str) or len(encoded) > 400_000:
        raise ValueError('photo must be a small image')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError('invalid photo') from error
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('PNG', 'JPEG', 'WEBP') or image.width * image.height > 1_048_576:
                raise ValueError('photo dimensions or format not supported')
            image.load()
            result = ImageOps.fit(ImageOps.exif_transpose(image).convert('RGB'), (256, 256))
            clean = Image.new('RGB', (256, 256))
            clean.paste(result)
            output = io.BytesIO()
            clean.save(output, format='PNG', optimize=True)
            return output.getvalue()
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as error:
        raise ValueError('invalid photo') from error


def validate_registration(body):
    if not isinstance(body, dict) or body.get('consent') is not True:
        raise ValueError('hosting consent required')
    config = validate_config(body.get('config'))
    catalog = [[0, body.get('menus')]]
    validate_catalog(catalog, len(config['profiles']))
    people = body.get('parents')
    if not isinstance(people, list) or not 1 <= len(people) <= 2:
        raise ValueError('one or two parents required')
    parents = {}
    for person in people:
        if not isinstance(person, dict):
            raise ValueError('invalid parent')
        name, code = person.get('name'), person.get('code')
        if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 40 or name.strip() in parents
                or not isinstance(code, str) or not re.fullmatch(r'[0-9]{6}', code) or code in parents.values()):
            raise ValueError('parents need distinct names and six-digit codes')
        parents[name.strip()] = code
    photos = body.get('photos')
    if not isinstance(photos, list) or len(photos) != len(config['profiles']):
        raise ValueError('one photo or avatar choice per child required')
    return config, catalog, parents, [normalize_photo(photo) for photo in photos]


def register(database, body):
    verify(database, body.get('token') if isinstance(body, dict) else None)
    config, catalog, parents, photos = validate_registration(body)
    with closing(sqlite3.connect(database, timeout=10)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        check_invitation(db, body.get('token'))
        for table in ('family_cells', 'family_tasks', 'family_adjustments', 'family_payouts', 'family_audit'):
            if db.execute(f'SELECT 1 FROM {table} LIMIT 1').fetchone():
                raise ValueError('registration cannot replace an existing journal')
        db.execute('INSERT INTO family_settings VALUES(1,?,?)',
                   (json.dumps(config, ensure_ascii=False), json.dumps(parents, ensure_ascii=False)))
        db.execute('DELETE FROM family_catalog')
        db.executemany('INSERT INTO family_catalog VALUES(?,?)',
                       [(since, json.dumps(menus, ensure_ascii=False)) for since, menus in catalog])
        db.execute('DELETE FROM family_sessions')
        db.execute('DELETE FROM family_login_failures')
        db.execute("DELETE FROM family_meta WHERE key='first'")
        db.executemany('INSERT INTO family_photos VALUES(?,?)',
                       [(index, photo) for index, photo in enumerate(photos) if photo is not None])
        db.execute('UPDATE family_registration SET consumed=? WHERE id=1', (int(time.time()),))
    return config, parents


def photo(database, child):
    with closing(sqlite3.connect(database)) as db:
        row = db.execute('SELECT png FROM family_photos WHERE child=?', (child,)).fetchone()
    return bytes(row[0]) if row else None

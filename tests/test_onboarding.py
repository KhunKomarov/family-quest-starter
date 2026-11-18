import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import copy
import hashlib
import http.client
import io
import json
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sync'))
import family
import onboarding


def registration(token, count=2):
    config = json.loads((ROOT / 'config/family.json').read_text())
    config['profiles'] = [f'Ребёнок {index + 1}' for index in range(count)]
    config['utcOffsetMinutes'] = 180
    menu = json.loads((ROOT / 'sync/catalog.json').read_text())[-1][1][0]
    return {'token': token, 'consent': True, 'config': config,
            'menus': [copy.deepcopy(menu) for _ in range(count)], 'photos': [None] * count,
            'parents': [{'name': 'Первый родитель', 'code': '246810'},
                        {'name': 'Второй родитель', 'code': '135790'}]}


class OnboardingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.database = self.directory / 'journal.sqlite3'
        self.token = secrets.token_urlsafe(32)
        self.invitation = self.directory / 'invitation.json'
        self.invitation.write_text(json.dumps({'digest': hashlib.sha256(self.token.encode()).hexdigest(),
                                              'expires': int(time.time()) + 3600}))
        family.initialize(self.database)
        onboarding.initialize(self.database, self.invitation)

    def test_registration_is_single_use_even_with_simultaneous_submissions(self):
        def attempt(_):
            try:
                onboarding.register(self.database, registration(self.token))
                return True
            except onboarding.InvalidInvitation:
                return False
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(attempt, range(2))), [False, True])
        self.assertEqual(onboarding.settings(self.database)[0]['profiles'], ['Ребёнок 1', 'Ребёнок 2'])
        self.assertFalse(onboarding.pending(self.database))
        with self.assertRaises(onboarding.InvalidInvitation):
            onboarding.verify(self.database, self.token)

    def test_expired_or_wrong_link_cannot_read_or_register(self):
        with self.assertRaises(onboarding.InvalidInvitation):
            onboarding.verify(self.database, secrets.token_urlsafe(32))
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE family_registration SET expires=0')
        with self.assertRaises(onboarding.InvalidInvitation):
            onboarding.register(self.database, registration(self.token))
        self.assertIsNone(onboarding.settings(self.database))

    def test_invalid_photo_or_parent_codes_does_not_consume_invitation(self):
        body = registration(self.token)
        body['photos'][0] = base64.b64encode(b'<svg onload="alert(1)"></svg>').decode()
        with self.assertRaises(ValueError):
            onboarding.register(self.database, body)
        body = registration(self.token)
        body['parents'][1]['code'] = body['parents'][0]['code']
        with self.assertRaises(ValueError):
            onboarding.register(self.database, body)
        onboarding.verify(self.database, self.token)
        self.assertIsNone(onboarding.settings(self.database))

    def test_existing_journal_cannot_be_replaced(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT INTO family_tasks VALUES(?,0,'existing',1)", (secrets.token_hex(16),))
        with self.assertRaises(ValueError):
            onboarding.register(self.database, registration(self.token))
        self.assertIsNone(onboarding.settings(self.database))

    def test_photos_are_resized_and_metadata_removed(self):
        from PIL import Image, PngImagePlugin
        buffer = io.BytesIO()
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text('Private', 'must not be retained')
        Image.new('RGB', (512, 300), '#57884c').save(buffer, format='PNG', pnginfo=metadata)
        body = registration(self.token, 1)
        body['photos'][0] = base64.b64encode(buffer.getvalue()).decode()
        onboarding.register(self.database, body)
        data = onboarding.photo(self.database, 0)
        with Image.open(io.BytesIO(data)) as image:
            self.assertEqual(image.size, (256, 256))
            self.assertNotIn('Private', image.info)

    def test_http_setup_persists_family_and_private_download_across_restart(self):
        tokens = {'tv': secrets.token_hex(32)}
        (self.directory / 'devices.json').write_text(json.dumps(tokens))
        (self.directory / 'parents.json').write_text(json.dumps({'Old parent': '555666'}))
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = 'https://registered.example.test'
        command = [sys.executable, str(ROOT / 'sync/server.py'), '--database', str(self.database),
                   '--tokens', str(self.directory / 'devices.json'), '--parents', str(self.directory / 'parents.json'),
                   '--origin', origin, '--port', str(port), '--invitation-file', str(self.invitation)]
        process = None
        def start():
            nonlocal process
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1):
                        return
                except OSError:
                    self.assertIsNone(process.poll())
                    time.sleep(.02)
            self.fail('server did not start')
        def request(path, body=None, cookie=None, origin_header=origin):
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            headers = {'Origin': origin_header, 'Content-Type': 'application/json'}
            if cookie:
                headers['Cookie'] = cookie
            try:
                connection.request('POST' if body is not None else 'GET', path,
                                   json.dumps(body) if body is not None else None, headers)
                response = connection.getresponse()
                return response.status, dict(response.getheaders()), response.read()
            finally:
                connection.close()
        try:
            start()
            self.assertEqual(request('/parent/')[0], 303)
            self.assertEqual(request('/setup/api/preview', {'token': self.token}, origin_header='https://foreign.test')[0], 403)
            self.assertEqual(request('/setup/api/preview', {'token': self.token})[0], 200)
            self.assertEqual(request('/parent/api/connection')[0], 401)
            status, headers, _ = request('/setup/api/register', registration(self.token))
            self.assertEqual(status, 200)
            cookie = headers['Set-Cookie'].split(';')[0]
            self.assertEqual(request('/setup/api/register', registration(self.token))[0], 410)
            self.assertEqual(request('/parent/avatar/0.png')[0], 401)
            self.assertEqual(request('/parent/api/connection')[0], 401)
            status, _, data = request('/parent/api/connection', cookie=cookie)
            self.assertEqual(status, 200)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                config = json.loads(archive.read('config/family.json'))
                self.assertEqual(len(config['profiles']), 2)
                self.assertIn('web/avatar-2.png', archive.namelist())
                self.assertNotIn('web/avatar-3.png', archive.namelist())
                self.assertNotIn('connection/parent-codes.json', archive.namelist())
            status, _, payload = request('/parent/api/settings', cookie=cookie)
            self.assertEqual(status, 200)
            settings = json.loads(payload)
            custom = {'id': 'f' * 32, 'kind': 'weekly', 'durationDays': 7, 'title': 'Своя неделя',
                      'reward': 'Семейная прогулка', 'points': 8, 'days': 3, 'allowedSkips': 2,
                      'startedAt': 946684800000}
            update = {'id': secrets.token_hex(16), 'expected': settings['revision'],
                      'goal': {**settings['config']['goal'], 'allowedSkips': 3}, 'childGoals': [[custom], []]}
            before = int(time.time() * 1000)
            status, _, payload = request('/parent/api/settings', update, cookie=cookie)
            self.assertEqual(status, 200)
            changed = json.loads(payload)
            started = changed['config']['childGoals'][0][0]['startedAt']
            self.assertGreaterEqual(started, before)
            self.assertEqual(changed['config']['goal']['allowedSkips'], 3)
            retry = request('/parent/api/settings', update, cookie=cookie)
            self.assertEqual(retry[0], 200)
            self.assertEqual(json.loads(retry[2])['config']['childGoals'][0][0]['startedAt'], started)
            stale = dict(update, id=secrets.token_hex(16))
            self.assertEqual(request('/parent/api/settings', stale, cookie=cookie)[0], 409)
            self.assertEqual(request('/parent/api/settings', update, cookie=cookie,
                                     origin_header='https://foreign.test')[0], 403)
            process.terminate()
            process.wait(timeout=5)
            start()
            self.assertEqual(request('/parent/api/login', {'token': '555666'})[0], 401)
            self.assertEqual(request('/parent/api/login', {'token': '135790'})[0], 200)
            status, _, data = request('/parent/api/state', cookie=cookie)
            self.assertEqual(status, 200)
            self.assertEqual(len(json.loads(data)['wallets']), 2)
            self.assertEqual(json.loads(data)['periodGoals'][0]['kind'], 'weekly')
            self.assertEqual(json.loads(data)['periodGoals'][0]['startedAt'], started)
            status, _, data = request('/parent/family-config.js', cookie=cookie)
            self.assertEqual(status, 200)
            self.assertIn(b'profiles', data)
            self.assertEqual(request('/setup/api/preview', {'token': self.token})[0], 410)
        finally:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()

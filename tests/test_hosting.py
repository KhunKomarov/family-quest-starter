import argparse
import contextlib
import copy
import http.client
import importlib.util
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
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('host_family', ROOT / 'scripts/host-family.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostingTest(unittest.TestCase):
    def test_backup_includes_committed_wal_data_and_can_be_restored(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            app, config, data = [directory / name for name in ('app', 'config', 'data')]
            (app / 'config').mkdir(parents=True)
            (app / 'sync').mkdir()
            config.mkdir()
            data.mkdir()
            (app / 'config/family.json').write_text('{}')
            (app / 'sync/catalog.json').write_text('[]')
            (config / 'parents.json').write_text('{}')
            with contextlib.closing(sqlite3.connect(data / 'journal.sqlite3')) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE example (value TEXT)')
                db.execute("INSERT INTO example VALUES ('committed WAL data')")
                db.commit()
                with patch.object(host, 'paths', return_value=(app, config, data)), patch.object(
                    host, 'BACKUPS', directory / 'backups'
                ):
                    host.backup('one')
                archive_path, = (directory / 'backups/one').glob('*.zip')
                import zipfile
                with zipfile.ZipFile(archive_path) as archive:
                    restored = directory / 'restored.sqlite3'
                    restored.write_bytes(archive.read('journal.sqlite3'))
                with contextlib.closing(sqlite3.connect(restored)) as recovered:
                    self.assertEqual(recovered.execute('SELECT value FROM example').fetchone()[0],
                                     'committed WAL data')
                self.assertEqual(archive_path.stat().st_mode & 0o777, 0o600)

    def test_rejects_unsafe_identifiers_and_malformed_catalog(self):
        for value in ('../other', 'a;id', 'name\nUser=root', 'UPPER', 'a'):
            with self.assertRaises(argparse.ArgumentTypeError):
                host.slug_value(value)
        for value in ('https://example.org', 'a.example.org;', 'a/../../b', 'a..example.org'):
            with self.assertRaises(argparse.ArgumentTypeError):
                host.hostname_value(value)
        catalog = json.loads((ROOT / 'sync/catalog.json').read_text())
        host.validate_catalog(catalog)
        catalog[0][1][0]['morning'].pop()
        with self.assertRaises(ValueError):
            host.validate_catalog(catalog)

    def test_export_contains_only_this_familys_connection_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            app, config, data = [directory / name for name in ('app', 'config', 'data')]
            (app / 'config').mkdir(parents=True)
            (app / 'sync').mkdir()
            config.mkdir()
            (app / 'config/family.json').write_text('{}')
            (app / 'sync/catalog.json').write_text('[]')
            (config / 'tv.properties').write_text('token=private\n')
            (config / 'parents.json').write_text('{}')
            (config / 'unrelated-secret.txt').write_text('not for export')
            output = directory / 'connection.zip'
            with patch.object(host, 'paths', return_value=(app, config, data)), patch.object(
                host, 'metadata', return_value={'hostname': 'one.example.org', 'enabled': True}
            ):
                host.export('one', output)
            import zipfile
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), {'config/family.json', 'sync/catalog.json',
                                 'connection/tv.properties', 'connection/parent-codes.json',
                                 'connection/instance.json', 'START_HERE.txt'})
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_separate_journals_reject_foreign_codes_sessions_and_device_tokens(self):
        with tempfile.TemporaryDirectory() as temporary, contextlib.ExitStack() as stack:
            families = []
            for index in range(2):
                directory = Path(temporary) / str(index)
                source = directory / 'app'
                source.mkdir(parents=True)
                config = copy.deepcopy(json.loads((ROOT / 'config/family.json').read_text()))
                config['profiles'] = [f'Family {index} child {n}' for n in range(3)]
                family_config = directory / 'family.json'
                family_config.write_text(json.dumps(config))
                host.stage(ROOT, source, family_config)
                # Staging must not include a private build directory or credentials.
                self.assertFalse((source / '.local').exists())
                credentials = directory / 'connection'
                subprocess.run([sys.executable, str(source / 'scripts/init-instance.py'),
                                '--directory', str(credentials)], check=True, capture_output=True)
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', 0))
                    port = probe.getsockname()[1]
                origin = f'https://family{index}.example.test'
                process = subprocess.Popen([sys.executable, str(source / 'sync/server.py'),
                    '--database', str(directory / 'journal.sqlite3'), '--port', str(port),
                    '--tokens', str(credentials / 'devices.json'), '--parents', str(credentials / 'parents.json'),
                    '--origin', origin], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                stack.callback(self.stop, process)
                for attempt in range(100):
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                            break
                    except OSError:
                        self.assertIsNone(process.poll(), 'server exited before startup')
                        time.sleep(0.02)
                else:
                    self.fail('server did not start')
                families.append({'port': port, 'origin': origin,
                    'code': next(iter(json.loads((credentials / 'parents.json').read_text()).values())),
                    'token': next(iter(json.loads((credentials / 'devices.json').read_text()).values()))})
            one, two = families
            for family in families:
                status, headers, body = self.request(family, '/parent/api/login', {'token': family['code']})
                self.assertEqual(status, 200)
                family['cookie'] = headers['Set-Cookie'].split(';')[0]
                self.assertTrue(family['cookie'].startswith('__Host-family_parent='))
                self.assertIn('Path=/;', headers['Set-Cookie'])
                self.assertIn('; Secure', headers['Set-Cookie'])
                self.assertNotIn('Domain=', headers['Set-Cookie'])
            self.assertEqual(self.request(two, '/parent/api/state', cookie=one['cookie'])[0], 401)
            self.assertEqual(self.request(two, '/parent/api/login', {'token': one['code']})[0], 401)
            self.assertEqual(self.request(two, '/v2/sync', {'operations': []}, token=one['token'])[0], 401)
            self.assertEqual(self.request(two, '/parent/api/action', {}, cookie=two['cookie'],
                                          origin=one['origin'])[0], 403)
            _, _, state = self.request(one, '/parent/api/state', cookie=one['cookie'])
            status, _, state = self.request(one, '/parent/api/action', {
                'id': secrets.token_hex(16), 'day': state['today'], 'action': 'daily-add',
                'titles': ['Private task for family one']}, cookie=one['cookie'])
            self.assertEqual(status, 200)
            self.assertTrue(any(row[2] == 'Private task for family one' for row in state['daily']))
            _, _, other = self.request(two, '/parent/api/state', cookie=two['cookie'])
            self.assertEqual(other['daily'], [])
            for family in families:
                self.assertEqual(self.request(family, '/v2/sync', {'operations': []}, token=family['token'])[0], 200)

    @staticmethod
    def stop(process):
        process.terminate()
        process.wait(timeout=5)

    @staticmethod
    def request(family, path, body=None, cookie=None, token=None, origin=None):
        headers = {'Origin': origin or family['origin']}
        if cookie:
            headers['Cookie'] = cookie
        if token:
            headers['Authorization'] = f'Bearer {token}'
        if body is not None:
            headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', family['port'], timeout=5)
        try:
            connection.request('POST' if body is not None else 'GET', path,
                               json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            content = response.read()
            return response.status, dict(response.getheaders()), json.loads(content)
        finally:
            connection.close()


if __name__ == '__main__':
    unittest.main()

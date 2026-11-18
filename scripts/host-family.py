"""Operator CLI: isolated family instances on an existing Ubuntu/Nginx host.

No SSH credentials or live host address belong in the public repository.
Run status as root too: instance metadata lives next to private credentials.
"""

import argparse
import contextlib
import datetime
import fcntl
import grp
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'sync'))
from configuration import validate_catalog as check_catalog
APPS = Path('/opt/fq-hosted')
CONFIGS = Path('/etc/fq-hosted')
DATA = Path('/var/lib/fq-hosted')
BACKUPS = Path('/var/backups/fq-hosted')
UNITS = Path('/etc/systemd/system')
SITES = Path('/etc/nginx/sites-available')
ENABLED = Path('/etc/nginx/sites-enabled')
ACME = Path('/var/www/fq-hosted-acme')


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def slug_value(value):
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,19}', value):
        raise argparse.ArgumentTypeError('slug: 2–20 lowercase letters, digits or hyphens; start with a letter')
    return value


def hostname_value(value):
    if len(value) > 253 or '.' not in value or any(
        not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
        for label in value.split('.')
    ):
        raise argparse.ArgumentTypeError('a lowercase DNS hostname is required, without scheme or path')
    return value


def private_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    path.chmod(0o600)


def paths(slug):
    return APPS / slug, CONFIGS / slug, DATA / slug


def metadata(slug):
    return json.loads((CONFIGS / slug / 'instance.json').read_text())


def runtime_settings(data):
    database = data / 'journal.sqlite3'
    if not database.is_file():
        return None
    with contextlib.closing(sqlite3.connect(database)) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='family_settings'").fetchone():
            return None
        row = db.execute('SELECT config,parents FROM family_settings WHERE id=1').fetchone()
        if not row:
            return None
        catalog = [(since, json.loads(menus)) for since, menus in db.execute('SELECT since,menus FROM family_catalog ORDER BY since')]
        photos = [(child, bytes(png)) for child, png in db.execute('SELECT child,png FROM family_photos')]
    return {'config': json.loads(row[0]), 'parents': json.loads(row[1]), 'catalog': catalog, 'photos': photos}


def instances():
    return [json.loads(path.read_text()) for path in sorted(CONFIGS.glob('*/instance.json'))]


def nginx_site(slug, hostname, port, tls=True):
    http = f'''server {{
    listen 80;
    server_name {hostname};
    access_log off;
    location ^~ /.well-known/acme-challenge/ {{ root {ACME}; try_files $uri =404; }}
    location / {{ {'return 308 https://' + hostname + '$request_uri;' if tls else 'return 404;'} }}
}}
'''
    if not tls:
        return http
    return http + f'''server {{
    listen 443 ssl;
    server_name {hostname};
    ssl_certificate /etc/letsencrypt/live/fq-hosted-{slug}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fq-hosted-{slug}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    client_max_body_size 320k;
    limit_conn fq_hosted_conn 12;
    proxy_set_header Host $http_host;
    proxy_connect_timeout 5s;
    proxy_read_timeout 15s;
    location = / {{ return 302 /parent/; }}
    location = /parent {{ return 302 /parent/; }}
    location = /parent/api/login {{
        limit_req zone=fq_hosted_login burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:{port};
    }}
    location = /setup/api/register {{
        client_max_body_size 3m;
        limit_req zone=fq_hosted_login burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:{port};
    }}
    location ^~ /setup/ {{ proxy_pass http://127.0.0.1:{port}; }}
    location ^~ /parent/ {{ proxy_pass http://127.0.0.1:{port}; }}
    location = /v2/sync {{
        limit_except POST {{ deny all; }}
        limit_req zone=fq_hosted_sync burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:{port};
    }}
    location / {{ return 404; }}
}}
'''


def service(slug, hostname, port):
    app, config, data = paths(slug)
    return f'''[Unit]
Description=Hosted Family Quest ({slug})
After=network.target

[Service]
User=fq-{slug}
Group=fq-{slug}
WorkingDirectory={app}
ExecStart=/usr/bin/python3 {app}/sync/server.py --origin https://{hostname} --port {port} --database {data}/journal.sqlite3 --tokens {config}/devices.json --parents {config}/parents.json --invitation-file {data}/invitation.json
Restart=on-failure
RestartSec=5s
Environment=PYTHONDONTWRITEBYTECODE=1
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths={data}
RestrictSUIDSGID=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Slice=fq-hosted.slice
MemoryHigh=40M
MemoryMax=64M
CPUQuota=25%
TasksMax=32

[Install]
WantedBy=multi-user.target
'''


def reload_nginx():
    run('nginx', '-t')
    run('systemctl', 'reload', 'nginx')


def wait_for_server(port):
    for _ in range(50):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
        try:
            connection.request('GET', '/parent/')
            response = connection.getresponse()
            response.read()
            if response.status == 200 or (response.status == 303 and response.getheader('Location') == '/setup/'):
                return
        except OSError:
            pass
        finally:
            connection.close()
        time.sleep(0.1)
    raise ValueError('family server did not become ready')


def install_host(base_domain):
    config_path = CONFIGS / 'host.json'
    if config_path.exists():
        raise ValueError('host is already initialized; inspect host.json rather than overwriting it')
    for path in (APPS, CONFIGS, DATA):
        path.mkdir(mode=0o755, parents=True, exist_ok=True)
        path.chmod(0o755)
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    ACME.mkdir(mode=0o755, parents=True, exist_ok=True)
    ACME.chmod(0o755)
    private_json(config_path, {'baseDomain': base_domain, 'maxFamilies': 4})
    (UNITS / 'fq-hosted.slice').write_text('''[Unit]
Description=Resource budget for hosted Family Quest instances
[Slice]
CPUQuota=50%
MemoryHigh=128M
MemoryMax=192M
''')
    limits = Path('/etc/nginx/conf.d/fq-hosted-limits.conf')
    if limits.exists():
        raise ValueError('Nginx hosting limits already exist')
    limits.write_text('''limit_req_zone "$server_name$binary_remote_addr" zone=fq_hosted_login:1m rate=8r/m;
limit_req_zone "$server_name$binary_remote_addr" zone=fq_hosted_sync:1m rate=10r/s;
limit_conn_zone $server_name zone=fq_hosted_conn:1m;
''')
    operator = Path(__file__).resolve()
    (UNITS / 'fq-hosted-backup.service').write_text(f'''[Unit]
Description=Back up hosted Family Quest journals
[Service]
Type=oneshot
UMask=0077
ExecStart=/usr/bin/python3 {operator} backup --all
''')
    (UNITS / 'fq-hosted-backup.timer').write_text('''[Unit]
Description=Daily hosted Family Quest backup
[Timer]
OnCalendar=*-*-* 03:15:00 UTC
RandomizedDelaySec=15min
Persistent=true
[Install]
WantedBy=timers.target
''')
    run('systemctl', 'daemon-reload')
    reload_nginx()
    run('systemctl', 'enable', '--now', 'fq-hosted-backup.timer')
    print('Hosting ready. No existing family service or database was modified.')


def stage(source, target, config=None, catalog=None):
    # Copy only runtime data/code. Never copy .local, credentials, Git, APKs or journals.
    for directory in ('config', 'parent', 'scripts', 'sync', 'web', 'setup'):
        for path in (source / directory).rglob('*'):
            if path.is_symlink():
                raise ValueError('source symlinks are not allowed')
            if not path.is_file() or '__pycache__' in path.parts or path.name in ('devices.json', 'parents.json'):
                continue
            if path.suffix not in ('.py', '.json', '.js', '.css', '.html', '.webmanifest', '.png', '.svg'):
                continue
            destination = target / path.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
    if config:
        shutil.copyfile(config, target / 'config/family.json')
    if catalog:
        count = len(json.loads((target / 'config/family.json').read_text())['profiles'])
        validate_catalog(json.loads(catalog.read_text()), count)
        shutil.copyfile(catalog, target / 'sync/catalog.json')
    run('python3', target / 'scripts/configure.py', stdout=subprocess.DEVNULL)


def validate_catalog(catalog, count=3):
    return check_catalog(catalog, count)


def create(args):
    if args.invite_output and args.invite_output.exists():
        raise ValueError('choose a new private path for the invitation')
    host = json.loads((CONFIGS / 'host.json').read_text())
    existing = instances()
    if sum(item.get('enabled', True) for item in existing) >= host['maxFamilies']:
        raise ValueError('pilot family limit reached; measure capacity before raising maxFamilies')
    hostname = hostname_value(args.hostname or f'{args.slug}.{host["baseDomain"]}')
    app, config, data = paths(args.slug)
    if any(path.exists() for path in (app, config, data)):
        raise ValueError('family already exists; never overwrite its journal or credentials')
    if any(item['hostname'] == hostname for item in existing):
        raise ValueError('hostname already belongs to another family')
    port = args.port or next((port for port in range(8801, 8900)
                              if port not in {item['port'] for item in existing}), None)
    if port is None or not 8801 <= port <= 8899:
        raise ValueError('port must be in 8801–8899')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))
    available = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines()
                         if line.startswith('MemAvailable:'))) * 1024
    if available < 160 * 1024 * 1024:
        raise ValueError('less than 160 MiB available; review capacity before creating a family')
    # Fail DNS validation before asking the CA for a certificate.
    socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
    with tempfile.TemporaryDirectory() as temporary:
        staged = Path(temporary) / 'app'
        stage(args.source.resolve(), staged, args.config, args.catalog)
        count = len(json.loads((staged / 'config/family.json').read_text())['profiles'])
        validate_catalog(json.loads((staged / 'sync/catalog.json').read_text()), count)
        staged_credentials = Path(temporary) / 'connection'
        command = ['python3', str(staged / 'scripts/init-instance.py'), '--directory', str(staged_credentials),
                   '--origin', f'https://{hostname}']
        for device in args.device or ['tv:tv', 'car:car']:
            command += ['--device', device]
        run(*command, stdout=subprocess.DEVNULL)
        user = f'fq-{args.slug}'
        try:
            pwd.getpwnam(user)
        except KeyError:
            pass
        else:
            raise ValueError('service user already exists')
        run('useradd', '--system', '--user-group', '--no-create-home', '--shell', '/usr/sbin/nologin', user)
        gid = grp.getgrnam(user).gr_gid
        shutil.copytree(staged, app)
        for path in (app, *app.rglob('*')):
            os.chown(path, 0, gid)
            path.chmod(0o750 if path.is_dir() else 0o640)
        config.mkdir(mode=0o750)
        os.chown(config, 0, gid)
        config.chmod(0o750)
        data.mkdir(mode=0o700)
        os.chown(data, pwd.getpwnam(user).pw_uid, gid)
        for path in staged_credentials.iterdir():
            shutil.copyfile(path, config / path.name)
        info = {'slug': args.slug, 'hostname': hostname, 'port': port, 'enabled': False,
                'created': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        private_json(config / 'instance.json', info)
        for path in config.iterdir():
            os.chown(path, 0, gid)
            path.chmod(0o640)
        unit = f'fq-hosted-{args.slug}.service'
        (UNITS / unit).write_text(service(args.slug, hostname, port))
        site = SITES / f'fq-hosted-{args.slug}'
        site.write_text(nginx_site(args.slug, hostname, port, tls=False))
        (ENABLED / site.name).symlink_to(site)
        try:
            reload_nginx()
            run(args.certbot, 'certonly', '--webroot', '-w', ACME, '--cert-name', f'fq-hosted-{args.slug}',
                '-d', hostname, '--non-interactive')
            site.write_text(nginx_site(args.slug, hostname, port))
            reload_nginx()
            run('systemctl', 'daemon-reload')
            run('systemctl', 'enable', '--now', unit)
            run('systemctl', 'is-active', '--quiet', unit)
            wait_for_server(port)
        except BaseException:
            # Failed setup stays private; retain files for inspection, never leave an HTTP login.
            subprocess.run(['systemctl', 'disable', '--now', unit], check=False, stdout=subprocess.DEVNULL)
            (ENABLED / site.name).unlink(missing_ok=True)
            reload_nginx()
            raise
        info['enabled'] = True
        private_json(config / 'instance.json', info)
        os.chown(config / 'instance.json', 0, gid)
        (config / 'instance.json').chmod(0o640)
    print(f'Created https://{hostname}/parent/ (credentials were not printed).')
    if args.invite_output:
        invite(args.slug, args.invite_output, args.invite_days, args.source)


def invite(slug, output, days, source):
    """Upgrade only an empty family and give it an expiring setup link."""
    app, config, data = paths(slug)
    info = metadata(slug)
    if not info['enabled'] or output.exists() or source.resolve() == app.resolve():
        raise ValueError('need an enabled family, a new output path and a separate template')
    with contextlib.closing(sqlite3.connect(data / 'journal.sqlite3')) as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='family_settings'").fetchone() and db.execute(
            'SELECT 1 FROM family_settings LIMIT 1'
        ).fetchone():
            raise ValueError('family is already registered; an invite cannot replace it')
        for table in ('family_cells', 'family_tasks', 'family_adjustments', 'family_payouts', 'family_audit'):
            if db.execute(f'SELECT 1 FROM {table} LIMIT 1').fetchone():
                raise ValueError('invites may only be issued for an empty journal')
    with tempfile.TemporaryDirectory() as temporary:
        staged = Path(temporary) / 'app'
        stage(source.resolve(), staged, app / 'config/family.json', app / 'sync/catalog.json')
        backup(slug)
        unit = f'fq-hosted-{slug}.service'
        run('systemctl', 'stop', unit)
        try:
            gid = grp.getgrnam(f'fq-{slug}').gr_gid
            for path in staged.rglob('*'):
                target = app / path.relative_to(staged)
                if path.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    shutil.copyfile(path, target)
                os.chown(target, 0, gid)
                target.chmod(0o750 if target.is_dir() else 0o640)
            devices_path = config / 'devices.json'
            devices = json.loads(devices_path.read_text())
            if 'tablet' not in devices:
                devices['tablet'] = secrets.token_hex(32)
                private_json(devices_path, devices)
                os.chown(devices_path, 0, gid)
                devices_path.chmod(0o640)
                tablet = config / 'tablet.properties'
                tablet.write_text(f'endpoint=https://{info["hostname"]}/v2/sync\ntoken={devices["tablet"]}\nmode=touch\n')
                os.chown(tablet, 0, gid)
                tablet.chmod(0o640)
            token = secrets.token_urlsafe(32)
            invitation = data / 'invitation.json'
            private_json(invitation, {'digest': hashlib.sha256(token.encode()).hexdigest(),
                                      'expires': int(time.time()) + days * 86400})
            os.chown(invitation, pwd.getpwnam(f'fq-{slug}').pw_uid, gid)
            (UNITS / unit).write_text(service(slug, info['hostname'], info['port']))
            # Update only this family's proxy with the setup routes and upload limit.
            site = SITES / f'fq-hosted-{slug}'
            site.write_text(nginx_site(slug, info['hostname'], info['port']))
            reload_nginx()
            run('systemctl', 'daemon-reload')
        finally:
            run('systemctl', 'start', unit)
        wait_for_server(info['port'])
        output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with output.open('x') as file:
            file.write(f'https://{info["hostname"]}/setup/#invite={token}\n')
        output.chmod(0o600)
    print(f'One-use invitation saved privately in {output}; expires in {days} days.')


def revoke_invite(slug):
    _, _, data = paths(slug)
    if runtime_settings(data):
        raise ValueError('registered families do not have an active setup invitation')
    path = data / 'invitation.json'
    value = json.loads(path.read_text())
    value['expires'] = 0
    private_json(path, value)
    os.chown(path, pwd.getpwnam(f'fq-{slug}').pw_uid, grp.getgrnam(f'fq-{slug}').gr_gid)
    run('systemctl', 'restart', f'fq-hosted-{slug}.service')
    wait_for_server(metadata(slug)['port'])
    print('Invitation revoked. The family journal was not deleted.')


def update_family(slug, source, refresh_default_labels=False):
    """Replace runtime code without replacing a registered family's journal or access."""
    app, _, data = paths(slug)
    info = metadata(slug)
    if not info['enabled'] or source.resolve() == app.resolve():
        raise ValueError('need an enabled family and a separate reviewed source template')
    active = runtime_settings(data)
    with tempfile.TemporaryDirectory() as temporary:
        temporary = Path(temporary)
        config_path, catalog_path = temporary / 'family.json', temporary / 'catalog.json'
        config_path.write_text(json.dumps(active['config']) if active else (app / 'config/family.json').read_text())
        if active:
            catalog = active['catalog']
        else:
            with contextlib.closing(sqlite3.connect(data / 'journal.sqlite3')) as db:
                catalog = [(since, json.loads(menus)) for since, menus in db.execute('SELECT since,menus FROM family_catalog ORDER BY since')]
        catalog_path.write_text(json.dumps(catalog))
        staged, previous = temporary / 'next', temporary / 'previous'
        stage(source.resolve(), staged, config_path, catalog_path)
        for path in (app / 'web').glob('avatar-*.png'):
            shutil.copyfile(path, staged / 'web' / path.name)
        backup(slug)
        unit = f'fq-hosted-{slug}.service'
        unit_path = UNITS / unit
        old_unit = unit_path.read_text()
        shutil.copytree(app, previous)
        gid = grp.getgrnam(f'fq-{slug}').gr_gid

        def install(tree):
            for path in tree.rglob('*'):
                target = app / path.relative_to(tree)
                if path.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    shutil.copyfile(path, target)
                os.chown(target, 0, gid)
                target.chmod(0o750 if target.is_dir() else 0o640)

        run('systemctl', 'stop', unit)
        try:
            install(staged)
            if refresh_default_labels:
                configuration = active['config'] if active else json.loads(config_path.read_text())
                today = (int(time.time() * 1000) + configuration['utcOffsetMinutes'] * 60000) // 86400000
                with contextlib.closing(sqlite3.connect(data / 'journal.sqlite3')) as db, db:
                    versions = [(since, json.loads(menus)) for since, menus in db.execute('SELECT since,menus FROM family_catalog ORDER BY since')]
                    current = next(menus for since, menus in reversed(versions) if since <= today)
                    for since, menus in [(today, current)] + [(since, menus) for since, menus in versions if since > today]:
                        modified = False
                        for menu in menus:
                            for task in menu['afternoon']:
                                if task[0] == 'wash' and task[1] == 'Помыться, отнести свою одежду в стирку, надеть трусики':
                                    task[1] = 'Принять душ'
                                    modified = True
                        if modified:
                            db.execute('INSERT OR REPLACE INTO family_catalog VALUES(?,?)', (since, json.dumps(menus, ensure_ascii=False)))
            unit_path.write_text(service(slug, info['hostname'], info['port']))
            run('systemctl', 'daemon-reload')
            run('systemctl', 'start', unit)
            wait_for_server(info['port'])
        except BaseException:
            run('systemctl', 'stop', unit)
            install(previous)
            unit_path.write_text(old_unit)
            run('systemctl', 'daemon-reload')
            run('systemctl', 'start', unit)
            raise
    print('Family runtime updated; journal, registration, photos and device access preserved.')


def export(slug, output):
    app, config, data = paths(slug)
    active = runtime_settings(data)
    info = metadata(slug)
    if not info['enabled']:
        raise ValueError('family is not enabled')
    if output.exists():
        raise ValueError('choose a new export path')
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with output.open('xb') as raw:
        os.chmod(output, 0o600)
        with zipfile.ZipFile(raw, 'w', zipfile.ZIP_DEFLATED) as archive:
            if active:
                archive.writestr('config/family.json', json.dumps(active['config'], ensure_ascii=False))
                archive.writestr('sync/catalog.json', json.dumps(active['catalog'], ensure_ascii=False))
                archive.writestr('connection/parent-codes.json', json.dumps(active['parents'], ensure_ascii=False))
                for index in range(len(active['config']['profiles'])):
                    photo = dict(active['photos']).get(index)
                    if photo is None:
                        photo = (app / 'web' / f'avatar-{index % 3 + 1}.png').read_bytes()
                    archive.writestr(f'web/avatar-{index + 1}.png', photo)
            else:
                archive.write(app / 'config/family.json', 'config/family.json')
                archive.write(app / 'sync/catalog.json', 'sync/catalog.json')
                archive.write(config / 'parents.json', 'connection/parent-codes.json')
            for path in sorted(config.glob('*.properties')):
                archive.write(path, f'connection/{path.name}')
            archive.writestr('connection/instance.json', json.dumps(info, indent=2))
            archive.writestr('START_HERE.txt', 'Private family connection pack. Do not publish or upload to GitHub.\n'
                             f'Parent panel: https://{info["hostname"]}/parent/\n'
                             'Read docs/hosted.md in the family-quest-starter repository.\n'
                             'Copy config/family.json and sync/catalog.json into your private project.\n'
                             'Build each APK with its connection/*.properties file.\n'
                             'Parent codes are in connection/parent-codes.json. No SSH access is needed.\n')
    print(f'Private connection pack: {output}')


def configure(slug, source_config):
    app, _, data = paths(slug)
    active = runtime_settings(data)
    info = metadata(slug)
    if not info['enabled']:
        raise ValueError('family is not enabled')
    # Validate on a temporary copy before touching the running family.
    with tempfile.TemporaryDirectory() as temporary:
        staged = Path(temporary) / 'app'
        stage(app, staged, source_config)
        new_config = json.loads((staged / 'config/family.json').read_text())
        if active and len(new_config['profiles']) != len(active['config']['profiles']):
            raise ValueError('registered profiles cannot be added or removed through configure')
        backup(slug)
        gid = grp.getgrnam(f'fq-{slug}').gr_gid
        replacements = ('config/family.json', 'web/family-config.js')
        originals = {name: (app / name).read_bytes() for name in replacements}
        unit = f'fq-hosted-{slug}.service'
        run('systemctl', 'stop', unit)
        try:
            for name in replacements:
                (app / name).write_bytes((staged / name).read_bytes())
            if active:
                with contextlib.closing(sqlite3.connect(data / 'journal.sqlite3')) as db, db:
                    db.execute('UPDATE family_settings SET config=? WHERE id=1', (json.dumps(new_config, ensure_ascii=False),))
            run('systemctl', 'start', unit)
            wait_for_server(info['port'])
        except BaseException:
            for name, content in originals.items():
                (app / name).write_bytes(content)
            if active:
                with contextlib.closing(sqlite3.connect(data / 'journal.sqlite3')) as db, db:
                    db.execute('UPDATE family_settings SET config=? WHERE id=1',
                               (json.dumps(active['config'], ensure_ascii=False),))
            run('systemctl', 'restart', unit)
            raise
        finally:
            for name in replacements:
                os.chown(app / name, 0, gid)
                (app / name).chmod(0o640)
    print('Family configuration updated; rebuild its Android clients with the same configuration.')


def backup(slug):
    app, config, data = paths(slug)
    directory = BACKUPS / slug
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = directory / f'{stamp}.zip'
    with tempfile.TemporaryDirectory(dir=directory) as temporary:
        snapshot = Path(temporary) / 'journal.sqlite3'
        with contextlib.closing(sqlite3.connect(f'file:{data}/journal.sqlite3?mode=ro', uri=True)) as source:
            with contextlib.closing(sqlite3.connect(snapshot)) as destination:
                source.backup(destination)
                if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('backup integrity check failed')
        with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot, 'journal.sqlite3')
            for path in config.iterdir():
                if path.is_file():
                    archive.write(path, f'connection/{path.name}')
            active = runtime_settings(data)
            if active:
                archive.writestr('config/family.json', json.dumps(active['config'], ensure_ascii=False))
                archive.writestr('sync/catalog.json', json.dumps(active['catalog'], ensure_ascii=False))
                for child, png in active['photos']:
                    archive.writestr(f'web/avatar-{child + 1}.png', png)
            else:
                archive.write(app / 'config/family.json', 'config/family.json')
                archive.write(app / 'sync/catalog.json', 'sync/catalog.json')
    target.chmod(0o600)
    print(f'Backup verified: {target}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init-host')
    init.add_argument('--base-domain', type=hostname_value, required=True)
    add = commands.add_parser('create')
    add.add_argument('--slug', type=slug_value, required=True)
    add.add_argument('--hostname', type=hostname_value)
    add.add_argument('--source', type=Path, default=ROOT)
    add.add_argument('--config', type=Path)
    add.add_argument('--catalog', type=Path)
    add.add_argument('--device', action='append')
    add.add_argument('--port', type=int)
    add.add_argument('--certbot', default='certbot')
    add.add_argument('--invite-output', type=Path)
    add.add_argument('--invite-days', type=int, choices=range(1, 31), default=7)
    invitation = commands.add_parser('invite')
    invitation.add_argument('--slug', type=slug_value, required=True)
    invitation.add_argument('--output', type=Path, required=True)
    invitation.add_argument('--days', type=int, choices=range(1, 31), default=7)
    invitation.add_argument('--source', type=Path, default=ROOT)
    revoke = commands.add_parser('revoke-invite')
    revoke.add_argument('--slug', type=slug_value, required=True)
    upgrade = commands.add_parser('update')
    upgrade.add_argument('--slug', type=slug_value, required=True)
    upgrade.add_argument('--source', type=Path, default=ROOT)
    upgrade.add_argument('--refresh-default-labels', action='store_true')
    out = commands.add_parser('export')
    out.add_argument('--slug', type=slug_value, required=True)
    out.add_argument('--output', type=Path, required=True)
    edit = commands.add_parser('configure')
    edit.add_argument('--slug', type=slug_value, required=True)
    edit.add_argument('--config', type=Path, required=True)
    save = commands.add_parser('backup')
    selection = save.add_mutually_exclusive_group(required=True)
    selection.add_argument('--slug', type=slug_value)
    selection.add_argument('--all', action='store_true')
    commands.add_parser('status')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('operator commands require root; families do not receive SSH access')
    os.umask(0o077)
    # Serialize provisioning, exports and scheduled backups on this host.
    with open('/run/lock/fq-hosted.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if args.command == 'init-host':
                install_host(args.base_domain)
            elif args.command == 'create':
                create(args)
            elif args.command == 'invite':
                invite(args.slug, args.output.resolve(), args.days, args.source)
            elif args.command == 'revoke-invite':
                revoke_invite(args.slug)
            elif args.command == 'update':
                update_family(args.slug, args.source, args.refresh_default_labels)
            elif args.command == 'export':
                export(args.slug, args.output.resolve())
            elif args.command == 'configure':
                configure(args.slug, args.config)
            elif args.command == 'backup':
                for slug in ([item['slug'] for item in instances() if item['enabled']] if args.all else [args.slug]):
                    backup(slug)
            else:
                for item in instances():
                    print(f"{item['slug']}: https://{item['hostname']}/parent/ enabled={item['enabled']}")
        except (ValueError, OSError, subprocess.CalledProcessError) as error:
            parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()

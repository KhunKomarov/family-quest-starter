"""Private, single-family journal for task checkboxes."""

import argparse
import hmac
import io
import json
import re
import sqlite3
import threading
import zipfile
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import family
import onboarding
from configuration import browser_config


TOKEN_PATTERN = re.compile(r"[0-9a-f]{64}")


class Handler(BaseHTTPRequestHandler):
    server_version = "FamilyQuest"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def device(self):
        authorization = self.headers.get("Authorization", "")
        token = authorization[7:] if authorization.startswith("Bearer ") else ""
        return next(
            (name for name, secret in self.server.tokens.items() if hmac.compare_digest(token.encode(), secret.encode())),
            None,
        )

    def session(self):
        try:
            name = "family_parent" if self.server.preview else "__Host-family_parent"
            cookie = SimpleCookie(self.headers.get("Cookie", "")).get(name)
        except CookieError:
            return ""
        return cookie.value if cookie else ""

    def do_GET(self):
        if re.fullmatch(r'/setup/avatar-[1-3]\.png', self.path):
            self.asset(self.server.assets / 'setup' / self.path.split('/')[-1], 'image/png')
            return
        if self.path in ('/setup/', '/setup/app.js', '/setup/style.css'):
            name = {'/setup/': 'index.html', '/setup/app.js': 'app.js', '/setup/style.css': 'style.css'}[self.path]
            mime = {'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css'}[name]
            self.asset(self.server.assets / 'setup' / name, mime)
            return
        if self.server.registration_pending:
            if self.path in ('/parent', '/parent/'):
                self.send_content(303, 'text/plain', b'', location='/setup/')
            else:
                self.respond(401, {'error': 'setup_required'})
            return
        if not self.server.parents:
            self.respond(404, {"error": "not_found"})
            return
        path = self.path
        if path == "/parent":
            self.send_response(302)
            self.send_header("Location", "/parent/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path in ("/parent/style.css", "/parent/login.js", "/parent/manifest.webmanifest"):
            name = path.split("/")[-1]
            mime = {"css": "text/css", "js": "text/javascript",
                    "webmanifest": "application/manifest+json"}[name.split(".")[-1]]
            self.asset(self.server.assets / "parent" / name, mime)
            return
        actor = family.session_actor(self.server.database, self.server.parents, self.session())
        if path == "/parent/":
            self.asset(self.server.assets / "parent" / ("index.html" if actor else "login.html"), "text/html")
        elif path == "/parent/tasks/":
            if actor:
                self.asset(self.server.assets / "parent" / "tasks.html", "text/html")
            else:
                self.send_content(303, "text/plain", b"", location="/parent/")
        elif not actor:
            self.respond(401, {"error": "unauthorized"})
        elif path == "/parent/api/state":
            with family.transaction(self.server.database) as db:
                result = family.snapshot(db, family.day_of(family.now_ms()), parent=True)
            result["actor"] = actor
            self.respond(200, result)
        elif path == '/parent/family-config.js':
            self.send_content(200, 'text/javascript', browser_config(family.CONFIG).encode())
        elif path == '/parent/connect/':
            self.asset(self.server.assets / 'parent/connect.html', 'text/html')
        elif path == '/parent/connect.js':
            self.asset(self.server.assets / 'parent/connect.js', 'text/javascript')
        elif path == '/parent/api/connection':
            self.connection_pack()
        elif re.fullmatch(r'/parent/avatar/[0-5]\.png', path):
            index = int(path.split('/')[-1][0])
            if index >= family.CHILD_COUNT:
                self.respond(404, {'error': 'not_found'})
                return
            data = onboarding.photo(self.server.database, index)
            if data is None:
                data = (self.server.assets / 'web' / f'avatar-{index % 3 + 1}.png').read_bytes()
            self.send_content(200, 'image/png', data)
        elif path in ("/parent/app.js", "/parent/tasks.js", "/parent/rules.js", "/parent/projection.js"):
            name = path.split("/")[-1]
            directory = "parent" if name in ("app.js", "tasks.js") else "web"
            self.asset(self.server.assets / directory / name, "text/javascript")
        else:
            self.respond(404, {"error": "not_found"})

    def do_POST(self):
        if self.path in ('/setup/api/preview', '/setup/api/register'):
            self.registration_post()
            return
        if self.server.registration_pending:
            self.respond(403, {'error': 'setup_required'})
            return
        if self.path.startswith("/parent/api/") and self.server.parents:
            self.parent_post()
            return
        if self.path != "/v2/sync":
            self.respond(404, {"error": "not_found"})
            return
        device = self.device()
        if not device:
            self.respond(401, {"error": "unauthorized"})
            return
        try:
            result = family.sync_device(self.server.database, device, self.read_json(300_000))
        except (ValueError, TypeError, TimeoutError, OverflowError):
            self.respond(400, {"error": "invalid_request"})
            return
        except sqlite3.Error:
            self.respond(503, {"error": "retry"})
            return
        self.respond(200, result)

    def registration_post(self):
        if self.headers.get('Origin') != self.server.origin:
            self.respond(403, {'error': 'forbidden'})
            return
        try:
            body = self.read_json(2_800_000 if self.path.endswith('/register') else 2_000)
            if not isinstance(body, dict):
                raise ValueError('invalid request')
            with self.server.registration_lock:
                onboarding.verify(self.server.database, body.get('token'))
                if self.path.endswith('/preview'):
                    catalog = json.loads((self.server.assets / 'sync/catalog.json').read_text())
                    self.respond(200, {'template': catalog[-1][1][0], 'maxChildren': 6})
                    return
                config, parents = onboarding.register(self.server.database, body)
                family.configure(config)
                self.server.parents = parents
                self.server.registration_pending = False
                session = family.login(self.server.database, parents, body['parents'][0]['code'])
                self.respond(200, {'ok': True, 'parent': '/parent/', 'connect': '/parent/connect/'},
                             self.cookie(session, 2_592_000))
        except onboarding.InvalidInvitation:
            self.respond(410, {'error': 'invitation_unavailable'})
        except (ValueError, TypeError, KeyError, TimeoutError, OverflowError):
            self.respond(400, {'error': 'invalid_request'})
        except (sqlite3.Error, ImportError):
            self.respond(503, {'error': 'retry'})

    def connection_pack(self):
        output = io.BytesIO()
        with family.transaction(self.server.database) as db:
            catalog = family.read_catalog(db)
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('config/family.json', json.dumps(family.CONFIG, ensure_ascii=False, indent=2))
            archive.writestr('sync/catalog.json', json.dumps(catalog, ensure_ascii=False))
            for index in range(family.CHILD_COUNT):
                photo = onboarding.photo(self.server.database, index)
                if photo is None:
                    photo = (self.server.assets / 'web' / f'avatar-{index % 3 + 1}.png').read_bytes()
                archive.writestr(f'web/avatar-{index + 1}.png', photo)
            for name, token in self.server.tokens.items():
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', name):
                    continue
                mode = 'car' if name == 'car' else 'touch' if name in ('tablet', 'touch') else 'tv'
                archive.writestr(f'connection/{name}.properties',
                                 f'endpoint={self.server.origin}/v2/sync\ntoken={token}\nmode={mode}\n')
            archive.writestr('START_HERE.txt', 'Private family settings and device credentials. Do not publish.\n'
                             'Copy config/, sync/catalog.json and web/avatar-*.png into a private copy of family-quest-starter.\n'
                             'Read docs/hosted.md and build each Android APK with its connection/*.properties file.\n')
        self.send_content(200, 'application/zip', output.getvalue(),
                          disposition='attachment; filename="family-quest-connection.zip"')

    def read_json(self, maximum):
        length = int(self.headers.get("Content-Length", "0"))
        if not 1 <= length <= maximum:
            raise ValueError("invalid length")
        return json.loads(self.rfile.read(length))

    def parent_post(self):
        path = self.path
        if self.headers.get("Origin") != self.server.origin:
            self.respond(403, {"error": "forbidden"})
            return
        session = self.session()
        try:
            body = self.read_json(24_000)
            if not isinstance(body, dict):
                raise ValueError("invalid request")
            if path == "/parent/api/login":
                issued = family.login(self.server.database, self.server.parents, body.get("token"))
                if issued:
                    self.respond(200, {"ok": True}, self.cookie(issued, 2_592_000))
                else:
                    self.respond(401, {"error": "unauthorized"})
                return
            actor = family.session_actor(self.server.database, self.server.parents, session)
            if not actor:
                self.respond(401, {"error": "unauthorized"})
            elif path == "/parent/api/logout":
                family.session_actor(self.server.database, self.server.parents, session, logout=True)
                self.respond(200, {"ok": True}, self.cookie("", 0))
            elif path == "/parent/api/action":
                result = family.parent_action(self.server.database, actor, body)
                result["actor"] = actor
                self.respond(200, result)
            else:
                self.respond(404, {"error": "not_found"})
        except family.LoginThrottled:
            self.respond(429, {"error": "too_many_attempts"})
        except family.InsufficientBalance:
            self.respond(409, {"error": "insufficient_balance"})
        except family.DuplicateTask:
            self.respond(409, {"error": "duplicate_task"})
        except family.Conflict:
            self.respond(409, {"error": "conflict"})
        except (ValueError, TypeError, TimeoutError, OverflowError):
            self.respond(400, {"error": "invalid_request"})
        except sqlite3.Error:
            self.respond(503, {"error": "retry"})

    def cookie(self, value, age):
        secure = "" if self.server.preview else "; Secure"
        name = "family_parent" if self.server.preview else "__Host-family_parent"
        path = "/parent" if self.server.preview else "/"
        return f"{name}={value}; Max-Age={age}; Path={path}; HttpOnly; SameSite=Strict{secure}"

    def asset(self, path, mime):
        self.send_content(200, mime, path.read_bytes())

    def respond(self, status, body, cookie=None):
        content = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_content(status, "application/json", content, cookie)

    def send_content(self, status, mime, content, cookie=None, location=None, disposition=None):
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        images = "'self' data:" if self.path.startswith('/setup/') else "'self'"
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                         f"img-src {images}; manifest-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        if location:
            self.send_header("Location", location)
        if disposition:
            self.send_header('Content-Disposition', disposition)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, _format, *args):
        # Never log family events or authentication headers.
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--tokens", required=True, type=Path)
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--parents", type=Path)
    parser.add_argument("--origin")
    parser.add_argument("--preview", action="store_true", help="Use loopback HTTP for a local test with synthetic data")
    parser.add_argument('--invitation-file', type=Path)
    options = parser.parse_args()
    tokens = json.loads(options.tokens.read_text())
    parents = json.loads(options.parents.read_text()) if options.parents else {}
    if (
        not isinstance(tokens, dict)
        or not tokens
        or any(not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token) for token in tokens.values())
        or len(set(tokens.values())) != len(tokens)
    ):
        parser.error("tokens must map device names to distinct 64-character hex secrets")
    if (not isinstance(parents, dict) or any(not name.strip() or len(name) > 60
            or not isinstance(code, str) or not family.PARENT_CODE.fullmatch(code) for name, code in parents.items())
            or len(set(parents.values())) != len(parents)):
        parser.error("parents must have distinct six-digit codes")
    origin = options.origin or (f"http://127.0.0.1:{options.port}" if options.preview else "")
    if parents and not options.preview:
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
            parser.error("--origin must be the exact public HTTPS origin")
    family.initialize(options.database)
    onboarding.initialize(options.database, options.invitation_file)
    saved = onboarding.settings(options.database)
    if saved:
        config, parents = saved
        family.configure(config)
    with ThreadingHTTPServer(("127.0.0.1", options.port), Handler) as server:
        server.database = options.database
        server.tokens = tokens
        server.parents = parents
        server.preview = options.preview
        server.origin = origin
        server.assets = Path(__file__).resolve().parent.parent
        server.registration_pending = onboarding.pending(options.database)
        server.registration_lock = threading.Lock()
        server.serve_forever()


if __name__ == "__main__":
    main()

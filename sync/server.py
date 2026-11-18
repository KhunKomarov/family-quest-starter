"""Private, single-family journal for task checkboxes."""

import argparse
import hmac
import json
import re
import sqlite3
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import family


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
            cookie = SimpleCookie(self.headers.get("Cookie", "")).get("family_parent")
        except CookieError:
            return ""
        return cookie.value if cookie else ""

    def do_GET(self):
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
        elif path in ("/parent/app.js", "/parent/tasks.js", "/parent/family-config.js", "/parent/rules.js", "/parent/projection.js"):
            name = path.split("/")[-1]
            directory = "parent" if name in ("app.js", "tasks.js") else "web"
            self.asset(self.server.assets / directory / name, "text/javascript")
        else:
            self.respond(404, {"error": "not_found"})

    def do_POST(self):
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
        return f"family_parent={value}; Max-Age={age}; Path=/parent; HttpOnly; SameSite=Strict{secure}"

    def asset(self, path, mime):
        self.send_content(200, mime, path.read_bytes())

    def respond(self, status, body, cookie=None):
        content = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_content(status, "application/json", content, cookie)

    def send_content(self, status, mime, content, cookie=None, location=None):
        self.send_response(status)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                         "img-src 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        if location:
            self.send_header("Location", location)
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
    with ThreadingHTTPServer(("127.0.0.1", options.port), Handler) as server:
        server.database = options.database
        server.tokens = tokens
        server.parents = parents
        server.preview = options.preview
        server.origin = origin
        server.assets = Path(__file__).resolve().parent.parent
        server.serve_forever()


if __name__ == "__main__":
    main()

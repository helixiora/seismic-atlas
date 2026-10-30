"""Static dev server for webapp/ that disables HTTP caching."""
import functools, http.server, os, sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8430
HERE = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(HERE, "..", "webapp")
if not os.path.isdir(root):  # flat layout (the GitHub repo): the site is the repo root
    root = os.path.join(HERE, "..")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer.allow_reuse_address = True
srv = http.server.ThreadingHTTPServer(("", port), functools.partial(Handler, directory=root))
print(f"Serving {os.path.abspath(root)} on http://localhost:{port}")
srv.serve_forever()

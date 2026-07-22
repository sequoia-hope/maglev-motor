#!/usr/bin/env python3
"""Dev server for the simulator.

python -m http.server sends no Cache-Control and no ETag, so Chrome falls back
to heuristic freshness and will happily reuse a module for hours without
revalidating. With a no-build ES-module app that fails in a confusing way: a
fresh index.html loads a stale app.js, so new markup appears with old code
behind it and features render blank instead of erroring.

Everything here is no-store. It costs nothing on localhost and removes a whole
category of "but it works on my machine".
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (args[1] if len(args) > 1 else ''):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = partial(NoCacheHandler, directory=sys.path[0])
    print(f'serving {sys.path[0]} on http://0.0.0.0:{port}  (no-store)')
    ThreadingHTTPServer(('0.0.0.0', port), handler).serve_forever()

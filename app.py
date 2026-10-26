#!/usr/bin/env python3
"""X5 Regia come app per Mac: avvia il server locale e apre l'interfaccia in una finestra nativa."""
import os, socket, sys, threading, time
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


def free_port(preferred):
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", preferred)):
            return preferred
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    import webview
    server.CACHE.mkdir(exist_ok=True); server.PROJECTS.mkdir(parents=True, exist_ok=True)
    server.migrate_old_cache()
    port = free_port(server.PORT)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), server.H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    win = webview.create_window("X5 Regia", f"http://127.0.0.1:{port}", width=1500, height=950, min_size=(1100, 700),
                                background_color="#111214")
    if os.environ.get("X5_SELFTEST"):  # verifica automatica: WebGL2, decodifica video, shader
        def test():
            time.sleep(8)
            r = win.evaluate_js("JSON.stringify({gl2: !!document.createElement('canvas').getContext('webgl2'), "
                                "prog: typeof prog !== 'undefined' && !!prog, meta: !!META, tex: texReady, "
                                "rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype, dialog: typeof HTMLDialogElement})")
            print("SELFTEST", r, flush=True)
            win.destroy()
        threading.Thread(target=test, daemon=True).start()
    webview.start()
    httpd.shutdown()


if __name__ == "__main__":
    main()

import uvicorn
import webbrowser
import threading
import time

def open_browser(url: str):
    time.sleep(1.5)
    print(f"Opening browser at: {url}")
    webbrowser.open(url)

if __name__ == "__main__":
    host = "127.0.0.1"
    port = 8000
    app_url = f"http://{host}:{port}"

    print("=" * 65)
    print("🚀  NexusMeet - Real-Time Communication Platform")
    print(f"📡  Server URL:    {app_url}")
    print(f"🔒  Security:      E2EE AES-GCM 256-bit + DTLS/SRTP Media")
    print(f"📹  Features:      WebRTC Video, Screen Share, Whiteboard, Files")
    print("=" * 65)

    threading.Thread(target=open_browser, args=(app_url,), daemon=True).start()

    uvicorn.run(
        "server.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info"
    )

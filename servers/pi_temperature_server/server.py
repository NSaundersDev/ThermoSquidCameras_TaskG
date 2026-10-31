#!/usr/bin/env python3
"""Board temperature for the video Pi.

The page temperature widget connects to ws://<stream host>:8083/ws. Readings
come from vcgencmd, then from the CPU thermal zone. Messages match the
existing indicator: temperature on connect, temperature for request_temperature,
and temperature_update every two seconds.
"""

import base64
import hashlib
import json
import re
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8083
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 10 * 1024
CHECK_SECONDS = 1
EMIT_SECONDS = 2

state_lock = threading.Lock()
clients_lock = threading.Lock()
clients = set()
temperature = {
    "celsius": 0,
    "fahrenheit": 0,
    "timestamp": 0,
    "isValid": False,
    "error": None,
    "source": None,
}


def rounded(value):
    return round(value * 10) / 10


def snapshot():
    with state_lock:
        return dict(temperature)


def store(celsius, source, error):
    valid = celsius is not None and error is None
    with state_lock:
        if valid:
            temperature["celsius"] = rounded(celsius)
            temperature["fahrenheit"] = rounded(celsius * 9 / 5 + 32)
            temperature["source"] = source
            temperature["error"] = None
            temperature["isValid"] = True
        else:
            temperature["isValid"] = False
            temperature["error"] = error
        temperature["timestamp"] = int(time.time() * 1000)
        current = dict(temperature)
    return current


def cpu_temp_path():
    zones = sorted(Path("/sys/class/thermal").glob("thermal_zone*"))
    for zone in zones:
        type_file = zone / "type"
        if type_file.is_file() and "cpu" in type_file.read_text(encoding="utf-8").lower():
            return zone / "temp"
    if zones:
        return zones[0] / "temp"
    return None


def read_temperature():
    try:
        output = subprocess.check_output(["vcgencmd", "measure_temp"], text=True, timeout=5, stderr=subprocess.DEVNULL)
        match = re.search(r"temp=([\d.]+)", output)
        if match:
            return store(float(match.group(1)), "vcgencmd", None)
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    path = cpu_temp_path()
    try:
        if path is None:
            raise FileNotFoundError("thermal zone missing")
        millicelsius = int(path.read_text(encoding="utf-8").strip())
        if millicelsius <= 0:
            raise ValueError(f"invalid sys temp: {millicelsius}")
        return store(millicelsius / 1000, "sys_thermal", None)
    except (OSError, ValueError) as error:
        return store(None, None, str(error))


def encode_frame(opcode, payload):
    length = len(payload)
    header = bytearray([0x80 | opcode])
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(length.to_bytes(2, "big"))
    else:
        header.append(127)
        header.extend(length.to_bytes(8, "big"))
    return bytes(header) + payload


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self.send_json(200, {"status": "ok", "temperature": snapshot(), "clients": len(clients)})
            return
        if path == "/api/temperature":
            current = snapshot()
            self.send_json(200, {"success": current["isValid"], "data": current})
            return
        if path != "/ws":
            self.send_error(404)
            return
        self.handle_websocket()

    def handle_websocket(self):
        key = (self.headers.get("Sec-WebSocket-Key") or "").strip()
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or upgrade != "websocket":
            self.send_error(400, "Expected WebSocket")
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.close_connection = True
        self.wfile.write((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        ).encode("ascii"))
        self.wfile.flush()
        self.write_lock = threading.Lock()
        with clients_lock:
            clients.add(self)
        print(f"Temperature client connected. Total clients: {len(clients)}", flush=True)
        try:
            self.send_message({"type": "temperature", "data": snapshot(), "connectedAt": int(time.time() * 1000)})
            self.read_frames()
        except (OSError, ValueError):
            pass
        finally:
            with clients_lock:
                clients.discard(self)
            print(f"Temperature client disconnected. Total clients: {len(clients)}", flush=True)

    def send_message(self, body):
        frame = encode_frame(0x1, json.dumps(body).encode("utf-8"))
        with self.write_lock:
            self.wfile.write(frame)
            self.wfile.flush()

    def read_exact(self, size):
        if size == 0:
            return b""
        data = self.rfile.read(size)
        if not data or len(data) < size:
            return None
        return data

    def read_frames(self):
        fragments = None
        opcode = None
        while True:
            head = self.read_exact(2)
            if head is None:
                return
            fin = head[0] & 0x80
            frame_opcode = head[0] & 0x0F
            length = head[1] & 0x7F
            if length == 126:
                extended = self.read_exact(2)
                if extended is None:
                    return
                length = int.from_bytes(extended, "big")
            elif length == 127:
                extended = self.read_exact(8)
                if extended is None:
                    return
                length = int.from_bytes(extended, "big")
            if length > MAX_MESSAGE:
                return
            mask = self.read_exact(4) if head[1] & 0x80 else b""
            if mask is None:
                return
            payload = self.read_exact(length) if length else b""
            if payload is None:
                return
            if mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if frame_opcode == 0x8:
                return
            if frame_opcode == 0x9:
                with self.write_lock:
                    self.wfile.write(encode_frame(0xA, payload))
                    self.wfile.flush()
                continue
            if frame_opcode == 0xA:
                continue
            if frame_opcode in (0x1, 0x2):
                opcode = frame_opcode
                fragments = payload
            elif frame_opcode == 0x0 and fragments is not None:
                fragments += payload
            else:
                continue
            if not fin or opcode != 0x1:
                continue
            self.on_text(fragments.decode("utf-8", "replace"))
            fragments = None
            opcode = None

    def on_text(self, text):
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            return
        if isinstance(message, dict) and message.get("type") == "request_temperature":
            self.send_message({"type": "temperature", "data": snapshot()})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def monitor():
    previous = None
    elapsed = 0
    while True:
        current = read_temperature()
        if current["isValid"] and (previous is None or abs(current["celsius"] - previous) > 0.5):
            print(f"Temperature {current['celsius']}°C from {current['source']}", flush=True)
            previous = current["celsius"]
        elapsed += CHECK_SECONDS
        if elapsed >= EMIT_SECONDS:
            elapsed = 0
            body = {"type": "temperature_update", "data": snapshot(), "clients": len(clients)}
            with clients_lock:
                connected = list(clients)
            for client in connected:
                try:
                    client.send_message(body)
                except (OSError, socket.timeout, ValueError):
                    with clients_lock:
                        clients.discard(client)
        time.sleep(CHECK_SECONDS)


def main():
    read_temperature()
    current = snapshot()
    print(f"Initial temperature: {current['celsius']}°C valid={current['isValid']}", flush=True)
    threading.Thread(target=monitor, daemon=True).start()
    server = Server(("0.0.0.0", PORT), Handler)
    print(f"Video Pi temperature on ws://0.0.0.0:{PORT}/ws", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

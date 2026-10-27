#!/usr/bin/env python3
"""Apply Imaging DAQ picture settings on the camera Pi.

The ribbon path is a mediaMTX rpiCamera source. The USB path is ffmpeg reading
a V4L2 device. This listens on port 8090 and keeps the mediaMTX API on localhost.
"""

import json
import subprocess
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = "http://127.0.0.1:9997"
PORT = 8090
DEVICE = "/dev/video0"
NAMES = {"cam_ribbon", "cam_usb"}

EXPOSURE_OUT = {"normal": "normal", "sport": "short", "long": "long", "short": "short"}
EXPOSURE_IN = {"normal": "normal", "short": "sport", "long": "long", "custom": "normal"}
METER_OUT = {"centre": "centre", "spot": "spot", "average": "matrix", "matrix": "matrix", "custom": "custom"}
METER_IN = {"centre": "centre", "spot": "spot", "matrix": "average", "custom": "custom"}
DENOISE_OUT = {"auto": "off", "off": "off", "cdn_off": "cdn_off", "cdn_fast": "cdn_fast", "cdn_hq": "cdn_fast"}
AWB_MODES = {"auto", "incandescent", "tungsten", "fluorescent", "indoor", "daylight", "cloudy", "custom"}
WB_TEMPERATURE = {
    "incandescent": 2700,
    "tungsten": 3200,
    "fluorescent": 4000,
    "indoor": 4000,
    "daylight": 5500,
    "cloudy": 6500,
}


def clamp(value, low, high):
    return min(high, max(low, value))


def number(body, key, default):
    try:
        value = float(body.get(key, default))
    except (TypeError, ValueError):
        return default
    if value != value:
        return default
    return value


def span_to_device(value, ui_min, ui_max, ui_default, dev_min, dev_max, dev_default):
    value = clamp(float(value), ui_min, ui_max)
    if value <= ui_default:
        span = ui_default - ui_min
        portion = 0 if span == 0 else (value - ui_min) / span
        return int(round(dev_min + portion * (dev_default - dev_min)))
    span = ui_max - ui_default
    portion = 0 if span == 0 else (value - ui_default) / span
    return int(round(dev_default + portion * (dev_max - dev_default)))


def device_to_span(value, ui_min, ui_max, ui_default, dev_min, dev_max, dev_default):
    value = clamp(float(value), dev_min, dev_max)
    if value <= dev_default:
        span = dev_default - dev_min
        portion = 0 if span == 0 else (value - dev_min) / span
        return ui_min + portion * (ui_default - ui_min)
    span = dev_max - dev_default
    portion = 0 if span == 0 else (value - dev_default) / span
    return ui_default + portion * (ui_max - ui_default)


def mediamtx(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode()) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            payload = json.loads(raw.decode())
        except (json.JSONDecodeError, UnicodeError):
            payload = {"error": "mediaMTX rejected the settings"}
        return error.code, payload


def same_patch(current, patch):
    for key, value in patch.items():
        have = current.get(key)
        if isinstance(value, list):
            if [float(item) for item in (have or [])] != [float(item) for item in value]:
                return False
            continue
        if isinstance(value, (int, float)) and isinstance(have, (int, float)):
            if abs(float(have) - float(value)) > 0.02:
                return False
            continue
        if have != value:
            return False
    return True


def ribbon_patch(body):
    awb = str(body.get("awb") or "auto")
    if awb == "off":
        awb_mode = "custom"
        gains = [
            round(clamp(number(body, "awb_red", 1), 0.1, 8), 2),
            round(clamp(number(body, "awb_blue", 1), 0.1, 8), 2),
        ]
    else:
        awb_mode = awb if awb in AWB_MODES else "auto"
        gains = [0, 0]
    return {
        "rpiCameraWidth": int(round(number(body, "width", 1280))),
        "rpiCameraHeight": int(round(number(body, "height", 720))),
        "rpiCameraFPS": number(body, "framerate", 30),
        "rpiCameraBrightness": round(clamp(number(body, "brightness", 0), -1, 1), 2),
        "rpiCameraContrast": round(clamp(number(body, "contrast", 1), 0, 32), 2),
        "rpiCameraSaturation": round(clamp(number(body, "saturation", 1), 0, 32), 2),
        "rpiCameraSharpness": round(clamp(number(body, "sharpness", 1), 0, 16), 2),
        "rpiCameraEV": round(clamp(number(body, "ev", 0), -8, 8), 2),
        "rpiCameraShutter": max(0, int(round(number(body, "shutter", 0)))),
        "rpiCameraGain": round(clamp(number(body, "gain", 0), 0, 32), 2),
        "rpiCameraMetering": METER_OUT.get(str(body.get("metering") or "centre"), "centre"),
        "rpiCameraExposure": EXPOSURE_OUT.get(str(body.get("exposure") or "normal"), "normal"),
        "rpiCameraAWB": awb_mode,
        "rpiCameraAWBGains": gains,
        "rpiCameraDenoise": DENOISE_OUT.get(str(body.get("denoise") or "auto"), "off"),
    }


def ribbon_page(conf):
    awb = conf.get("rpiCameraAWB") or "auto"
    gains = conf.get("rpiCameraAWBGains") or [0, 0]
    if awb == "custom":
        page_awb = "off"
        red = float(gains[0] or 1)
        blue = float(gains[1] or 1)
    else:
        page_awb = awb if awb in AWB_MODES else "auto"
        red, blue = 1, 1
    return {
        "width": conf.get("rpiCameraWidth"),
        "height": conf.get("rpiCameraHeight"),
        "framerate": conf.get("rpiCameraFPS"),
        "brightness": conf.get("rpiCameraBrightness"),
        "contrast": conf.get("rpiCameraContrast"),
        "saturation": conf.get("rpiCameraSaturation"),
        "sharpness": conf.get("rpiCameraSharpness"),
        "ev": conf.get("rpiCameraEV"),
        "shutter": conf.get("rpiCameraShutter"),
        "gain": conf.get("rpiCameraGain"),
        "metering": METER_IN.get(conf.get("rpiCameraMetering"), "centre"),
        "exposure": EXPOSURE_IN.get(conf.get("rpiCameraExposure"), "normal"),
        "awb": page_awb,
        "awb_red": red,
        "awb_blue": blue,
        "denoise": conf.get("rpiCameraDenoise") or "off",
    }


def apply_ribbon(body):
    patch = ribbon_patch(body)
    status, current = mediamtx("GET", "/v3/config/paths/get/cam_ribbon")
    if status == 200 and same_patch(current, patch):
        return 200, {"status": "ok"}
    status, payload = mediamtx("PATCH", "/v3/config/paths/patch/cam_ribbon", patch)
    if status != 200:
        message = payload.get("error") if isinstance(payload, dict) else ""
        return status, {"status": "error", "error": message or "Ribbon camera rejected the settings"}
    return 200, {"status": "ok"}


def read_ribbon():
    status, payload = mediamtx("GET", "/v3/config/paths/get/cam_ribbon")
    if status != 200:
        return status, {"status": "error", "error": "Ribbon camera settings are unavailable"}
    return 200, ribbon_page(payload)


def v4l2_get():
    result = subprocess.run(
        ["v4l2-ctl", "-d", DEVICE, "--get-ctrl",
         "brightness,contrast,saturation,sharpness,gain,white_balance_automatic,white_balance_temperature,auto_exposure,exposure_time_absolute"],
        check=False, capture_output=True, text=True, timeout=5,
    )
    values = {}
    for line in (result.stdout or "").splitlines():
        if ":" not in line:
            continue
        name, raw = line.split(":", 1)
        try:
            values[name.strip()] = int(raw.strip())
        except ValueError:
            continue
    return values


def v4l2_set(pairs):
    if not pairs:
        return ""
    spec = ",".join("%s=%s" % (name, value) for name, value in pairs)
    result = subprocess.run(
        ["v4l2-ctl", "-d", DEVICE, "-c", spec],
        check=False, capture_output=True, text=True, timeout=5,
    )
    if result.returncode != 0:
        return (result.stderr or result.stdout or "USB camera rejected a control").strip()
    return ""


def usb_format():
    result = subprocess.run(
        ["v4l2-ctl", "-d", DEVICE, "--get-fmt-video", "--get-parm"],
        check=False, capture_output=True, text=True, timeout=5,
    )
    width, height, fps = 640, 480, 30
    for line in (result.stdout or "").splitlines():
        text = line.strip()
        if text.startswith("Width/Height"):
            parts = text.split(":", 1)[-1].replace(" ", "").split("/")
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                width, height = int(parts[0]), int(parts[1])
        if "Frames per second" in text:
            try:
                fps = int(round(float(text.split(":", 1)[-1].split()[0])))
            except (ValueError, IndexError):
                pass
    return width, height, fps


def usb_command(width, height, fps):
    fps = int(round(fps))
    if width >= 1000 or height >= 700:
        size = (1280, 720)
        rate = min(max(fps, 10), 30)
        pixel = "mjpeg"
    else:
        size = (640, 480)
        rate = min(max(fps, 10), 30)
        pixel = "yuyv422"
    command = (
        "ffmpeg -hide_banner -loglevel warning -f v4l2 "
        "-input_format %s -video_size %sx%s -framerate %s -i /dev/video0 "
        "-c:v libx264 -pix_fmt yuv420p -preset ultrafast -tune zerolatency -b:v 2M "
        "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
    ) % (pixel, size[0], size[1], rate)
    return command, size[0], size[1], rate


def usb_page(controls, width, height, fps):
    auto = controls.get("auto_exposure", 3) != 1
    shutter = 0
    exposure = "normal"
    if not auto:
        absolute = controls.get("exposure_time_absolute", 156)
        shutter = absolute * 100
        if absolute <= 80:
            exposure = "sport"
        elif absolute >= 1500:
            exposure = "long"
    automatic = controls.get("white_balance_automatic", 1) == 1
    temperature = controls.get("white_balance_temperature", 4000)
    if automatic:
        awb, red, blue = "auto", 1, 1
    else:
        nearest = min(WB_TEMPERATURE.items(), key=lambda item: abs(item[1] - temperature))
        if abs(nearest[1] - temperature) <= 400:
            awb, red, blue = nearest[0], 1, 1
        else:
            awb = "off"
            red = 1
            blue = round(clamp(temperature / 4500, 0.1, 8), 2)
    return {
        "width": width,
        "height": height,
        "framerate": fps,
        "brightness": round(device_to_span(controls.get("brightness", 128), -1, 1, 0, 0, 255, 128), 2),
        "contrast": round(device_to_span(controls.get("contrast", 32), 0, 32, 1, 0, 255, 32), 2),
        "saturation": round(device_to_span(controls.get("saturation", 32), 0, 32, 1, 0, 255, 32), 2),
        "sharpness": round(device_to_span(controls.get("sharpness", 24), 0, 16, 1, 0, 255, 24), 2),
        "ev": 0,
        "shutter": shutter,
        "gain": round(device_to_span(controls.get("gain", 0), 0, 32, 0, 0, 255, 0), 2),
        "metering": "centre",
        "exposure": exposure,
        "awb": awb,
        "awb_red": red,
        "awb_blue": blue,
        "denoise": "off",
    }


def apply_usb(body):
    controls = [
        ("brightness", span_to_device(number(body, "brightness", 0), -1, 1, 0, 0, 255, 128)),
        ("contrast", span_to_device(number(body, "contrast", 1), 0, 32, 1, 0, 255, 32)),
        ("saturation", span_to_device(number(body, "saturation", 1), 0, 32, 1, 0, 255, 32)),
        ("sharpness", span_to_device(number(body, "sharpness", 1), 0, 16, 1, 0, 255, 24)),
        ("gain", span_to_device(number(body, "gain", 0), 0, 32, 0, 0, 255, 0)),
    ]
    error = v4l2_set(controls)
    if error:
        return 400, {"status": "error", "error": error}

    shutter = max(0, int(round(number(body, "shutter", 0))))
    exposure = str(body.get("exposure") or "normal")
    if shutter > 0:
        error = v4l2_set([("auto_exposure", 1)]) or v4l2_set([
            ("exposure_time_absolute", int(clamp(round(shutter / 100), 1, 10000)))
        ])
    elif exposure == "sport":
        error = v4l2_set([("auto_exposure", 1)]) or v4l2_set([("exposure_time_absolute", 50)])
    elif exposure == "long":
        error = v4l2_set([("auto_exposure", 1)]) or v4l2_set([("exposure_time_absolute", 2000)])
    else:
        error = v4l2_set([("auto_exposure", 3)])
    if error:
        return 400, {"status": "error", "error": error}

    awb = str(body.get("awb") or "auto")
    if awb == "auto":
        error = v4l2_set([("white_balance_automatic", 1)])
    elif awb == "off":
        red = max(0.1, number(body, "awb_red", 1))
        blue = max(0.1, number(body, "awb_blue", 1))
        temperature = int(clamp(round(4500 * (blue / red)), 0, 10000))
        error = v4l2_set([("white_balance_automatic", 0)]) or v4l2_set([
            ("white_balance_temperature", temperature)
        ])
    elif awb in WB_TEMPERATURE:
        error = v4l2_set([("white_balance_automatic", 0)]) or v4l2_set([
            ("white_balance_temperature", WB_TEMPERATURE[awb])
        ])
    else:
        error = v4l2_set([("white_balance_automatic", 1)])
    if error:
        return 400, {"status": "error", "error": error}

    command, width, height, rate = usb_command(
        number(body, "width", 640),
        number(body, "height", 480),
        number(body, "framerate", 30),
    )
    status, current = mediamtx("GET", "/v3/config/paths/get/cam_usb")
    if status != 200:
        return status, {"status": "error", "error": "USB camera stream is unavailable"}
    if current.get("runOnInit") != command:
        status, payload = mediamtx("PATCH", "/v3/config/paths/patch/cam_usb", {"runOnInit": command})
        if status != 200:
            message = payload.get("error") if isinstance(payload, dict) else ""
            return status, {"status": "error", "error": message or "Could not resize the USB camera"}
    page = usb_page(v4l2_get(), width, height, rate)
    page["status"] = "ok"
    return 200, page


def read_usb():
    width, height, fps = usb_format()
    page = usb_page(v4l2_get(), width, height, fps)
    page["status"] = "ok"
    return 200, page


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args))

    def path_name(self):
        parts = [part for part in self.path.split("?", 1)[0].split("/") if part]
        if len(parts) == 2 and parts[0] == "controls" and parts[1] in NAMES:
            return parts[1]
        return ""

    def send_json(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        name = self.path_name()
        if not name:
            self.send_json(404, {"status": "error", "error": "Unknown camera"})
            return
        try:
            status, payload = read_ribbon() if name == "cam_ribbon" else read_usb()
        except (OSError, subprocess.SubprocessError, urllib.error.URLError) as error:
            self.send_json(500, {"status": "error", "error": str(error)})
            return
        self.send_json(status, payload)

    def do_POST(self):
        name = self.path_name()
        if not name:
            self.send_json(404, {"status": "error", "error": "Unknown camera"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 20000:
            self.send_json(400, {"status": "error", "error": "Settings were empty"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode())
        except (json.JSONDecodeError, UnicodeError):
            self.send_json(400, {"status": "error", "error": "Settings were not valid"})
            return
        if not isinstance(body, dict):
            self.send_json(400, {"status": "error", "error": "Settings were not valid"})
            return
        try:
            status, payload = apply_ribbon(body) if name == "cam_ribbon" else apply_usb(body)
        except (OSError, subprocess.SubprocessError, urllib.error.URLError) as error:
            self.send_json(500, {"status": "error", "error": str(error)})
            return
        self.send_json(status, payload)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Camera controls listening on %s" % PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()

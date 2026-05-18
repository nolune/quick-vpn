#!/usr/bin/env python3
import sys
import json
import os
import signal
import time
import urllib.request
import urllib.error
import urllib.parse
import subprocess
import shutil
import yaml

MIXED_PORT = 7890
SOCKS_PORT = 7891
CONTROLLER = "127.0.0.1:9090"
API_BASE = f"http://{CONTROLLER}"


def log_crash(ext_dir, msg):
    try:
        path = os.path.join(ext_dir, "crash.log")
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _workdir(profile_id):
    return f"/tmp/quickvpn-mihomo-{profile_id}"


def _pidfile(ext_dir, profile_id):
    return os.path.join(ext_dir, "configs", f"{profile_id}.pid")


def read_config(ext_dir, profile_id):
    path = os.path.join(ext_dir, "configs", f"{profile_id}.yaml")
    with open(path) as f:
        return yaml.safe_load(f)


def port_in_use(port):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def generate_config(ext_dir, profile_id):
    config = read_config(ext_dir, profile_id)
    overrides = {
        "mixed-port": MIXED_PORT,
        "socks-port": SOCKS_PORT,
        "allow-lan": False,
        "mode": "rule",
        "log-level": "warning",
        "external-controller": CONTROLLER,
        "tun": {
            "enable": True,
            "stack": "gvisor",
            "dns-hijack": ["any:53"],
            "auto-route": True,
            "auto-detect-interface": True,
        },
    }
    for k, v in overrides.items():
        config[k] = v
    return config


def setup_workdir(ext_dir, profile_id):
    workdir = _workdir(profile_id)
    os.makedirs(workdir, exist_ok=True)

    for f in ["GeoIP.dat", "GeoSite.dat", "geoip.metadb"]:
        src = os.path.join(ext_dir, "bin", f)
        dst = os.path.join(workdir, f)
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)

    config = generate_config(ext_dir, profile_id)
    config_path = os.path.join(workdir, "config.yaml")
    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
    return workdir, config


def wait_for_api(timeout=15):
    for _ in range(timeout * 2):
        try:
            resp = urllib.request.urlopen(f"{API_BASE}/version", timeout=1)
            if resp.status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def api_get(path):
    req = urllib.request.Request(f"{API_BASE}{path}", method="GET")
    try:
        resp = urllib.request.urlopen(req, timeout=3)
        return json.loads(resp.read())
    except Exception:
        return None


def api_put(path, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    try:
        urllib.request.urlopen(req, timeout=3)
        return True
    except urllib.error.HTTPError as e:
        if e.code == 400:
            return None
        return False
    except Exception:
        return False


def find_selector_group(node_name):
    data = api_get("/proxies")
    if not data:
        return None
    for name, p in data.get("proxies", {}).items():
        if p.get("type") == "Selector" and node_name in p.get("all", []):
            return name
    return None


def select_node(node_name):
    data = api_get("/proxies")
    if not data:
        return False

    found = False
    for name, p in data.get("proxies", {}).items():
        if p.get("type") == "Selector" and node_name in p.get("all", []):
            path = f"/proxies/{urllib.parse.quote(name, safe='')}"
            result = api_put(path, {"name": node_name})
            if result:
                found = True
                print(f"Set {name} -> {node_name}")

    if found:
        return True
    print(f"Failed to switch to {node_name}")
    return False


def cmd_start(ext_dir, profile_id):
    pidfile = _pidfile(ext_dir, profile_id)
    if os.path.exists(pidfile):
        with open(pidfile) as f:
            pid = int(f.read().strip())
        try:
            os.kill(pid, 0)
            print(f"Already running (pid {pid})")
            return
        except ProcessLookupError:
            os.remove(pidfile)

    if port_in_use(MIXED_PORT):
        print(f"Port {MIXED_PORT} already in use")
        sys.exit(1)

    bin_path = os.path.join(ext_dir, "bin", "mihomo")
    workdir, _ = setup_workdir(ext_dir, profile_id)
    logfile = os.path.join(workdir, "mihomo.log")

    with open(logfile, "w") as lf:
        proc = subprocess.Popen(
            [bin_path, "-d", workdir],
            stdout=lf, stderr=lf,
            preexec_fn=os.setpgrp,
        )

    with open(pidfile, "w") as f:
        f.write(str(proc.pid))

    if not wait_for_api():
        print("Timeout waiting for mihomo to start")
        cmd_stop(ext_dir, profile_id)
        sys.exit(1)

    # Restore last selected node
    profiles_path = os.path.join(ext_dir, "profiles.json")
    if os.path.exists(profiles_path):
        with open(profiles_path) as f:
            profiles = json.load(f)
        for p in profiles:
            if p.get("id") == profile_id and p.get("selectedNode"):
                select_node(p["selectedNode"])
                break

    print(f"Started (pid {proc.pid})")


def cmd_stop(ext_dir, profile_id=None):
    if profile_id:
        _stop_one(ext_dir, profile_id)
        return
    configs_dir = os.path.join(ext_dir, "configs")
    if not os.path.isdir(configs_dir):
        return
    for fname in os.listdir(configs_dir):
        if fname.endswith(".pid"):
            _stop_one(ext_dir, fname.replace(".pid", ""))


def _stop_one(ext_dir, profile_id):
    pidfile = _pidfile(ext_dir, profile_id)
    if not os.path.exists(pidfile):
        return
    try:
        with open(pidfile) as f:
            pid = int(f.read().strip())
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(os.getpgid(pid), sig)
                time.sleep(0.3)
                os.kill(pid, 0)
            except (ProcessLookupError, PermissionError):
                break
    except Exception:
        pass
    try:
        os.remove(pidfile)
    except Exception:
        pass
    workdir = _workdir(profile_id)
    if os.path.isdir(workdir):
        shutil.rmtree(workdir, ignore_errors=True)
    print("Stopped")


def cmd_switch(ext_dir, profile_id, node_name):
    pidfile = _pidfile(ext_dir, profile_id)
    if not os.path.exists(pidfile):
        cmd_start(ext_dir, profile_id)
        time.sleep(1)
    select_node(node_name)


def cmd_restart(ext_dir, profile_id):
    cmd_stop(ext_dir, profile_id)
    time.sleep(1)
    cmd_start(ext_dir, profile_id)


def cmd_dryrun(ext_dir, profile_id):
    config = generate_config(ext_dir, profile_id)
    proxies = config.get("proxies", [])
    groups = config.get("proxy-groups", [])
    print(f"Proxies: {len(proxies)}")
    for p in proxies:
        print(f"  [{p.get('type')}] {p.get('name')} @ {p.get('server')}:{p.get('port')}")
    print(f"Groups: {len(groups)}")
    for g in groups:
        print(f"  {g.get('name')} ({g.get('type')}) -> {g.get('proxies')}")


def main():
    if len(sys.argv) < 3:
        print("Usage: mihomo_helper.py <ext_dir> <start|stop|switch|restart|dryrun> [args...]")
        sys.exit(1)

    ext_dir = sys.argv[1]
    action = sys.argv[2]

    if action == "start":
        if len(sys.argv) < 4:
            print("Missing profile_id")
            sys.exit(1)
        cmd_start(ext_dir, sys.argv[3])
    elif action == "stop":
        profile_id = sys.argv[3] if len(sys.argv) > 3 else None
        cmd_stop(ext_dir, profile_id)
    elif action == "switch":
        if len(sys.argv) < 5:
            print("Missing profile_id and node_name")
            sys.exit(1)
        cmd_switch(ext_dir, sys.argv[3], sys.argv[4])
    elif action == "restart":
        if len(sys.argv) < 4:
            print("Missing profile_id")
            sys.exit(1)
        cmd_restart(ext_dir, sys.argv[3])
    elif action == "dryrun":
        if len(sys.argv) < 4:
            print("Missing profile_id")
            sys.exit(1)
        cmd_dryrun(ext_dir, sys.argv[3])
    else:
        print(f"Unknown action: {action}")
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        ext_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
        tb = traceback.format_exc()
        print(f"CRASH: {e}", file=sys.stderr)
        print(tb, file=sys.stderr)
        log_crash(ext_dir, f"mihomo_helper CRASH: {e}\n{tb}")

#!/usr/bin/env python3
import sys
import json
import base64
import os
import time
import urllib.parse

try:
    import yaml
except ImportError:
    yaml = None


def log_crash(ext_dir, msg):
    try:
        path = os.path.join(ext_dir, "crash.log")
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(path, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def decode_base64_header(val):
    if not val:
        return ''
    if val.startswith('base64:'):
        try:
            raw = val[7:].strip()
            padding = 4 - len(raw) % 4 if len(raw) % 4 else 0
            return base64.b64decode(raw + '=' * padding).decode('utf-8').strip()
        except Exception:
            return val
    return val


def parse_vless(url):
    parsed = urllib.parse.urlparse(url)
    fragment = parsed.fragment or ''
    netloc = parsed.netloc
    if '@' in netloc:
        _, server_part = netloc.split('@', 1)
    else:
        server_part = netloc
    server_port = server_part.split(':')
    server = server_port[0]
    port = int(server_port[1]) if len(server_port) > 1 and server_port[1].isdigit() else 0
    name = fragment or server
    return {'name': name, 'type': 'vless', 'server': server, 'port': port}


def parse_vmess(url):
    b64 = url.replace('vmess://', '', 1)
    try:
        padding = 4 - len(b64) % 4 if len(b64) % 4 else 0
        decoded = base64.b64decode(b64 + '=' * padding).decode('utf-8')
        data = json.loads(decoded)
        return {
            'name': data.get('ps', ''),
            'type': 'vmess',
            'server': data.get('add', ''),
            'port': data.get('port', 0),
        }
    except Exception:
        return {'name': '', 'type': 'vmess', 'server': '', 'port': 0}


def parse_trojan(url):
    parsed = urllib.parse.urlparse(url)
    fragment = parsed.fragment or ''
    netloc = parsed.netloc
    if '@' in netloc:
        _, server_part = netloc.split('@', 1)
    else:
        server_part = netloc
    server_port = server_part.split(':')
    server = server_port[0]
    port = int(server_port[1]) if len(server_port) > 1 and server_port[1].isdigit() else 0
    name = fragment or server
    return {'name': name, 'type': 'trojan', 'server': server, 'port': port}


def parse_ss(url):
    fragment = urllib.parse.urlparse(url).fragment or ''
    rest = url[5:]
    if '@' in rest:
        b64_part, server_part = rest.split('@', 1)
        server_port = server_part.split('#')[0].split(':')
        server = server_port[0]
        port = int(server_port[1]) if len(server_port) > 1 and server_port[1].isdigit() else 0
        try:
            padding = 4 - len(b64_part) % 4 if len(b64_part) % 4 else 0
            decoded = base64.b64decode(b64_part + '=' * padding).decode('utf-8')
            method = decoded.split(':')[0] if ':' in decoded else ''
        except Exception:
            method = ''
        name = fragment or server
        return {'name': name, 'type': 'ss', 'server': server, 'port': port, 'method': method}
    return {'name': fragment or '', 'type': 'ss', 'server': '', 'port': 0}


def parse_ssr(url):
    b64 = url.replace('ssr://', '', 1)
    try:
        padding = 4 - len(b64) % 4 if len(b64) % 4 else 0
        decoded = base64.b64decode(b64 + '=' * padding).decode('utf-8')
        parts = decoded.split('/')[0].split(':')
        server = parts[0] if len(parts) >= 6 else ''
        port = int(parts[1]) if len(parts) >= 6 and parts[1].isdigit() else 0
        return {'name': '', 'type': 'ssr', 'server': server, 'port': port}
    except Exception:
        return {'name': '', 'type': 'ssr', 'server': '', 'port': 0}


def parse_proxy_links(text):
    proxies = []
    for line in text.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        if line.startswith('vless://'):
            proxies.append(parse_vless(line))
        elif line.startswith('vmess://'):
            proxies.append(parse_vmess(line))
        elif line.startswith('trojan://'):
            proxies.append(parse_trojan(line))
        elif line.startswith('ss://'):
            proxies.append(parse_ss(line))
        elif line.startswith('ssr://'):
            proxies.append(parse_ssr(line))
    return proxies


def parse_sub_info(sub_info_raw):
    upload = download = total = expire = 0
    if sub_info_raw:
        for part in sub_info_raw.split(';'):
            part = part.strip()
            if '=' in part:
                k, v = part.split('=', 1)
                if k == 'upload':
                    upload = int(v)
                elif k == 'download':
                    download = int(v)
                elif k == 'total':
                    total = int(v)
                elif k == 'expire':
                    expire = int(v) * 1000
    return upload, download, total, expire


def main():
    config_path = sys.argv[1]
    sub_info_raw = sys.argv[2] if len(sys.argv) > 2 else ''
    profile_title_raw = sys.argv[3] if len(sys.argv) > 3 else ''

    content = open(config_path).read()
    proxies = []

    # Try Clash YAML format first
    if yaml:
        try:
            data = yaml.safe_load(content)
            if isinstance(data, dict) and 'proxies' in data:
                for p in data['proxies']:
                    proxies.append({
                        'name': p.get('name', ''),
                        'type': p.get('type', ''),
                        'server': p.get('server', ''),
                        'port': p.get('port', 0),
                    })
                upload, download, total, expire = parse_sub_info(sub_info_raw)
                print(json.dumps({
                    'proxies': proxies,
                    'upload': upload,
                    'download': download,
                    'total': total,
                    'expire': expire,
                    'label': decode_base64_header(profile_title_raw),
                }))
                return
        except Exception:
            pass

    # Try base64-decoded proxy links
    try:
        raw = content.strip()
        padding = 4 - len(raw) % 4 if len(raw) % 4 else 0
        decoded = base64.b64decode(raw + '=' * padding).decode('utf-8')
        proxies = parse_proxy_links(decoded)
    except Exception:
        proxies = parse_proxy_links(content)

    upload, download, total, expire = parse_sub_info(sub_info_raw)
    print(json.dumps({
        'proxies': proxies,
        'upload': upload,
        'download': download,
        'total': total,
        'expire': expire,
        'label': decode_base64_header(profile_title_raw),
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"CRASH: {e}", file=sys.stderr)
        print(tb, file=sys.stderr)
        ext_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
        log_crash(ext_dir, f"parse_config CRASH: {e}\n{tb}")
        sys.exit(1)

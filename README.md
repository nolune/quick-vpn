# Quick VPN

Manage VPN subscriptions from GNOME quick settings panel.

## Features

- Add VPN subscriptions via URL (supports Clash/mihomo format)
- Browse and switch between proxy nodes
- Ping test for all nodes
- Auto-enables system proxy (HTTP/SOCKS) on connect
- Restores original proxy settings on disconnect
- Traffic usage and expiration info
- Supports subscription links from FlClashX, HAPP, and direct URLs

## Requirements

- GNOME Shell 50
- Python 3
- PyYAML (`pip install pyyaml`)
- mihomo (bundled in `bin/`)

## Manual Installation

```bash
git clone https://github.com/nolune/quick-vpn.git
cd quick-vpn
ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/quick-vpn@nolune
```

Restart GNOME Shell (Alt+F2, type `r`) and enable the extension.

## License

GNU General Public License v2.0

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

function bytesToGB(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function formatDate(ts) {
    if (!ts) return '∞';
    return new Date(ts).toLocaleDateString();
}

function extractConfigUrl(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('flclashx://install-config?url=')) {
        try {
            const uri = GLib.Uri.parse(trimmed, GLib.UriFlags.NONE);
            const query = uri.get_query();
            if (query) {
                const params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
                const configUrl = params.url;
                if (configUrl) return configUrl;
            }
        } catch {}
    }
    if (trimmed.startsWith('happ://add/')) {
        return trimmed.slice('happ://add/'.length);
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
    }
    return null;
}

function parseLabelFromUrl(url) {
    try {
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const query = uri.get_query();
        if (query) {
            const params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
            if (params.name) return params.name;
        }
        const fragment = uri.get_fragment();
        if (fragment) return decodeURIComponent(fragment);
    } catch {}
    return null;
}

function truncateText(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    return text.substring(0, maxLen - 1) + '…';
}

function getDomainFromUrl(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host();
    } catch {
        return 'Subscription';
    }
}

function logCrash(storePath, message, stderr) {
    if (!storePath) return;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const logFile = `${storePath}/crash.log`;
    let entry = `[${ts}] ${message}`;
    if (stderr) entry += `\n  stderr: ${stderr}`;
    entry += '\n';
    log(entry.trim());
    try {
        const [ok, data] = GLib.file_get_contents(logFile);
        let existing = '';
        if (ok && data) {
            existing = typeof data === 'string' ? data : new TextDecoder().decode(data);
        }
        if (existing.length > 100000) {
            existing = existing.substring(existing.length - 100000);
        }
        GLib.file_set_contents(logFile, existing + entry);
    } catch {}
}

function getDeviceHwid(storePath) {
    const hwidFile = `${storePath}/.hwid`;
    try {
        const [ok, data] = GLib.file_get_contents(hwidFile);
        if (ok && data) {
            const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const trimmed = str.trim();
            if (trimmed) return trimmed;
        }
    } catch {}
    const hwid = Array.from({ length: 16 }, () =>
        '0123456789ABCDEF'[Math.floor(Math.random() * 16)]
    ).join('');
    try {
        GLib.file_set_contents(hwidFile, hwid);
    } catch {}
    return hwid;
}

function pingHost(host) {
    return new Promise((resolve) => {
        try {
            const proc = Gio.Subprocess.new(
                ['ping', '-c', '1', '-W', '2', host],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    const match = stdout.match(/time=(\d+\.?\d*)\s*ms/);
                    resolve(match ? parseFloat(match[1]) : null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            resolve(null);
        }
    });
}

const QuickVpnToggle = GObject.registerClass({
    Signals: {
        'profile-activated': { param_types: [GObject.TYPE_STRING] },
        'profile-deactivated': {},
    },
}, class QuickVpnToggle extends QuickSettings.QuickMenuToggle {
    _init(iconPath) {
        super._init({
            title: _('Quick VPN'),
            toggleMode: true,
        });

        this._profiles = [];
        this._activeProfileId = null;
        this._profileItems = new Map();
        this._nodeItems = new Map();
        this._storePath = '';
        this._isFetching = false;

        const icon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));
        this.menu.setHeader(icon, _('Quick VPN'), _('Select VPN profile'));

        this.connect('clicked', () => {
            if (this.checked) {
                let lastActive = this._profiles.find(p => p.id === this._activeProfileId);
                if (!lastActive) {
                    lastActive = this._profiles.find(p => p.selectedNode) || this._profiles[0];
                    if (lastActive) this._activeProfileId = lastActive.id;
                }
                if (lastActive && !lastActive.selectedNode && lastActive.nodes?.length) {
                    lastActive.selectedNode = lastActive.nodes[0].name;
                    this._saveProfiles();
                }
                if (lastActive) {
                    this.emit('profile-activated', lastActive.id);
                } else {
                    this.checked = false;
                }
            } else {
                this._activeProfileId = null;
                this.emit('profile-deactivated');
            }
            this._rebuildMenu();
        });

        this._emptySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._emptySection);

        this._emptyLabel = new PopupMenu.PopupMenuItem(_('No profiles'));
        this._emptyLabel.reactive = false;
        this._emptySection.addMenuItem(this._emptyLabel);

        this._profilesSection = new PopupMenu.PopupMenuSection();
        this._profilesSection.actor.add_style_class_name('quickvpn-profiles');
        this.menu.addMenuItem(this._profilesSection);

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);

        const entryItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._entry = new St.Entry({
            hint_text: _('Paste subscription URL...'),
            can_focus: true,
            style_class: 'quickvpn-entry',
        });
        this._entry.clutter_text.connect('activate', () => this._addFromEntry());
        entryItem.add_child(this._entry);
        this.menu.addMenuItem(entryItem);

        this._addBtn = new PopupMenu.PopupMenuItem(_('➕ Add'));
        this._addBtn.connect('activate', () => this._addFromEntry());
        this.menu.addMenuItem(this._addBtn);

        this._statusItem = new PopupMenu.PopupMenuItem('');
        this._statusItem.reactive = false;
        this.menu.addMenuItem(this._statusItem);

        this._pingItem = new PopupMenu.PopupMenuItem(_('Проверить пинг'));
        this._pingItem.connect('activate', () => this._checkPing());
        this.menu.addMenuItem(this._pingItem);

        this.setStatus(_('No VPN'));
    }

    set storePath(v) { this._storePath = v; }

    setProfiles(profiles) {
        this._profiles = profiles;
        this._rebuildMenu();
    }

    _rebuildMenu() {
        this._profilesSection.removeAll();
        this._profileItems.clear();
        this._nodeItems.clear();

        const profiles = this._profiles;
        this._emptySection.visible = profiles.length === 0;
        this._separator.visible = profiles.length > 0;

        if (profiles.length === 0) {
            this._activeProfileId = null;
            this.checked = false;
            this.setStatus(_('No VPN'));
            return;
        }

        for (const profile of profiles) {
            const usedGB = bytesToGB((profile.upload || 0) + (profile.download || 0));
            const totalGB = bytesToGB(profile.total || 0);
            const expireStr = formatDate(profile.expire);
            const traffic = profile.total
                ? `${usedGB}/${totalGB} GB`
                : `${usedGB} GB`;
            const text = `${profile.label}  ${traffic}  до ${expireStr}`;

            const item = new PopupMenu.PopupSubMenuMenuItem(text, true);
            item._profileId = profile.id;
            const submenu = item.menu;
            submenu.actor.add_style_class_name('quickvpn-submenu');

        if (this._activeProfileId === profile.id) {
            item.setOrnament(PopupMenu.Ornament.DOT);
        } else {
                const connectItem = new PopupMenu.PopupMenuItem(_('✓ Connect'));
                connectItem.connect('activate', () => {
                    if (!profile.selectedNode && profile.nodes?.length) {
                        profile.selectedNode = profile.nodes[0].name;
                        this._saveProfiles();
                    }
                    this._activeProfileId = profile.id;
                    this.checked = true;
                    this.emit('profile-activated', profile.id);
                    this._rebuildMenu();
                });
                submenu.addMenuItem(connectItem);
            }

            submenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const headerItem = new PopupMenu.PopupMenuItem(_('Nodes:'), { reactive: false });
            submenu.addMenuItem(headerItem);

            for (const node of (profile.nodes || [])) {
                const portStr = node.port ? `:${node.port}` : '';
                const nodeText = `${truncateText(node.name, 38)}  [${node.type}]`;
                const nodeItem = new PopupMenu.PopupMenuItem(nodeText);
                nodeItem._profileId = profile.id;
                nodeItem._nodeName = node.name;

                if (profile.selectedNode === node.name) {
                    nodeItem.setOrnament(PopupMenu.Ornament.DOT);
                }

                nodeItem.connect('activate', () => {
                    profile.selectedNode = node.name;
                    this._updateNodeOrnaments(profile);
                    this.setStatus(`${profile.label}: ${node.name}`);
                    this._saveProfiles();
                    if (this._activeProfileId !== profile.id) {
                        this._activeProfileId = profile.id;
                        this.checked = true;
                        this.emit('profile-activated', profile.id);
                    } else {
                        this._callMihomo('switch', profile.id, node.name);
                    }
                    Main.notify(_('Quick VPN'), `${profile.label}: ${node.name}`);
                });

                this._nodeItems.set(`${profile.id}:${node.name}`, nodeItem);
                submenu.addMenuItem(nodeItem);
            }

            submenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const removeItem = new PopupMenu.PopupMenuItem(_('🗑 Remove'));
            removeItem.connect('activate', () => {
                this._removeProfile(profile);
                this._activeProfileId = null;
                this.checked = false;
                this.emit('profile-deactivated');
            });
            submenu.addMenuItem(removeItem);

            this._profileItems.set(profile.id, item);
            this._profilesSection.addMenuItem(item);
        }

        const activeProfile = profiles.find(p => p.id === this._activeProfileId);
        if (activeProfile) {
            const usedGB = bytesToGB((activeProfile.upload || 0) + (activeProfile.download || 0));
            const totalGB = bytesToGB(activeProfile.total || 0);
            const traffic = activeProfile.total
                ? `${usedGB}/${totalGB} GB`
                : `${usedGB} GB`;
            this.setStatus(`${activeProfile.label}  ${traffic}`);
        } else {
            this.setStatus(_('Select VPN'));
        }
    }

    _updateNodeOrnaments(profile) {
        for (const [key, item] of this._nodeItems) {
            const [pid, nodeName] = key.split(':');
            if (pid === profile.id) {
                item.setOrnament(nodeName === profile.selectedNode
                    ? PopupMenu.Ornament.DOT
                    : PopupMenu.Ornament.NONE);
            }
        }
    }

    _removeProfile(profile) {
        const idx = this._profiles.indexOf(profile);
        if (idx > -1) {
            if (this._activeProfileId === profile.id) {
                this._callMihomo('stop', profile.id);
                this._activeProfileId = null;
                this.checked = false;
                this.emit('profile-deactivated');
            }
            this._profiles.splice(idx, 1);
            this._saveProfiles();
            this._rebuildMenu();
            Main.notify(_('Quick VPN'), `${profile.label} removed`);
        }
    }

    _saveConfig(profileId, body) {
        try {
            const configDir = `${this._storePath}/configs`;
            GLib.mkdir_with_parents(configDir, 0o755);
            GLib.file_set_contents(`${configDir}/${profileId}.yaml`, body);
        } catch (e) {
            logCrash(this._storePath, `Save config error: ${e}`);
        }
    }

    _callMihomo(action, profileId, nodeName) {
        const scriptPath = `${this._storePath}/mihomo_helper.py`;
        const args = ['python3', scriptPath, this._storePath, action];
        if (profileId) args.push(profileId);
        if (nodeName) args.push(nodeName);

        try {
            const proc = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (stdout?.trim()) logCrash(this._storePath, `mihomo: ${stdout.trim()}`);
                    if (!proc.get_successful() && stderr?.trim()) {
                        logCrash(this._storePath, `mihomo error: ${stderr.trim()}`);
                    }
                } catch (e) {
                    logCrash(this._storePath, `mihomo callback error: ${e}`);
                }
            });
        } catch (e) {
            logCrash(this._storePath, `Failed to run mihomo: ${e}`);
        }
    }

    _fetchAndAddProfile(url) {
        if (this._isFetching) return;
        this._isFetching = true;
        this.setStatus(_('Downloading...'));

        const hwid = getDeviceHwid(this._storePath);
        const args = [
            'curl', '-s', '-L', '-f', '-D', '-',
            '-H', `user-agent: FlClash X/v1.19.25 Platform/Linux`,
            '-H', `x-hwid: ${hwid}`,
            '-H', 'x-device-os: Linux',
            '-H', 'x-ver-os: 6.8',
            '-H', 'x-device-model: Arch Linux',
            url,
        ];

        try {
            const proc = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                this._isFetching = false;
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (!proc.get_successful()) {
                        const errMsg = (stderr || '').trim() || 'curl error';
                        logCrash(this._storePath, `Download failed: ${errMsg}`);
                        Main.notify(_('Quick VPN'), `Download failed: ${errMsg}`);
                        this.setStatus(_('Error'));
                        return;
                    }

                    const output = stdout || '';
                    const idx = output.lastIndexOf('\r\n\r\n');
                    const headerSection = idx !== -1 ? output.substring(0, idx) : '';
                    const body = idx !== -1 ? output.substring(idx + 4) : output;

                    let subInfoRaw = '';
                    let profileTitleRaw = '';
                    for (const line of headerSection.split('\r\n')) {
                        const lline = line.toLowerCase();
                        if (lline.startsWith('subscription-userinfo:')) {
                            subInfoRaw = line.substring('subscription-userinfo:'.length).trim();
                        } else if (lline.startsWith('profile-title:')) {
                            profileTitleRaw = line.substring('profile-title:'.length).trim();
                        }
                    }

                    this._processConfig(url, body, subInfoRaw, profileTitleRaw);
                } catch (e) {
                    logCrash(this._storePath, `Download callback error: ${e}`);
                    Main.notify(_('Quick VPN'), 'Failed to download config');
                    this.setStatus(_('Error'));
                }
            });
        } catch (e) {
            this._isFetching = false;
            logCrash(this._storePath, `Failed to run curl: ${e}`);
            Main.notify(_('Quick VPN'), 'Failed to download config');
            this.setStatus(_('Error'));
        }
    }

    _processConfig(url, body, subInfoRaw, profileTitleRaw) {
        const tmpDir = GLib.get_tmp_dir();
        const tmpFile = `${tmpDir}/quickvpn-${Date.now()}.yaml`;

        try {
            GLib.file_set_contents(tmpFile, body);

            const scriptPath = `${this._storePath}/parse_config.py`;
            const proc = Gio.Subprocess.new(
                ['python3', scriptPath, tmpFile, subInfoRaw, profileTitleRaw],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (!proc.get_successful()) {
                        const parseErr = (stderr || '').trim() || 'parse error';
                        logCrash(this._storePath, `Parse config failed: ${parseErr}`);
                        Main.notify(_('Quick VPN'), `Parse error: ${parseErr}`);
                        this.setStatus(_('Error'));
                        GLib.remove(tmpFile);
                        return;
                    }

                    const result = JSON.parse(stdout.trim());
                    const label = result.label || parseLabelFromUrl(url) || getDomainFromUrl(url);
                    const profile = {
                        id: Date.now().toString(),
                        label,
                        url,
                        upload: result.upload || 0,
                        download: result.download || 0,
                        total: result.total || 0,
                        expire: result.expire || 0,
                        nodes: result.proxies || [],
                        selectedNode: '',
                    };

                    this._profiles.push(profile);
                    this._saveConfig(profile.id, body);
                    this._saveProfiles();
                    this._rebuildMenu();

                    const usedGB = bytesToGB(profile.upload + profile.download);
                    const totalGB = bytesToGB(profile.total);
                    const traffic = profile.total
                        ? `${usedGB}/${totalGB} GB`
                        : `${usedGB} GB`;
                    Main.notify(_('Quick VPN'),
                        `${label}: ${profile.nodes.length} nodes, ${traffic}`);
                } catch (e) {
                    const raw = stdout ? stdout.trim().substring(0, 500) : '(empty)';
                    logCrash(this._storePath, `Parse error: ${e}\n  stdout: ${raw}`);
                    Main.notify(_('Quick VPN'), 'Failed to parse config');
                    this.setStatus(_('Error'));
                } finally {
                    GLib.remove(tmpFile);
                }
            });
        } catch (e) {
            logCrash(this._storePath, `File error: ${e}`);
            Main.notify(_('Quick VPN'), 'Failed to process config');
            this.setStatus(_('Error'));
        }
    }

    _addFromEntry() {
        const text = this._entry.get_text();
        if (!text || text.trim().length === 0) {
            Main.notify(_('Quick VPN'), _('Enter a subscription URL'));
            return;
        }

        const configUrl = extractConfigUrl(text.trim());
        if (!configUrl) {
            Main.notify(_('Quick VPN'),
                _('Enter a valid subscription URL or flclashx://install-config link'));
            return;
        }

        this._fetchAndAddProfile(configUrl);
        this._entry.set_text('');
    }

    _saveProfiles() {
        if (!this._storePath) return;
        try {
            GLib.file_set_contents(
                `${this._storePath}/profiles.json`,
                JSON.stringify(this._profiles, null, 2)
            );
        } catch (e) {
            logCrash(this._storePath, `Save error: ${e}`);
        }
    }

    loadProfiles() {
        if (!this._storePath) return [];
        try {
            const [ok, contents] = GLib.file_get_contents(`${this._storePath}/profiles.json`);
            if (ok && contents) {
                const str = typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
                return JSON.parse(str);
            }
        } catch (e) {
            logCrash(this._storePath, `Load error: ${e}`);
        }
        return [];
    }

    setStatus(text) {
        this._statusItem.label.text = text;
    }

    _checkPing() {
        const profilesToPing = this._profiles.length > 0 ? this._profiles : [];
        if (profilesToPing.length === 0) return;

        this._pingItem.setSensitive(false);
        this._pingItem.label.text = _('Пингую...');

        const allNodes = [];
        for (const profile of profilesToPing) {
            for (const node of (profile.nodes || [])) {
                if (node.server) {
                    allNodes.push({ profileLabel: profile.label, nodeName: node.name, server: node.server });
                }
            }
        }

        if (allNodes.length === 0) {
            this._pingItem.setSensitive(true);
            this._pingItem.label.text = _('Проверить пинг');
            Main.notify(_('Quick VPN'), _('No nodes to ping'));
            return;
        }

        const promises = allNodes.map(async (n) => {
            const ping = await pingHost(n.server);
            return { ...n, ping };
        });

        Promise.all(promises).then((results) => {
            this._pingItem.setSensitive(true);
            this._pingItem.label.text = _('Проверить пинг');

            results.sort((a, b) => {
                if (a.ping === null && b.ping === null) return 0;
                if (a.ping === null) return 1;
                if (b.ping === null) return -1;
                return a.ping - b.ping;
            });

            let msg = '';
            for (const r of results) {
                const status = r.ping !== null ? `${r.ping}ms` : '✗';
                msg += `${r.profileLabel}: ${truncateText(r.nodeName, 30)} — ${status}\n`;
            }
            Main.notify(_('Quick VPN — Ping'), msg.trim());
        });
    }
});

export default class QuickVpnExtension extends Extension {
    _callMihomo(action, profileId, nodeName) {
        const scriptPath = `${this.path}/mihomo_helper.py`;
        const args = ['python3', scriptPath, this.path, action];
        if (profileId) args.push(profileId);
        if (nodeName) args.push(nodeName);

        try {
            const proc = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                    if (stdout?.trim()) logCrash(this.path, `mihomo: ${stdout.trim()}`);
                    if (!proc.get_successful() && stderr?.trim()) {
                        logCrash(this.path, `mihomo error: ${stderr.trim()}`);
                    }
                } catch (e) {
                    logCrash(this.path, `mihomo callback error: ${e}`);
                }
            });
        } catch (e) {
            logCrash(this.path, `Failed to run mihomo: ${e}`);
        }
    }

    _saveProxyState() {
        const s = new Gio.Settings({ schema_id: 'org.gnome.system.proxy' });
        this._savedProxyMode = s.get_string('mode');
        this._savedProxySame = s.get_boolean('use-same-proxy');
        this._savedHttpHost = s.get_string('http-host');
        this._savedHttpPort = s.get_int('http-port');
        this._savedHttpsHost = s.get_string('https-host');
        this._savedHttpsPort = s.get_int('https-port');
        this._savedSocksHost = s.get_string('socks-host');
        this._savedSocksPort = s.get_int('socks-port');
    }

    _enableProxy() {
        this._saveProxyState();
        const s = new Gio.Settings({ schema_id: 'org.gnome.system.proxy' });
        s.set_boolean('use-same-proxy', false);
        s.set_string('mode', 'manual');
        s.set_string('http-host', '127.0.0.1');
        s.set_int('http-port', 7890);
        s.set_string('https-host', '127.0.0.1');
        s.set_int('https-port', 7890);
        s.set_string('socks-host', '127.0.0.1');
        s.set_int('socks-port', 7891);
        this._proxyEnabled = true;
    }

    _disableProxy() {
        if (!this._proxyEnabled) return;
        this._proxyEnabled = false;
        const s = new Gio.Settings({ schema_id: 'org.gnome.system.proxy' });
        s.set_boolean('use-same-proxy', this._savedProxySame ?? true);
        s.set_string('mode', this._savedProxyMode || 'none');
        s.set_string('http-host', this._savedHttpHost || '');
        s.set_int('http-port', this._savedHttpPort ?? 0);
        s.set_string('https-host', this._savedHttpsHost || '');
        s.set_int('https-port', this._savedHttpsPort ?? 0);
        s.set_string('socks-host', this._savedSocksHost || '');
        s.set_int('socks-port', this._savedSocksPort ?? 0);
    }

    enable() {
        const iconPath = `${this.path}/icons/quickvpn-symbolic.svg`;
        this._proxyEnabled = false;

        try {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const stylesheetFile = Gio.File.new_for_path(`${this.path}/stylesheet.css`);
            this._stylesheetId = themeContext.get_theme().load_stylesheet(stylesheetFile);
        } catch (e) {
            log(`Quick VPN: stylesheet load error: ${e}`);
        }

        this._indicator = new QuickSettings.SystemIndicator();
        this._indicator._indicator = this._indicator._addIndicator();
        const iconFile = Gio.File.new_for_path(iconPath);
        this._indicator._indicator.gicon = Gio.FileIcon.new(iconFile);
        this._indicator._indicator.reactive = true;

        this._toggle = new QuickVpnToggle(iconPath);
        this._toggle.storePath = this.path;

        this._indicator.quickSettingsItems.push(this._toggle);
        QuickSettingsMenu.addExternalIndicator(this._indicator);

        const profiles = this._toggle.loadProfiles();
        this._toggle.setProfiles(profiles);
        this._toggle.setStatus(profiles.length > 0 ? _('Select VPN') : _('No VPN'));

        this._toggle.connect('profile-activated', (t, id) => {
            logCrash(this.path, `Profile activated: ${id}`);
            this._callMihomo('start', id);
            this._enableProxy();
        });

        this._toggle.connect('profile-deactivated', () => {
            this._callMihomo('stop');
            this._disableProxy();
        });
    }

    disable() {
        this._callMihomo('stop');
        this._disableProxy();

        if (this._toggle) {
            this._toggle.destroy();
            this._toggle = null;
        }
        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._stylesheetId != null) {
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            themeContext.get_theme().unload_stylesheet(this._stylesheetId);
            this._stylesheetId = null;
        }
    }
}

// desktop-lrc — 本地桌面歌词 GNOME Shell 扩展
// SPDX-License-Identifier: MIT
//
// 读取歌词目录（默认 ~/Music）中与歌曲同名的 “歌手 - 歌名.lrc” 文件，
// 通过 MPRIS 跟随任意播放器（Rhythmbox 等）逐行滚动显示在桌面上。
// 左侧 ⠿ 小手柄可拖动调整位置；歌词文字区域本身不拦截鼠标（可穿透点击）。

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'gi://cairo';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const IFACE = 'org.mpris.MediaPlayer2.Player';
const LOG = (...a) => console.log('[desktop-lrc]', ...a);

const statusOf = p => p.get_cached_property('PlaybackStatus')?.unpack() ?? '';

// 递归拆开 GLib.Variant（deepUnpack 不进 'v'，unpack 不进数组，两边都补上）
const deep = v => v instanceof GLib.Variant ? deep(v.unpack())
    : Array.isArray(v) ? v.map(deep)
    : v;

// GJS 枚举兼容：新版枚举可能是 {value} 对象，统一转数字
const enumNum = v => typeof v === 'number' ? v : Number(v?.value ?? NaN);

// Pango 离屏测量文本像素宽度（不依赖 St 布局，避开缩放与时序问题）
let _layout = null;
function measureText(text, fam, size) {
    try {
        _layout ??= PangoCairo.create_layout(new Cairo.Context(new Cairo.ImageSurface(Cairo.Format.ARGB32, 0, 0)));
        _layout.set_font_description(Pango.FontDescription.from_string(`${fam} ${size}`));
        _layout.set_text(text, -1);
        return _layout.get_pixel_size()[0];
    } catch {
        return text.length * size;  // 兜底估算
    }
}

function parseFont(spec, fallbackSize = 32) {
    let m = String(spec).match(/^(.*\S)\s+(\d+)$/);
    return m ? [m[1], Number(m[2])] : [String(spec || 'Sans'), fallbackSize];
}

// 模糊匹配用的规范化：去空格和标点（保留字母数字与 CJK）
const normalizeText = s => s.replace(/[^\p{L}\p{N}]+/gu, '');

const LyricBox = GObject.registerClass(class LyricBox extends St.BoxLayout {
    _init(settings, extPath) {
        super._init({vertical: true, reactive: true, style_class: 'desktop-lrc-box'});
        this._set = settings;
        this._extPath = extPath;
        this._players = new Map();  // bus name -> [proxy, signal id]
        this._active = null;
        this._song = null;
        this._lines = [];
        this._idx = 0;
        this._offset = 0;
        this._index = null;         // 小写文件名 -> 实际文件名
        this._curText = '';
        this._nextText = '';
        this._lastIdx = -1;
        this._dead = false;
        this._drag = null;
        this._dragged = false;

        this._buildUi();
        this._watchSettings();
        this._buildGesture();
        LOG('style-v9 紧凑图标');
        // GNOME 50: 确保不处于“拾取隐藏”状态（tuberry 同款手段）
        try {
            Shell.util_set_hidden_from_pick(this, false);
        } catch (e) {
            LOG('unhide from pick failed:', e.message);
        }


        let x = settings.get_int('x');
        let y = settings.get_int('y');
        let m = Main.layoutManager.primaryMonitor;
        let sane = x >= 0 && y >= 40 && m &&
            x >= m.x && x < m.x + m.width - 60 && y < m.y + m.height - 60;
        if (sane) {
            this._userMoved = true;
            this.set_position(x, y);
        } else {
            this._userMoved = false;  // 坐标越界/历史残留 → 回到自动位置
        }

        this._watchNames();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => this._tick());
    }

    _buildUi() {
        this._showNext = this._set.get_boolean('show-next');
        this._cur = new St.Label({style_class: 'lrc-current', reactive: true});
        this._nxt = new St.Label({style_class: 'lrc-next', reactive: true});
        this._applyStyle();

        let col = new St.BoxLayout({vertical: true});
        col.add_child(this._cur);
        col.add_child(this._nxt);

        this._grip = new St.Label({
            text: '\u283F', // ⠿
            reactive: true,
            track_hover: true,
            style_class: 'lrc-grip',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // 悬停探针：不点击也能验证事件通路（1.5s 节流防刷屏）
        this._hoverAt = 0;
        let probe = tag => {
            let now = GLib.get_monotonic_time();
            if (now - this._hoverAt > 1500000) {
                this._hoverAt = now;
                LOG('hover', tag);
            }
        };
        this._grip.connect('enter-event', () => probe('grip'));
        this._cur.connect('enter-event', () => probe('text'));

        // 第一行：手柄 + 两行歌词；操作条另起一行放歌词下方
        let row = new St.BoxLayout({vertical: false});
        row.add_child(this._grip);
        row.add_child(col);
        this.add_child(row);

        // 操作条可降级：失败只损失该功能并留日志，不影响歌词本体
        try {
            this._buildPanel();
        } catch (e) {
            LOG('panel unavailable:', e.message);
        }
        this.hide();
    }

    _buildPanel() {
        let mk = (text, cb) => {
            let b = new St.Button({label: text, style_class: 'lrc-btn', reactive: true, track_hover: true});
            b.connect('clicked', cb);
            return b;
        };
        this._panel = new St.BoxLayout({style_class: 'lrc-panel'});
        this._panel.add_child(mk('设置…', () => this._openPrefs()));
        this._posBtn = mk(this._posLabel(), () => {
            this._set.set_uint('position', (this._set.get_uint('position') + 1) % 3);
        });
        this._panel.add_child(this._posBtn);
        this._panel.add_child(mk('隐藏歌词', () => this._set.set_boolean('hidden', true)));
        this._nextBtn = mk('下一句：开', () => this._set.set_boolean('show-next', !this._showNext));
        this._panel.add_child(this._nextBtn);
        this._panel.hide();
        this.add_child(this._panel);  // 纵向容器的最后一个子项 = 歌词下方
    }

    _nextLabel() {
       return `下一句：${this._showNext ? '开' : '关'}`;
    }

    _posLabel() {
        return `位置：${['底部', '中部', '顶部'][this._set.get_uint('position')] ?? '底部'}`;
    }

    _openPrefs() {
        LOG('open prefs');
        // Ubuntu 26.04 的 shell prefs 服务自身资源缺失（系统 bug），直接启动独立设置窗口
        let script = `${this._extPath}/prefs-app.js`;
        let envp = [...GLib.get_environ(), `GSETTINGS_SCHEMA_DIR=${this._extPath}/schemas`];
        try {
            GLib.spawn_async(null, ['gjs', '-m', script], envp,
                GLib.SpawnFlags.SEARCH_PATH, () => {});
        } catch (e) {
            LOG('prefs spawn failed:', e.message);
        }
    }

    _applyStyle() {
        let [fam, size] = parseFont(this._set.get_string('font-name'));
        let mon = Main.layoutManager.primaryMonitor;
        let cap = Math.round((mon ? mon.width : 1920) * 0.9);
        // 长句自动缩小字号以适配屏宽（千千静听式），短句保持原字号
        let fit = text => {
            let w = measureText(text, fam, size);
            return w > cap ? Math.max(16, Math.floor(size * cap / w)) : size;
        };
        let cs = fit(this._curText ?? '');
        let ns = fit(this._showNext ? this._nextText ?? '' : '');
        this._cur.style = `font-family: ${fam}; font-size: ${cs}px; color: ${this._set.get_string('active-color')};`;
        // 下一句同字号（超长句独立适配），右侧错开一个字位
        this._nxt.style = `font-family: ${fam}; font-size: ${ns}px; color: ${this._set.get_string('next-color')}; margin-left: ${Math.round(size * 1.2)}px;`;
        this._recentre();
    }

    _watchSettings() {
        this._setSig = this._set.connect('changed', (s, key) => {
            switch (key) {
                case 'font-name':
                case 'active-color':
                case 'next-color':
                    this._applyStyle();
                    break;
                case 'show-next':
                    this._showNext = s.get_boolean(key);
                    this._curText = null;  // 强制刷新两行文本
                    this._setLine(this._lastIdx);
                    if (this._nextBtn) this._nextBtn.label = this._nextLabel();
                    break;
                case 'lyric-dir':
                    this._index = null;
                    this._norms = null;
                    break;
                case 'x':
                case 'y':
                    if (s.get_int('x') < 0 || s.get_int('y') < 0) {
                        this._userMoved = false;
                        this._applyAutoPos();
                    }
                    break;
                case 'position':
                    this._userMoved = false;
                    this._applyAutoPos();
                    if (this._posBtn) this._posBtn.label = this._posLabel();
                    break;
                case 'hidden':
                    if (s.get_boolean(key)) this.hide();
                    else this._pick();
                    break;
            }
        });
    }

    // ---------- 播放器发现（MPRIS） ----------

    _watchNames() {
        let bus = Gio.DBus.session;
        this._sub = bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (c, s, p, i, sig, params) => {
                let [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX)) return;
                if (newOwner) this._addPlayer(name);
                else this._removePlayer(name);
            });
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, null,
            (s, r) => {
                if (this._dead) return;
                try {
                    for (let name of bus.call_finish(r).deepUnpack()[0]) {
                        if (name.startsWith(PREFIX)) this._addPlayer(name);
                    }
                } catch (e) {
                    LOG('ListNames fail', e.message);
                }
            });
    }

    _addPlayer(name) {
        if (this._dead || this._players.has(name)) return;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            name, '/org/mpris/MediaPlayer2', IFACE, null, (s, r) => {
                if (this._dead) return;
                try {
                    let proxy = Gio.DBusProxy.new_for_bus_finish(r);
                    let sig = proxy.connect('g-properties-changed', (p, changed) => {
                        let c = changed.deepUnpack();
                        if ('Metadata' in c || 'PlaybackStatus' in c) this._pick();
                    });
                    this._players.set(name, [proxy, sig]);
                    LOG('player up:', name);
                    this._pick();
                } catch (e) {
                    LOG('proxy fail', name, e.message);
                }
            });
    }

    _removePlayer(name) {
        let entry = this._players.get(name);
        if (!entry) return;
        let [proxy, sig] = entry;
        proxy.disconnect(sig);
        this._players.delete(name);
        LOG('player down:', name);
        this._pick();
    }

    _pick() {
        if (this._dead) return;
        if (this._set.get_boolean('hidden')) {  // 用户隐藏时无论播放状态都不显示
            this.hide();
            return;
        }
        let list = [...this._players.values()].map(([p]) => p);
        let cur = this._active;
        let pick = null;
        if (cur && statusOf(cur) === 'Playing') {
            pick = cur;
        } else {
            pick = list.find(p => statusOf(p) === 'Playing') ??
                (cur && statusOf(cur) === 'Paused' ? cur : list.find(p => statusOf(p) === 'Paused')) ??
                null;
        }
        this._active = pick;
        if (!pick) {
            this.hide();
            this._song = null;
            this._lines = [];
            return;
        }
        let song = this._meta(pick);
        if (!song) {
            this.hide();
            return;
        }
        this.show();
        if (!this._song || song.key !== this._song.key) this._load(song);
    }

    _meta(proxy) {
        let v = proxy.get_cached_property('Metadata');
        if (!v) return null;
        let m = v.deepUnpack();
        let title = deep(m['xesam:title']);
        if (typeof title !== 'string' || !title) return null;
        let artistRaw = deep(m['xesam:artist']) ?? [];
        let artist = Array.isArray(artistRaw) ? artistRaw : [String(artistRaw)];
        artist = artist.filter(a => typeof a === 'string' && a);
        return {title, artist, key: title + ' ' + artist.join('/')};
    }

    // ---------- 歌词查找与解析 ----------

    _dirFile() {
        let spec = this._set.get_string('lyric-dir');
        if (spec.startsWith('~/')) spec = GLib.get_home_dir() + spec.slice(1);
        return Gio.File.new_for_commandline_arg(spec);
    }

    _scan(dir) {
        let map = new Map();
        let norms = new Map();
        try {
            let kids = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = kids.next_file(null))) {
                let name = info.get_name();
                let low = name.toLowerCase();
                if (low.endsWith('.lrc')) {
                    map.set(low, name);
                    norms.set(normalizeText(low), name);
                }
            }
            kids.close(null);
        } catch (e) {
            LOG('scan fail', e.message);
        }
        this._norms = norms;
        return map;
    }

    _findFile(song) {
        let dir = this._dirFile();
        if (!this._index) this._index = this._scan(dir);
        let hit = this._lookup(dir, song);
        if (!hit) {  // 目录里可能新增了文件，重扫一次再试
            this._index = this._scan(dir);
            hit = this._lookup(dir, song);
        }
        return hit;
    }

    _lookup(dir, song) {
        let want = `${song.artist.join(' _ ')} - ${song.title}`.toLowerCase();
        let hit = this._index.get(want + '.lrc');
        if (!hit) {
            // 兜底1：同曲名、不同歌手写法的文件（“歌手 - 歌名.lrc” 按后缀匹配）
            let suffix = ` - ${song.title.toLowerCase()}.lrc`;
            let keys = [...this._index.keys()].filter(k => k.endsWith(suffix));
            let a0 = song.artist[0]?.toLowerCase();
            hit = this._index.get(keys.find(k => a0 && k.startsWith(a0)) ?? keys[0]);
        }
        if (!hit) {
            // 兜底2：忽略空格与标点的模糊匹配（处理 “/” 等字符差异）
            let nt = normalizeText(song.title.toLowerCase());
            if (nt.length >= 3 && this._norms) {
                let keys = [...this._norms.keys()].filter(k => k.endsWith(nt + 'lrc'));
                let na = normalizeText(song.artist[0]?.toLowerCase() ?? '');
                hit = this._norms.get(keys.find(k => na && k.includes(na)) ?? keys[0]);
            }
        }
        return hit ? dir.get_child(hit) : null;
    }

    _load(song) {
        this._song = song;
        this._lines = [];
        this._offset = 0;
        this._idx = 0;
        this._setLine(-1);  // 加载期间先显示歌名
        LOG('loading:', song.artist.join(' _ '), '-', song.title);
        let file = this._findFile(song);
        if (!file) {
            LOG('no lrc for:', song.artist.join(' _ '), '-', song.title);
            return;
        }
        file.load_contents_async(null, (s, r) => {
            if (this._dead || !this._song || this._song.key !== song.key) return;
            try {
                let [, bytes] = file.load_contents_finish(r);
                let parsed = this._parse(this._decode(bytes));
                this._lines = parsed.lines;
                this._offset = parsed.offset;
                this._idx = 0;
                this._setLine(-1);
                LOG('loaded', file.get_basename(), parsed.lines.length, 'lines');
            } catch (e) {
                LOG('read fail', file.get_basename(), e.message);
            }
        });
    }

    _decode(bytes) {
        try {
            return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch {
            try {
                return new TextDecoder('gbk').decode(bytes);
            } catch {
                return new TextDecoder('utf-8').decode(bytes);
            }
        }
    }

    _parse(text) {
        let offset = 0;
        let lines = [];
        for (let raw of text.split(/\r?\n/)) {
            let tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
            if (!tags.length) {
                let om = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
                if (om) offset = Number(om[1]);
                continue;
            }
            let content = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
            if (!content) continue;
            for (let t of tags) {
                let frac = (t[3] ?? '').padEnd(3, '0').slice(0, 3);
                lines.push({t: (Number(t[1]) * 60 + Number(t[2])) * 1000 + Number(frac), text: content});
            }
        }
        lines.sort((a, b) => a.t - b.t);
        return {lines, offset};
    }

    // ---------- 播放进度与显示 ----------

    _tick() {
        if (this._dead) return GLib.SOURCE_REMOVE;
        let p = this._active;
        if (!p || statusOf(p) !== 'Playing') return GLib.SOURCE_CONTINUE;
        p.call('org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [IFACE, 'Position']),
            Gio.DBusCallFlags.NONE, -1, null,
            (s, r) => {
                if (this._dead || !this._active) return;
                try {
                    this._update(deep(p.call_finish(r).deepUnpack()[0]) / 1000);
                } catch {
                    // 播放器退出等瞬态错误，忽略
                }
            });
        return GLib.SOURCE_CONTINUE;
    }

    _update(posMs) {
        if (!Number.isFinite(posMs)) return;
        posMs -= this._offset;
        let L = this._lines;
        if (!L.length) return;
        if (this._idx > 0 && L[this._idx - 1].t > posMs) this._idx = 0;  // 回退（seek）
        while (this._idx < L.length && L[this._idx].t <= posMs) this._idx++;
        this._setLine(this._idx - 1);
    }

    _setLine(idx) {
        this._lastIdx = idx;
        let cur;
        let next = '';
        if (!this._song) {
            cur = '';
        } else if (!this._lines.length || idx < 0) {
            cur = `${this._song.artist.join(' _ ')} - ${this._song.title}`;
        } else {
            cur = this._lines[idx]?.text ?? '';
            if (this._showNext) next = this._lines[idx + 1]?.text ?? '';
        }
        if (cur === this._curText && next === this._nextText) return;
        this._curText = cur;
        this._nextText = next;
        this._cur.set_text(cur);
        this._nxt.set_text(next);
        this._applyStyle();
    }

    _recentre() {
        if (this._userMoved || this._drag || !this.visible) return;  // 拖动中不许吸回
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._dead) this._applyAutoPos();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyAutoPos() {
        let m = Main.layoutManager.focusMonitor ?? Main.layoutManager.primaryMonitor;
        if (!m) return;
        let pos = this._set.get_uint('position');
        let y = pos === 2 ? m.y + 40
            : pos === 1 ? m.y + Math.round((m.height - this.height) / 2)
            : m.y + m.height - 170;
        this.set_position(m.x + Math.round((m.width - this.width) / 2), y);
    }

    // ---------- 拖动 ----------

    // ---------- 拖动：官方 DND 同款配方 ----------
    // St.DndStartGesture 手势识别按下 + Main.pushModal 模态抓取 + 'event' 通用信号
    // （官方注释：指针被抓取时捕获阶段不发生，故不用 captured-event；per-type 信号不可靠）

    _buildGesture() {
        this._modal = null;
        this._gesture = new St.DndStartGesture();
        this._gesture.connect('recognize', () => this._beginDrag());
        this.add_action(this._gesture);
        this.connect('event', (a, e) => this._onEvent(e));
    }

    _onEvent(e) {
        if (this._dead) return Clutter.EVENT_PROPAGATE;
        let t = enumNum(e.type());
        if (this._modal) return this._onModalEvent(t);
        if (t === enumNum(Clutter.EventType.BUTTON_PRESS) && e.get_button() === 3) {
            if (this._nextBtn) this._nextBtn.label = this._nextLabel();
            if (this._panel) this._panel.visible ? this._panel.hide() : this._panel.show();
            this._recentre();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _beginDrag() {
        if (this._modal) return;  // 手势重复触发防重入（模态计数不平衡会锁死输入）
        LOG('drag begin (gesture)');
        try {
            this._modal = Main.pushModal(this);
        } catch (e) {
            LOG('pushModal failed:', e.message);
            return;
        }
        this._dragBase = [this.x, this.y];
        this._pointer0 = global.get_pointer().slice(0, 2);
        this._dragged = false;
    }

    _onModalEvent(t) {
        if (t === enumNum(Clutter.EventType.MOTION)) {
            let [px, py] = global.get_pointer();
            let nx = this._dragBase[0] + px - this._pointer0[0];
            let ny = this._dragBase[1] + py - this._pointer0[1];
            let m = Main.layoutManager.primaryMonitor;
            if (m) {
                nx = Math.min(Math.max(nx, m.x + 20), m.x + m.width - 60);
                ny = Math.min(Math.max(ny, m.y + 40), m.y + m.height - 60);
            }
            if (Number.isFinite(nx) && Number.isFinite(ny)) {
                this.set_position(Math.round(nx), Math.round(ny));
                if (!this._dragged) {
                    this._dragged = true;
                    LOG('drag move', Math.round(nx), Math.round(ny));
                }
            }
            return Clutter.EVENT_STOP;
        }
        if (t === enumNum(Clutter.EventType.BUTTON_RELEASE)) {
            this._endDragModal();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _endDragModal() {
        if (this._modal) {
            try { Main.popModal(this._modal); } catch (e) {}
            this._modal = null;
        }
        this._userMoved = true;
        if (Number.isFinite(this.x) && Number.isFinite(this.y)) {
            this._set.set_int('x', this.x);
            this._set.set_int('y', this.y);
        }
        LOG('drag end', this.x, this.y);
    }

    destroy() {
        this._dead = true;
        if (this._timer) GLib.source_remove(this._timer);
        if (this._sub) Gio.DBus.session.signal_unsubscribe(this._sub);
        if (this._setSig) this._set.disconnect(this._setSig);
        if (this._modal) {
            try { Main.popModal(this._modal); } catch (e) {}
            this._modal = null;
        }
        for (let [, [p, sig]] of this._players) p.disconnect(sig);
        this._players.clear();
        super.destroy();
    }
});

export default class DesktopLrcExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._box = new LyricBox(this._settings, this.path);
        Main.uiGroup.add_child(this._box);  // 直挂 uiGroup（tuberry 同款），绕开 chrome 输入区域机制

        // 顶栏音乐图标：歌词的常驻开关（隐藏状态下也能从此恢复）
        this._tray = new PanelMenu.Button(0.0, 'Desktop LRC', true);
        this._tray.style = '-natural-hpadding: 2px; -minimum-hpadding: 1px;';  // 压缩到与 appindicator 图标同宽
        this._trayIcon = new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'system-status-icon'});
        this._tray.add_child(this._trayIcon);
        Main.panel.addToStatusArea('desktop-lrc', this._tray);
        this._trayIcon.opacity = this._settings.get_boolean('hidden') ? 40 : 255;
        this._trayEvent = this._tray.connect('event', (a, e) => {
            if (enumNum(e.type()) === enumNum(Clutter.EventType.BUTTON_PRESS)) {
                this._settings.set_boolean('hidden', !this._settings.get_boolean('hidden'));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._traySync = this._settings.connect('changed::hidden', s => {
            this._trayIcon.opacity = s.get_boolean('hidden') ? 40 : 255;
        });
    }

    disable() {
        if (this._traySync) this._settings.disconnect(this._traySync);
        if (this._trayEvent) this._tray.disconnect(this._trayEvent);
        if (this._tray) {
            this._tray.destroy();
            this._tray = null;
        }
        this._box?.destroy();
        this._box = null;
    }
}

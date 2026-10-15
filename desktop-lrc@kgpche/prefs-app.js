// Desktop LRC 独立设置窗口
// 绕开 Ubuntu 26.04 gnome-shell prefs 服务的资源缺失 bug（org.gnome.Shell.Extensions
// 加载 resource:///org/gnome/shell/extensions/extension.js 失败），只用 GTK4 + gsettings。
// 用法：GSETTINGS_SCHEMA_DIR=<扩展目录>/schemas gjs -m prefs-app.js

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import System from 'system';

const SCHEMA = 'org.gnome.shell.extensions.desktop-lrc';

const app = new Gtk.Application({application_id: 'org.joker.desktop-lrc.prefs'});

app.connect('activate', () => {
    let settings = Gio.Settings.new(SCHEMA);
    let grid = new Gtk.Grid({
        row_spacing: 14,
        column_spacing: 12,
        margin_top: 18,
        margin_bottom: 18,
        margin_start: 18,
        margin_end: 18,
    });
    let row = 0;
    let add = (text, widget) => {
        grid.attach(new Gtk.Label({label: text, halign: Gtk.Align.START, hexpand: true}), 0, row, 1, 1);
        grid.attach(widget, 1, row, 1, 1);
        row++;
    };

    // 字体与大小
    let font = new Gtk.FontButton({halign: Gtk.Align.END});
    settings.bind('font-name', font, 'font', Gio.SettingsBindFlags.DEFAULT);
    add('字体与大小', font);

    // 颜色
    let mkColor = key => {
        let rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string(key));
        let btn = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog(), rgba, halign: Gtk.Align.END});
        btn.connect('notify::rgba', () => settings.set_string(key, btn.get_rgba().to_string()));
        return btn;
    };
    add('当前句颜色', mkColor('active-color'));
    add('下一句颜色', mkColor('next-color'));

    // 下一句预览
    let sw = new Gtk.Switch({halign: Gtk.Align.END});
    settings.bind('show-next', sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    add('显示下一句预览', sw);

    // 歌词显示开关（与顶栏音乐图标联动）
    let show = new Gtk.Switch({halign: Gtk.Align.END, active: !settings.get_boolean('hidden')});
    show.connect('notify::active', () => settings.set_boolean('hidden', !show.active));
    add('显示歌词', show);

    // 垂直位置三档
    let dd = new Gtk.DropDown({
        model: new Gtk.StringList({strings: ['底部', '中部', '顶部']}),
        halign: Gtk.Align.END,
    });
    settings.bind('position', dd, 'selected', Gio.SettingsBindFlags.DEFAULT);
    add('垂直位置', dd);

    // 回到所选档位（清除手动拖动的偏移）
    let reset = new Gtk.Button({label: '回到所选位置', halign: Gtk.Align.END});
    reset.connect('clicked', () => {
        settings.set_int('x', -1);
        settings.set_int('y', -1);
    });
    add('歌词位置', reset);

    let win = new Gtk.ApplicationWindow({application: app, title: 'Desktop LRC 设置'});
    win.set_child(grid);
    win.present();
});

app.run([System.programInvocationName]);

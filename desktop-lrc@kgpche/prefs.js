// desktop-lrc 设置界面
// SPDX-License-Identifier: MIT

import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DesktopLrcPrefs extends ExtensionPreferences {
    getPreferencesWidget() {
        let settings = this.getSettings();
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

        // 颜色（当前句 / 下一句）
        let mkColor = key => {
            let rgba = new Gdk.RGBA();
            rgba.parse(settings.get_string(key));
            let btn = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog(), rgba, halign: Gtk.Align.END});
            btn.connect('notify::rgba', () => settings.set_string(key, btn.get_rgba().to_string()));
            return btn;
        };
        add('当前句颜色', mkColor('active-color'));
        add('下一句颜色', mkColor('next-color'));

        // 下一句预览开关
        let sw = new Gtk.Switch({halign: Gtk.Align.END});
        settings.bind('show-next', sw, 'active', Gio.SettingsBindFlags.DEFAULT);
        add('显示下一句预览', sw);

        // 位置重置
        let reset = new Gtk.Button({label: '恢复默认（底部居中）', halign: Gtk.Align.END});
        reset.connect('clicked', () => {
            settings.set_int('x', -1);
            settings.set_int('y', -1);
        });
        add('歌词位置', reset);

        return grid;
    }
}

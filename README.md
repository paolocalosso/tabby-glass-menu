# tabby-glass-menu

Translucent, blurred context menus for [Tabby](https://github.com/Eugeny/tabby).

Tabby's context menus (terminal, tab header, profiles…) are Electron native
menus, and Chromium paints them fully opaque: even with a compositor blur
behind them (Blur my Shell, KWin…) nothing shows through. This plugin draws
those menus in HTML inside the Tabby window instead, with a translucent
background and a backdrop blur over the terminal. If the Tabby window itself
is translucent and blurred by the compositor, the desktop blur shows through
the menu too.

Every context menu opened by Tabby or by other plugins goes through the same
place, so all of them are replaced, with the same items and actions:
checkboxes, radio items, disabled items and submenus. Separators are left
out, and the menu uses the system UI font, so it follows it when you change
it.

## Install

### From Tabby

Settings → Plugins, search for **glass-menu**, click Install, restart Tabby.

### Manually

Copy (or symlink) this folder to
`~/.config/tabby/plugins/node_modules/tabby-glass-menu` and restart Tabby.
It's plain JavaScript, there is nothing to build.

## Settings

**Settings → Glass menu**:

- turn the glass menus on or off (off brings back the native menus)
- add a **Settings** item at the end of every menu, to open Tabby's settings
  (on by default)
- background opacity (default 0.55)
- blur of the window content behind the menu (default 12 px)
- corner radius (default 20 px)
- border: width (default 1 px, 0 for none), style (solid, dashed, dotted,
  double), color and opacity (default white at 0.06)
- show a sample menu to try the settings

The background takes the color of the Tabby theme.

## Keyboard and mouse

Like a native menu: arrow keys, Home/End, Enter or Space to activate, Right
and Left to open and close submenus, Escape to close, and typing a letter
jumps to the next item starting with it. You can also press the right
button, move to an item and release it there. The click that closes the menu
doesn't reach the terminal, so it doesn't start a selection.

## Limits

The menu is part of the window, so it can't extend past its edges: near an
edge it opens towards the inside, and a very long menu scrolls.

## License

MIT

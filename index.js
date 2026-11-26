/*
 * tabby-glass-menu — translucent, blurred context menus for Tabby.
 *
 * Tabby opens its context menus (terminal, tab header, profiles…) through
 * PlatformService.popupContextMenu(), which on Electron shows a native menu.
 * Chromium paints native menus fully opaque, so a compositor blur behind them
 * (Blur my Shell, KWin…) can't show. This plugin replaces that method with a
 * menu drawn in HTML inside the Tabby window: a translucent background with a
 * CSS backdrop blur over the terminal, and, when the window itself is
 * translucent and blurred by the compositor, the desktop blur shows through.
 *
 * Every menu built by Tabby or by other plugins goes through the same method,
 * so all of them are covered. Same items, same actions: labels,
 * checkboxes, radio items, disabled items, submenus, keyboard navigation.
 * Separators are left out, and the menu uses the system UI font.
 * The menu is part of the window, so it can't extend past its edges: near an
 * edge it opens towards the inside.
 *
 * Plain JavaScript, no build step: Tabby provides @angular/*, tabby-core and
 * tabby-settings at runtime and compiles this module JIT.
 */
'use strict'

const { NgModule, Injectable, Component } = require('@angular/core')
const { CommonModule } = require('@angular/common')
const { FormsModule } = require('@angular/forms')
const TabbyCore = require('tabby-core')
const { ConfigProvider, ConfigService, PlatformService } = TabbyCore
const { SettingsTabProvider } = require('tabby-settings')

const LOG = '[tabby-glass-menu]'
const STYLE_ID = 'tabby-glass-menu-style'
const SUBMENU_DELAY_MS = 150
const EDGE_MARGIN = 6
// a right-button release over an item activates it (press, drag, release),
// but not the release of the click that opened the menu
const RIGHT_RELEASE_GUARD_MS = 300

const DEFAULTS = {
    enabled: true,
    // background opacity, 0 (clear) … 1 (opaque)
    opacity: 0.55,
    // CSS backdrop blur over the window content, px
    blur: 12,
    // corner radius, px
    radius: 20,
    // border: width in px (0 for none), CSS style, color and its opacity
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#ffffff',
    borderOpacity: 0.06,
}

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double']

const FALLBACK_BG = '#1d201e'
const FALLBACK_FG = '#e3e2be'

const CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">' +
    '<path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'

const CSS = `
.tgm-panel {
    position: fixed;
    z-index: 2147483000;
    box-sizing: border-box;
    min-width: 200px;
    max-width: 440px;
    max-height: calc(100vh - ${2 * EDGE_MARGIN}px);
    overflow-x: hidden;
    overflow-y: auto;
    padding: 6px;
    border-radius: var(--tgm-radius);
    background: var(--tgm-bg);
    -webkit-backdrop-filter: blur(var(--tgm-blur));
    backdrop-filter: blur(var(--tgm-blur));
    color: var(--tgm-fg);
    /* the system UI font (Chromium reads it from the GTK settings on Linux),
       so the menu follows it when it changes */
    font-family: system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.35;
    border: var(--tgm-border-width) var(--tgm-border-style) var(--tgm-border-color);
    box-shadow: 0 2px 3px -1px rgba(0, 0, 0, 0.15), 0 4px 3px 0 rgba(0, 0, 0, 0.18),
        0 1px 6px 0 rgba(0, 0, 0, 0.12);
    user-select: none;
    outline: none;
    animation: tgm-in 90ms ease-out;
}
@keyframes tgm-in {
    from { opacity: 0; transform: scale(0.97); }
    to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
    .tgm-panel { animation: none; }
}
.tgm-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 14px;
    border-radius: calc(var(--tgm-radius) * 0.6);
    white-space: nowrap;
    cursor: default;
}
.tgm-item.tgm-active { background: rgba(255, 255, 255, 0.09); }
.tgm-item.tgm-disabled { opacity: 0.4; }
.tgm-check { display: none; width: 12px; flex: none; text-align: center; }
.tgm-panel.tgm-has-checks .tgm-check { display: block; }
.tgm-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.tgm-accel { opacity: 0.55; font-size: 0.92em; }
.tgm-arrow { display: flex; opacity: 0.7; }
`

/* ------------------------------------------------------------------ Utils */

function clone (o) {
    return JSON.parse(JSON.stringify(o))
}

function clamp (v, lo, hi) {
    return Math.max(lo, Math.min(hi, v))
}

function num (v, fallback) {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
}

/** First defined CSS custom property among `names`, on the root or body. */
function themeVar (doc, names, fallback) {
    const view = doc.defaultView
    if (!view || !view.getComputedStyle) return fallback
    for (const el of [doc.documentElement, doc.body]) {
        if (!el) continue
        const style = view.getComputedStyle(el)
        for (const name of names) {
            const value = style.getPropertyValue(name).trim()
            if (value) return value
        }
    }
    return fallback
}

function itemType (item) {
    if (item.type) return item.type
    return item.submenu ? 'submenu' : 'normal'
}

function isSelectable (item) {
    const type = itemType(item)
    return type !== 'separator' && item.enabled !== false
}

/* ------------------------------------------------------------- Glass menu */

/**
 * One open menu: a stack of panels, the root one first, then each open
 * submenu. Built with plain DOM, so it doesn't depend on Angular.
 */
class GlassMenu {
    constructor (doc, settings, onClosed) {
        this.doc = doc
        this.view = doc.defaultView
        this.settings = settings
        this.onClosed = onClosed
        this.panels = []
        this.timer = null
        this.openedAt = Date.now()
        this.closed = false
        this.previousFocus = doc.activeElement
        this.listeners = []
    }

    open (items, x, y) {
        ensureStyle(this.doc)
        this.pushPanel(items, null)
        this.placeRoot(this.panels[0].el, x, y)
        this.listen(this.doc, 'mousedown', e => this.onOutsidePointer(e), true)
        this.listen(this.doc, 'wheel', e => {
            if (!this.contains(e.target)) this.close()
        }, true)
        this.listen(this.doc, 'keydown', e => this.onKey(e), true)
        this.listen(this.view, 'blur', () => this.close())
        this.listen(this.view, 'resize', () => this.close())
        this.panels[0].el.focus({ preventScroll: true })
    }

    listen (target, type, fn, capture = false) {
        target.addEventListener(type, fn, capture)
        this.listeners.push(() => target.removeEventListener(type, fn, capture))
    }

    contains (node) {
        return this.panels.some(p => p.el.contains(node))
    }

    /* ---------------------------------------------------------- panels */

    pushPanel (items, parentRow) {
        const doc = this.doc
        const level = this.panels.length
        const el = doc.createElement('div')
        el.className = 'tgm-panel'
        el.tabIndex = -1
        el.setAttribute('role', 'menu')
        this.applySettings(el)

        const panel = { el, rows: [], active: -1, parentRow }
        // the check column only when something is checked: an empty one would
        // push every label to the right
        if (items.some(i => ['checkbox', 'radio'].includes(itemType(i)) && i.checked)) {
            el.classList.add('tgm-has-checks')
        }

        for (const item of items) {
            // no separators: the items follow one another
            if (itemType(item) === 'separator') continue
            const row = this.buildRow(item, level, panel)
            panel.rows.push(row)
            el.appendChild(row.el)
        }

        // keep the focus where it is (the terminal) while clicking the menu
        el.addEventListener('mousedown', e => e.preventDefault())
        el.addEventListener('contextmenu', e => {
            e.preventDefault()
            e.stopPropagation()
        })
        doc.body.appendChild(el)
        this.panels.push(panel)
        return panel
    }

    buildRow (item, level, panel) {
        const doc = this.doc
        const type = itemType(item)
        const el = doc.createElement('div')
        el.className = 'tgm-item'
        el.setAttribute('role', type === 'checkbox' ? 'menuitemcheckbox'
            : type === 'radio' ? 'menuitemradio' : 'menuitem')
        if (item.enabled === false) {
            el.classList.add('tgm-disabled')
            el.setAttribute('aria-disabled', 'true')
        }

        const check = doc.createElement('span')
        check.className = 'tgm-check'
        if (item.checked) check.textContent = type === 'radio' ? '•' : '✓'
        if (type === 'checkbox' || type === 'radio') {
            el.setAttribute('aria-checked', item.checked ? 'true' : 'false')
        }
        el.appendChild(check)

        const label = doc.createElement('span')
        label.className = 'tgm-label'
        label.textContent = item.label ?? ''
        el.appendChild(label)

        if (item.sublabel) {
            const accel = doc.createElement('span')
            accel.className = 'tgm-accel'
            accel.textContent = item.sublabel
            el.appendChild(accel)
        }
        if (type === 'submenu') {
            const arrow = doc.createElement('span')
            arrow.className = 'tgm-arrow'
            arrow.innerHTML = CHEVRON
            el.appendChild(arrow)
            el.setAttribute('aria-haspopup', 'menu')
        }

        const row = { el, item, level }
        el.addEventListener('mouseenter', () => {
            this.setActive(level, panel.rows.indexOf(row))
            this.scheduleSubmenu(level, row)
        })
        el.addEventListener('mouseup', e => {
            const late = Date.now() - this.openedAt > RIGHT_RELEASE_GUARD_MS
            if (e.button === 0 || (e.button === 2 && late)) {
                e.preventDefault()
                e.stopPropagation()
                this.activate(level, row, false)
            }
        })
        return row
    }

    applySettings (el) {
        const s = this.settings
        const doc = this.doc
        const bg = themeVar(doc, ['--theme-bg-more', '--theme-bg', '--bs-body-bg'], FALLBACK_BG)
        const fg = themeVar(doc, ['--theme-fg', '--bs-body-color'], FALLBACK_FG)
        const pct = Math.round(clamp(num(s.opacity, DEFAULTS.opacity), 0, 1) * 100)
        el.style.setProperty('--tgm-bg', `color-mix(in srgb, ${bg} ${pct}%, transparent)`)
        el.style.setProperty('--tgm-fg', fg)
        el.style.setProperty('--tgm-blur', `${clamp(num(s.blur, DEFAULTS.blur), 0, 100)}px`)
        el.style.setProperty('--tgm-radius', `${clamp(num(s.radius, DEFAULTS.radius), 0, 40)}px`)
        const borderColor = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s.borderColor)
            ? s.borderColor : DEFAULTS.borderColor
        const borderPct = Math.round(clamp(num(s.borderOpacity, DEFAULTS.borderOpacity), 0, 1) * 100)
        el.style.setProperty('--tgm-border-width', `${clamp(num(s.borderWidth, DEFAULTS.borderWidth), 0, 8)}px`)
        el.style.setProperty('--tgm-border-style',
            BORDER_STYLES.includes(s.borderStyle) ? s.borderStyle : DEFAULTS.borderStyle)
        el.style.setProperty('--tgm-border-color',
            `color-mix(in srgb, ${borderColor} ${borderPct}%, transparent)`)
    }

    viewport () {
        const de = this.doc.documentElement
        return {
            width: this.view.innerWidth || de.clientWidth,
            height: this.view.innerHeight || de.clientHeight,
        }
    }

    placeRoot (el, x, y) {
        const { width, height } = this.viewport()
        const rect = el.getBoundingClientRect()
        let left = x + 1
        let top = y + 1
        if (left + rect.width > width - EDGE_MARGIN) left = x - rect.width - 1
        if (top + rect.height > height - EDGE_MARGIN) top = y - rect.height - 1
        el.style.left = `${clamp(left, EDGE_MARGIN, Math.max(EDGE_MARGIN, width - rect.width - EDGE_MARGIN))}px`
        el.style.top = `${clamp(top, EDGE_MARGIN, Math.max(EDGE_MARGIN, height - rect.height - EDGE_MARGIN))}px`
    }

    placeSubmenu (el, rowEl) {
        const { width, height } = this.viewport()
        const rect = el.getBoundingClientRect()
        const anchor = rowEl.getBoundingClientRect()
        const parent = rowEl.parentElement.getBoundingClientRect()
        let left = parent.right - 4
        if (left + rect.width > width - EDGE_MARGIN) left = parent.left - rect.width + 4
        const top = anchor.top - 6
        el.style.left = `${clamp(left, EDGE_MARGIN, Math.max(EDGE_MARGIN, width - rect.width - EDGE_MARGIN))}px`
        el.style.top = `${clamp(top, EDGE_MARGIN, Math.max(EDGE_MARGIN, height - rect.height - EDGE_MARGIN))}px`
    }

    /** Close every panel deeper than `level`. */
    truncate (level) {
        while (this.panels.length > level + 1) {
            const panel = this.panels.pop()
            panel.el.remove()
        }
    }

    setActive (level, index) {
        const panel = this.panels[level]
        if (!panel) return
        panel.rows.forEach((row, i) => row.el.classList.toggle('tgm-active', i === index))
        panel.active = index
        const row = panel.rows[index]
        if (row && row.el.scrollIntoView) row.el.scrollIntoView({ block: 'nearest' })
    }

    scheduleSubmenu (level, row) {
        clearTimeout(this.timer)
        const open = this.panels[level + 1]
        if (open && open.parentRow === row) return
        this.timer = setTimeout(() => {
            if (this.closed) return
            this.truncate(level)
            if (itemType(row.item) === 'submenu' && row.item.enabled !== false) {
                this.openSubmenu(level, row, false)
            }
        }, SUBMENU_DELAY_MS)
    }

    openSubmenu (level, row, selectFirst) {
        this.truncate(level)
        const panel = this.pushPanel(row.item.submenu || [], row)
        this.placeSubmenu(panel.el, row.el)
        if (selectFirst) this.move(level + 1, 1)
        return panel
    }

    /* ---------------------------------------------------------- actions */

    activate (level, row, fromKeyboard) {
        const item = row.item
        if (!isSelectable(item)) return
        if (itemType(item) === 'submenu') {
            clearTimeout(this.timer)
            const open = this.panels[level + 1]
            if (!open || open.parentRow !== row) this.openSubmenu(level, row, fromKeyboard)
            else if (fromKeyboard) this.move(level + 1, 1)
            return
        }
        this.close()
        if (typeof item.click === 'function') {
            // like a native menu: the action runs once the menu is gone and
            // the focus is back where it was
            setTimeout(() => {
                try {
                    item.click()
                } catch (e) {
                    console.error(LOG, 'menu action failed', e)
                }
            }, 0)
        }
    }

    /** Move the highlight of the panel at `level` by `step`, skipping disabled items. */
    move (level, step) {
        const panel = this.panels[level]
        if (!panel || !panel.rows.length) return
        const n = panel.rows.length
        let i = panel.active
        for (let tries = 0; tries < n; tries++) {
            i = i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n
            if (isSelectable(panel.rows[i].item)) {
                this.setActive(level, i)
                return
            }
        }
    }

    onKey (e) {
        const level = this.panels.length - 1
        const panel = this.panels[level]
        const row = panel.rows[panel.active]
        let handled = true
        switch (e.key) {
            case 'Escape':
                if (level > 0) this.truncate(level - 1)
                else this.close()
                break
            case 'ArrowDown':
                this.move(level, 1)
                break
            case 'ArrowUp':
                this.move(level, -1)
                break
            case 'Home':
                panel.active = -1
                this.move(level, 1)
                break
            case 'End':
                panel.active = -1
                this.move(level, -1)
                break
            case 'ArrowRight':
                if (row && itemType(row.item) === 'submenu') this.activate(level, row, true)
                break
            case 'ArrowLeft':
                if (level > 0) this.truncate(level - 1)
                break
            case 'Enter':
            case ' ':
                if (row) this.activate(level, row, true)
                break
            case 'Tab':
                this.close()
                break
            default:
                if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    this.jumpTo(level, e.key.toLowerCase())
                } else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
                    handled = false
                }
        }
        // a native menu keeps the keyboard while it is open
        e.preventDefault()
        e.stopPropagation()
        return handled
    }

    /** Type-to-select: next item whose label starts with `char`. */
    jumpTo (level, char) {
        const panel = this.panels[level]
        const n = panel.rows.length
        for (let k = 1; k <= n; k++) {
            const i = (panel.active + k + n) % n
            const row = panel.rows[i]
            if (isSelectable(row.item) && String(row.item.label || '').trim().toLowerCase().startsWith(char)) {
                this.setActive(level, i)
                return
            }
        }
    }

    onOutsidePointer (e) {
        if (this.contains(e.target)) return
        // like a native menu, the click that dismisses it does nothing else
        // (it would start a selection in the terminal); a right click still
        // goes on to open a new menu there
        if (e.button !== 2) {
            e.preventDefault()
            e.stopPropagation()
        }
        this.close()
    }

    close () {
        if (this.closed) return
        this.closed = true
        clearTimeout(this.timer)
        this.listeners.forEach(off => off())
        this.listeners = []
        this.truncate(-1)
        const focus = this.previousFocus
        if (focus && focus.isConnected && typeof focus.focus === 'function') {
            focus.focus({ preventScroll: true })
        }
        this.onClosed?.(this)
    }
}

function ensureStyle (doc) {
    if (doc.getElementById(STYLE_ID)) return
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    doc.head.appendChild(style)
}

/* ---------------------------------------------------------------- Service */

class GlassMenuService {
    constructor (config, platform) {
        this.config = config
        this.platform = platform
        this.current = null
        this.lastPointer = { x: 0, y: 0 }
        this.original = null
    }

    get settings () {
        return { ...DEFAULTS, ...(this.config.store?.glassMenu || {}) }
    }

    install () {
        if (this.original || !this.platform) return
        const doc = globalThis.document
        if (!doc) return
        const track = e => { this.lastPointer = { x: e.clientX, y: e.clientY } }
        doc.addEventListener('mousedown', track, true)
        doc.addEventListener('contextmenu', track, true)

        const original = this.platform.popupContextMenu.bind(this.platform)
        this.original = original
        this.platform.popupContextMenu = (menu, event) => {
            if (!this.settings.enabled) return original(menu, event)
            try {
                this.show(menu, event)
            } catch (e) {
                console.error(LOG, 'falling back to the native menu', e)
                this.current?.close()
                original(menu, event)
            }
        }
    }

    show (menu, event) {
        this.current?.close()
        const doc = globalThis.document
        const x = event && Number.isFinite(event.clientX) ? event.clientX : this.lastPointer.x
        const y = event && Number.isFinite(event.clientY) ? event.clientY : this.lastPointer.y
        // the native menu stops the event from reaching anything else
        event?.preventDefault?.()
        const glass = new GlassMenu(doc, this.settings, m => {
            if (this.current === m) this.current = null
        })
        this.current = glass
        glass.open(menu || [], x, y)
        return glass
    }

    /** Sample menu for the settings page. */
    preview (event) {
        const noop = () => {}
        this.show([
            { label: 'Copy', sublabel: 'Ctrl+Shift+C', click: noop },
            { label: 'Paste', sublabel: 'Ctrl+Shift+V', click: noop },
            { type: 'separator' },
            { label: 'Notify on activity', type: 'checkbox', checked: true, click: noop },
            { label: 'Disabled item', enabled: false },
            { type: 'separator' },
            {
                label: 'Split',
                submenu: [
                    { label: 'Right', click: noop },
                    { label: 'Down', click: noop },
                    { label: 'Left', click: noop },
                    { label: 'Up', click: noop },
                ],
            },
            { label: 'Close', click: noop },
        ], event)
    }
}
GlassMenuService.ctorParameters = () => [{ type: ConfigService }, { type: PlatformService }]
Injectable({ providedIn: 'root' })(GlassMenuService)

class GlassMenuConfigProvider extends ConfigProvider {
    constructor () {
        super()
        this.defaults = { glassMenu: clone(DEFAULTS) }
        this.platformDefaults = {}
    }
}
Injectable()(GlassMenuConfigProvider)

/* --------------------------------------------------------------- Settings */

const SETTINGS_TEMPLATE = `
<h3>Glass menu</h3>
<p class="tgm-intro">
    Context menus drawn inside the window with a translucent, blurred
    background, instead of Electron's opaque native menus. With a translucent
    Tabby window and a compositor blur (Blur my Shell…) the desktop blur
    shows through them too.
</p>

<div class="form-line">
    <div class="header">
        <div class="title">Enable</div>
        <div class="description">When off, Tabby shows its usual native menus</div>
    </div>
    <toggle [(ngModel)]="config.store.glassMenu.enabled" (ngModelChange)="save()"></toggle>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Background opacity</div>
        <div class="description">0 is fully clear, 1 is opaque</div>
    </div>
    <div class="tgm-range">
        <input type="range" class="form-range" min="0" max="1" step="0.05"
            [(ngModel)]="config.store.glassMenu.opacity" (ngModelChange)="save()">
        <span>{{ config.store.glassMenu.opacity | number:'1.2-2' }}</span>
    </div>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Blur</div>
        <div class="description">Blur of the window content behind the menu, in pixels (0 for none)</div>
    </div>
    <div class="tgm-range">
        <input type="range" class="form-range" min="0" max="40" step="1"
            [(ngModel)]="config.store.glassMenu.blur" (ngModelChange)="save()">
        <span>{{ config.store.glassMenu.blur }} px</span>
    </div>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Corner radius</div>
        <div class="description">In pixels</div>
    </div>
    <div class="tgm-range">
        <input type="range" class="form-range" min="0" max="40" step="1"
            [(ngModel)]="config.store.glassMenu.radius" (ngModelChange)="save()">
        <span>{{ config.store.glassMenu.radius }} px</span>
    </div>
</div>

<h4 class="tgm-section">Border</h4>

<div class="form-line">
    <div class="header">
        <div class="title">Width</div>
        <div class="description">In pixels, 0 for no border</div>
    </div>
    <div class="tgm-range">
        <input type="range" class="form-range" min="0" max="8" step="1"
            [(ngModel)]="config.store.glassMenu.borderWidth" (ngModelChange)="save()">
        <span>{{ config.store.glassMenu.borderWidth }} px</span>
    </div>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Style</div>
    </div>
    <select class="form-control tgm-select"
        [(ngModel)]="config.store.glassMenu.borderStyle" (ngModelChange)="save()">
        <option *ngFor="let style of borderStyles" [ngValue]="style">{{ style }}</option>
    </select>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Color</div>
    </div>
    <input type="color" class="tgm-color"
        [(ngModel)]="config.store.glassMenu.borderColor" (ngModelChange)="save()">
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Opacity</div>
        <div class="description">0 is invisible, 1 is the full color</div>
    </div>
    <div class="tgm-range">
        <input type="range" class="form-range" min="0" max="1" step="0.01"
            [(ngModel)]="config.store.glassMenu.borderOpacity" (ngModelChange)="save()">
        <span>{{ config.store.glassMenu.borderOpacity | number:'1.2-2' }}</span>
    </div>
</div>

<button class="btn btn-secondary" (click)="preview($event)">Show a sample menu</button>
`

const SETTINGS_STYLES = [`
.tgm-intro { opacity: 0.8; }
.tgm-section { margin-top: 1.5rem; }
.tgm-select { width: auto; min-width: 140px; }
.tgm-color { width: 48px; height: 32px; padding: 0; border: none; background: none; cursor: pointer; }
.tgm-range { display: flex; align-items: center; gap: 12px; min-width: 260px; }
.tgm-range input { flex: 1; }
.tgm-range span { min-width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; }
`]

class GlassMenuSettingsComponent {
    constructor (config, menu) {
        this.config = config
        this.menu = menu
        this.borderStyles = BORDER_STYLES
    }

    save () {
        const s = this.config.store.glassMenu
        s.opacity = num(s.opacity, DEFAULTS.opacity)
        s.blur = num(s.blur, DEFAULTS.blur)
        s.radius = num(s.radius, DEFAULTS.radius)
        s.borderWidth = num(s.borderWidth, DEFAULTS.borderWidth)
        s.borderOpacity = num(s.borderOpacity, DEFAULTS.borderOpacity)
        this.config.save()
    }

    preview (event) {
        this.menu.preview(event)
    }
}
GlassMenuSettingsComponent.ctorParameters = () => [
    { type: ConfigService },
    { type: GlassMenuService },
]
Component({
    selector: 'glass-menu-settings',
    template: SETTINGS_TEMPLATE,
    styles: SETTINGS_STYLES,
})(GlassMenuSettingsComponent)

class GlassMenuSettingsTabProvider extends SettingsTabProvider {
    constructor () {
        super()
        this.id = 'glass-menu'
        this.icon = 'bars'
        this.title = 'Glass menu'
    }

    getComponentType () {
        return GlassMenuSettingsComponent
    }
}
Injectable()(GlassMenuSettingsTabProvider)

/* ----------------------------------------------------------------- Module */

class GlassMenuModule {
    constructor (menu) {
        menu.install()
    }
}
GlassMenuModule.ctorParameters = () => [{ type: GlassMenuService }]
NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCore.default,
    ],
    declarations: [
        GlassMenuSettingsComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: GlassMenuConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: GlassMenuSettingsTabProvider, multi: true },
    ],
})(GlassMenuModule)

module.exports = {
    default: GlassMenuModule,
    GlassMenu,
    GlassMenuService,
    DEFAULTS,
}

/*
 * Claude-Firefox: Agent im Webseiten-Tab (Content-Script, isolierte Welt).
 * Setzt die Eingabe-Befehle der Chrome-DevTools um: Maus, Tastatur,
 * Texteingabe, Scrollen und das Mitschneiden der Browser-Konsole.
 *
 * Firefox erlaubt Erweiterungen keine echten (vertrauenswürdigen) Eingaben.
 * Wir erzeugen deshalb dieselbe Folge von DOM-Events, die ein echter Klick oder
 * Tastendruck auslösen würde, und führen die Standard-Aktion (Fokus, Cursor,
 * Scrollen, Formular absenden, Text einfügen) selbst aus. Text wird über
 * document.execCommand('insertText') eingefügt. Das erzeugt echte
 * input-Events und funktioniert auch mit React, ProseMirror & Co.
 */
(function () {
  'use strict';
  if (globalThis.__ffCdpAgent) {
    if (globalThis.__ffConsoleBoot) globalThis.__ffCdpAgent.boot();
    return;
  }
  const ext = globalThis.browser || globalThis.chrome;

  // --- Hilfsfunktionen ------------------------------------------------------

  const BUTTONS = { none: 0, left: 0, middle: 1, right: 2, back: 3, forward: 4 };
  const TEXT_TYPES = new Set([
    'text',
    'search',
    'url',
    'tel',
    'email',
    'password',
    'number',
    'date',
    'datetime-local',
    'month',
    'time',
    'week',
  ]);

  const state = {
    hover: null,
    down: null,
    downPoint: null,
    drag: null,
  };

  const shadowRootOf = (el) => (el && (el.openOrClosedShadowRoot || el.shadowRoot)) || null;

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && i < 32; i++) {
      const root = shadowRootOf(el);
      if (!root) break;
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function deepActiveElement() {
    let el = document.activeElement;
    for (let i = 0; el && i < 32; i++) {
      const root = shadowRootOf(el);
      if (!root || !root.activeElement) break;
      el = root.activeElement;
    }
    return el;
  }

  function parentOf(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentNode && node.parentNode.nodeType === 11 && node.parentNode.host) return node.parentNode.host;
    return node.parentElement || (node.parentNode && node.parentNode.host) || null;
  }

  function ancestors(node) {
    const list = [];
    for (let n = node; n; n = parentOf(n)) list.push(n);
    return list;
  }

  function commonAncestor(a, b) {
    if (!a) return b;
    if (!b) return a;
    const chain = new Set(ancestors(a));
    for (let n = b; n; n = parentOf(n)) if (chain.has(n)) return n;
    return b;
  }

  const isFrame = (el) => !!el && (el.localName === 'iframe' || el.localName === 'frame');
  const isTextField = (el) =>
    !!el &&
    ((el.localName === 'textarea' && !el.readOnly && !el.disabled) ||
      (el.localName === 'input' && TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled));
  const isEditable = (el) => !!el && !!el.isContentEditable;

  function frameIdOf(el) {
    try {
      const id = ext.runtime.getFrameId(el);
      return typeof id === 'number' && id >= 0 ? id : null;
    } catch {
      return null;
    }
  }

  function findFocusable(el) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.nodeType !== 1) continue;
      const name = n.localName;
      if (n.disabled) continue;
      if (n.isContentEditable && !(n.parentElement && n.parentElement.isContentEditable)) return n;
      if (['input', 'select', 'textarea', 'button', 'iframe', 'summary'].includes(name)) return n;
      if ((name === 'a' || name === 'area') && n.hasAttribute('href')) return n;
      if (n.hasAttribute('tabindex')) return n;
      if (n.isContentEditable) return n;
    }
    return null;
  }

  function modifierFlags(m = 0) {
    return { altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8) };
  }

  function mouseInit(p, extra = {}) {
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    const sx = typeof window.mozInnerScreenX === 'number' ? window.mozInnerScreenX : window.screenX;
    const sy = typeof window.mozInnerScreenY === 'number' ? window.mozInnerScreenY : window.screenY;
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + sx,
      screenY: y + sy,
      button: BUTTONS[p.button] ?? 0,
      buttons: p.buttons ?? 0,
      detail: p.clickCount ?? 0,
      ...modifierFlags(p.modifiers),
      ...extra,
    };
  }

  function pointerInit(p, extra = {}) {
    return {
      ...mouseInit(p, extra),
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: (extra.buttons ?? p.buttons ?? 0) ? 0.5 : 0,
    };
  }

  const fire = (target, type, init, Ctor = MouseEvent) => target.dispatchEvent(new Ctor(type, init));

  // --- Hover ----------------------------------------------------------------

  function updateHover(target, p) {
    const prev = state.hover && state.hover.isConnected ? state.hover : null;
    if (prev === target) return;
    const prevChain = prev ? ancestors(prev) : [];
    const nextChain = target ? ancestors(target) : [];
    if (prev) {
      fire(prev, 'pointerout', pointerInit(p, { relatedTarget: target }), PointerEvent);
      fire(prev, 'mouseout', mouseInit(p, { relatedTarget: target }));
      for (const el of prevChain) {
        if (nextChain.includes(el)) break;
        el.dispatchEvent(new PointerEvent('pointerleave', { ...pointerInit(p, { relatedTarget: target }), bubbles: false, cancelable: false }));
        el.dispatchEvent(new MouseEvent('mouseleave', { ...mouseInit(p, { relatedTarget: target }), bubbles: false, cancelable: false }));
      }
    }
    if (target) {
      fire(target, 'pointerover', pointerInit(p, { relatedTarget: prev }), PointerEvent);
      fire(target, 'mouseover', mouseInit(p, { relatedTarget: prev }));
      const entering = nextChain.filter((el) => !prevChain.includes(el)).reverse();
      for (const el of entering) {
        el.dispatchEvent(new PointerEvent('pointerenter', { ...pointerInit(p, { relatedTarget: prev }), bubbles: false, cancelable: false }));
        el.dispatchEvent(new MouseEvent('mouseenter', { ...mouseInit(p, { relatedTarget: prev }), bubbles: false, cancelable: false }));
      }
    }
    state.hover = target;
  }

  // --- Fokus und Textauswahl beim Klicken -----------------------------------

  function caretOffsetIn(field, x, y) {
    try {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode === field) return pos.offset;
    } catch {}
    return field.value.length;
  }

  function wordBounds(text, pos) {
    const isWord = (c) => /[\p{L}\p{N}_]/u.test(c);
    let start = pos;
    let end = pos;
    while (start > 0 && isWord(text[start - 1])) start--;
    while (end < text.length && isWord(text[end])) end++;
    return [start, end];
  }

  function placeCaret(focusable, p) {
    const clicks = p.clickCount || 1;
    if (isTextField(focusable)) {
      try {
        const pos = caretOffsetIn(focusable, p.x, p.y);
        if (clicks >= 3) focusable.select();
        else if (clicks === 2) focusable.setSelectionRange(...wordBounds(focusable.value, pos));
        else focusable.setSelectionRange(pos, pos);
      } catch {
        // email/number-Felder kennen keine Auswahl.
      }
      return;
    }
    const pos = document.caretPositionFromPoint(p.x, p.y);
    if (!pos || !pos.offsetNode) return;
    const sel = window.getSelection();
    try {
      if (clicks >= 3) {
        sel.collapse(pos.offsetNode, pos.offset);
        sel.modify('move', 'backward', 'paragraphboundary');
        sel.modify('extend', 'forward', 'paragraphboundary');
      } else if (clicks === 2) {
        sel.collapse(pos.offsetNode, pos.offset);
        sel.modify('move', 'backward', 'word');
        sel.modify('extend', 'forward', 'word');
      } else {
        sel.collapse(pos.offsetNode, pos.offset);
      }
    } catch {}
  }

  function focusForClick(target, p) {
    const focusable = findFocusable(target);
    if (focusable) {
      if (deepActiveElement() !== focusable) focusable.focus({ preventScroll: true });
    } else {
      const active = deepActiveElement();
      if (active && active !== document.body && active !== document.documentElement && active.blur) active.blur();
    }
    placeCaret(focusable && (isTextField(focusable) || isEditable(focusable)) ? focusable : target, p);
  }

  // --- Pop-ups (Firefox blockiert Fenster aus synthetischen Klicks) ---------

  function withPopupCapture(fn) {
    const openTabs = [];
    const onClick = (e) => {
      if (e.defaultPrevented || e.isTrusted) return;
      const path = e.composedPath ? e.composedPath() : [];
      const link = path.find((n) => n && (n.localName === 'a' || n.localName === 'area') && n.href);
      if (!link || !/^(https?|ftp|file):/i.test(link.href)) return;
      const target = (link.getAttribute('target') || '').toLowerCase();
      const newTab = (target && !['_self', '_top', '_parent'].includes(target)) || e.ctrlKey || e.metaKey || e.button === 1;
      if (!newTab) return;
      e.preventDefault();
      openTabs.push({ url: link.href, active: !(e.ctrlKey || e.metaKey || e.button === 1) });
    };
    window.addEventListener('click', onClick, false);
    window.addEventListener('auxclick', onClick, false);

    // window.open() aus Klick-Handlern der Seite: wenn Firefox blockiert, selbst öffnen.
    let restore = null;
    try {
      const pageWin = window.wrappedJSObject;
      const original = pageWin.open;
      if (typeof original === 'function') {
        exportFunction(
          function (url, ...rest) {
            const win = Reflect.apply(original, pageWin, [url, ...rest]);
            if (!win && url) {
              try {
                openTabs.push({ url: new URL(String(url), document.baseURI).href, active: true });
              } catch {}
            }
            return win;
          },
          pageWin,
          { defineAs: 'open' },
        );
        restore = () => {
          pageWin.open = original;
        };
      }
    } catch {}

    try {
      fn();
    } finally {
      window.removeEventListener('click', onClick, false);
      window.removeEventListener('auxclick', onClick, false);
      if (restore) restore();
    }
    return openTabs.length ? { openTabs } : {};
  }

  // --- Scrollen -------------------------------------------------------------

  function canScroll(el, dx, dy) {
    const cs = getComputedStyle(el);
    const overflowY = /(auto|scroll|overlay)/.test(cs.overflowY);
    const overflowX = /(auto|scroll|overlay)/.test(cs.overflowX);
    const y =
      overflowY &&
      el.scrollHeight > el.clientHeight + 1 &&
      ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (dy < 0 && el.scrollTop > 0));
    const x =
      overflowX &&
      el.scrollWidth > el.clientWidth + 1 &&
      ((dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) || (dx < 0 && el.scrollLeft > 0));
    return x || y;
  }

  /** Scrollt das nächste scrollbare Element. Liefert false, wenn sich nichts bewegt hat. */
  function scrollFrom(el, dx, dy) {
    const root = document.scrollingElement || document.documentElement;
    for (let n = el; n && n !== root && n !== document.body; n = parentOf(n)) {
      if (n.nodeType === 1 && canScroll(n, dx, dy)) {
        n.scrollBy({ left: dx, top: dy, behavior: 'instant' });
        return true;
      }
    }
    const x = window.scrollX;
    const y = window.scrollY;
    root.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return window.scrollX !== x || window.scrollY !== y;
  }

  // --- Drag & Drop ------------------------------------------------------------

  function draggableSource(el) {
    for (let n = el; n; n = parentOf(n)) {
      if (n.nodeType !== 1) continue;
      if (n.getAttribute('draggable') === 'true') return n;
      if (n.getAttribute('draggable') === 'false') return null;
      if ((n.localName === 'img' && n.src) || (n.localName === 'a' && n.href)) return n;
    }
    return null;
  }

  function dragInit(p, dataTransfer, extra = {}) {
    return { ...mouseInit(p), dataTransfer, ...extra };
  }

  // --- Maus -------------------------------------------------------------------

  function forwardToFrame(frame, p) {
    const frameId = frameIdOf(frame);
    if (frameId == null) return null;
    const rect = frame.getBoundingClientRect();
    const cs = getComputedStyle(frame);
    const x = p.x - rect.left - parseFloat(cs.borderLeftWidth || 0) - parseFloat(cs.paddingLeft || 0);
    const y = p.y - rect.top - parseFloat(cs.borderTopWidth || 0) - parseFloat(cs.paddingTop || 0);
    return { forward: { frameId, params: { ...p, x, y } } };
  }

  function mouse(p) {
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    const target = deepElementFromPoint(x, y) || document.documentElement;

    if (isFrame(target)) {
      const fwd = forwardToFrame(target, p);
      if (fwd) {
        updateHover(target, p);
        if (p.type === 'mousePressed' && document.activeElement !== target) target.focus({ preventScroll: true });
        return fwd;
      }
    }

    switch (p.type) {
      case 'mouseMoved': {
        updateHover(target, p);
        fire(target, 'pointermove', pointerInit(p), PointerEvent);
        fire(target, 'mousemove', mouseInit(p));
        if (state.down && (p.buttons & 1)) dragMove(target, p);
        return {};
      }
      case 'mousePressed': {
        updateHover(target, p);
        const pointerOk = fire(target, 'pointerdown', pointerInit(p, { buttons: p.buttons || 1 }), PointerEvent);
        const mouseOk = pointerOk ? fire(target, 'mousedown', mouseInit(p)) : false;
        state.down = { target, button: p.button, suppressMouse: !pointerOk };
        state.downPoint = { x, y };
        if (pointerOk && mouseOk && (p.button === 'left' || !p.button)) focusForClick(target, p);
        return {};
      }
      case 'mouseReleased': {
        updateHover(target, p);
        const down = state.down;
        state.down = null;
        fire(target, 'pointerup', pointerInit(p, { buttons: 0 }), PointerEvent);
        if (!down || !down.suppressMouse) fire(target, 'mouseup', mouseInit(p, { buttons: 0 }));
        if (state.drag) {
          dragEnd(target, p);
          return {};
        }
        const clickTarget = commonAncestor(down ? down.target : target, target);
        const button = p.button || 'left';
        return withPopupCapture(() => {
          if (button === 'left') {
            fire(clickTarget, 'click', mouseInit(p, { buttons: 0, detail: p.clickCount || 1 }), PointerEvent);
            if ((p.clickCount || 1) === 2) fire(clickTarget, 'dblclick', mouseInit(p, { buttons: 0, detail: 2 }));
          } else {
            fire(clickTarget, 'auxclick', mouseInit(p, { buttons: 0, detail: p.clickCount || 1 }), PointerEvent);
            if (button === 'right') fire(target, 'contextmenu', mouseInit(p, { buttons: 0 }), PointerEvent);
          }
        });
      }
      case 'mouseWheel': {
        const dx = Number(p.deltaX) || 0;
        const dy = Number(p.deltaY) || 0;
        const ok = fire(target, 'wheel', { ...mouseInit(p), deltaX: dx, deltaY: dy, deltaZ: 0, deltaMode: 0 }, WheelEvent);
        // Kann ein iframe nicht weiter scrollen, scrollt (wie in Chrome) die umgebende Seite.
        if (ok && !scrollFrom(target, dx, dy) && window !== window.top) return { unscrolled: true };
        return {};
      }
      default:
        return { error: `Unsupported mouse event type ${p.type}` };
    }
  }

  function dragMove(target, p) {
    if (!state.drag) {
      const start = state.downPoint || p;
      if (Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      const source = draggableSource(state.down.target);
      if (!source) return;
      const dataTransfer = new DataTransfer();
      if (!fire(source, 'dragstart', dragInit(p, dataTransfer), DragEvent)) {
        state.down = null;
        return;
      }
      state.drag = { source, dataTransfer, over: null, accepted: false };
    }
    const drag = state.drag;
    if (drag.over !== target) {
      if (drag.over) fire(drag.over, 'dragleave', dragInit(p, drag.dataTransfer, { relatedTarget: target }), DragEvent);
      fire(target, 'dragenter', dragInit(p, drag.dataTransfer), DragEvent);
      drag.over = target;
    }
    fire(drag.source, 'drag', dragInit(p, drag.dataTransfer), DragEvent);
    // Wird dragover abgebrochen (preventDefault), ist ein Drop hier erlaubt.
    drag.accepted = !fire(target, 'dragover', dragInit(p, drag.dataTransfer), DragEvent);
  }

  function dragEnd(target, p) {
    const drag = state.drag;
    state.drag = null;
    if (drag.over !== target) {
      fire(target, 'dragenter', dragInit(p, drag.dataTransfer), DragEvent);
      drag.accepted = !fire(target, 'dragover', dragInit(p, drag.dataTransfer), DragEvent);
    }
    if (drag.accepted) fire(target, 'drop', dragInit(p, drag.dataTransfer), DragEvent);
    else fire(target, 'dragleave', dragInit(p, drag.dataTransfer), DragEvent);
    fire(drag.source, 'dragend', dragInit(p, drag.dataTransfer), DragEvent);
  }

  // --- Text einfügen --------------------------------------------------------

  function insertText(text) {
    const el = deepActiveElement();
    if (!el || !text) return false;
    if (isTextField(el) || isEditable(el)) {
      try {
        if (document.execCommand('insertText', false, text)) return true;
      } catch {}
      if (isTextField(el)) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        const before = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true });
        if (!el.dispatchEvent(before)) return false;
        try {
          el.setRangeText(text, start, end, 'end');
        } catch {
          el.value += text;
        }
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true, composed: true }));
        return true;
      }
    }
    return false;
  }

  // --- Tastatur ---------------------------------------------------------------

  function keyInit(p) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      key: p.key ?? '',
      code: p.code ?? '',
      location: p.location ?? 0,
      repeat: !!p.autoRepeat,
      ...modifierFlags(p.modifiers),
    };
  }

  function fireKey(target, type, p, keyCode, charCode = 0) {
    const init = keyInit(p);
    init.keyCode = type === 'keypress' ? charCode : keyCode;
    init.charCode = type === 'keypress' ? charCode : 0;
    init.which = type === 'keypress' ? charCode : keyCode;
    return target.dispatchEvent(new KeyboardEvent(type, init));
  }

  function isSubmitButton(el) {
    if (el.localName === 'button') return (el.getAttribute('type') || 'submit').toLowerCase() === 'submit';
    return el.localName === 'input' && (el.type === 'submit' || el.type === 'image');
  }

  function clickElement(el) {
    const r = el.getBoundingClientRect();
    const p = { x: r.left + r.width / 2, y: r.top + r.height / 2, button: 'left', clickCount: 1 };
    return withPopupCapture(() => {
      fire(el, 'click', mouseInit(p, { detail: 1 }), PointerEvent);
    });
  }

  function implicitSubmit(input) {
    const form = input.form;
    if (!form) return {};
    for (const el of form.elements) {
      if (isSubmitButton(el)) return el.disabled ? {} : clickElement(el);
    }
    const blocking = [...form.elements].filter((el) => el.localName === 'input' && TEXT_TYPES.has(el.type));
    if (blocking.length <= 1) {
      try {
        form.requestSubmit();
      } catch {
        form.submit();
      }
    }
    return {};
  }

  function lineBounds(text, pos) {
    const start = text.lastIndexOf('\n', pos - 1) + 1;
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    return [start, end];
  }

  function moveCaretInField(el, key, shift, word) {
    let start;
    let end;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      return;
    }
    if (start == null) return;
    const text = el.value;
    const dirBack = el.selectionDirection === 'backward';
    let focus = dirBack ? start : end;
    const anchor = dirBack ? end : start;
    const collapsedTo = (pos) => (shift ? pos : pos);
    switch (key) {
      case 'ArrowLeft':
        if (!shift && start !== end) focus = start;
        else if (word) {
          focus = Math.max(0, focus - 1);
          while (focus > 0 && /\s/.test(text[focus])) focus--;
          focus = wordBounds(text, focus)[0];
        } else focus = Math.max(0, focus - 1);
        break;
      case 'ArrowRight':
        if (!shift && start !== end) focus = end;
        else if (word) {
          while (focus < text.length && /\s/.test(text[focus])) focus++;
          focus = wordBounds(text, focus)[1];
        } else focus = Math.min(text.length, focus + 1);
        break;
      case 'Home':
        focus = word ? 0 : lineBounds(text, focus)[0];
        break;
      case 'End':
        focus = word ? text.length : lineBounds(text, focus)[1];
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        if (el.localName !== 'textarea') {
          focus = key === 'ArrowUp' ? 0 : text.length;
          break;
        }
        const [ls] = lineBounds(text, focus);
        const col = focus - ls;
        if (key === 'ArrowUp') {
          if (ls === 0) focus = 0;
          else {
            const [ps, pe] = lineBounds(text, ls - 1);
            focus = Math.min(ps + col, pe);
          }
        } else {
          const [, le] = lineBounds(text, focus);
          if (le >= text.length) focus = text.length;
          else {
            const [ns, ne] = lineBounds(text, le + 1);
            focus = Math.min(ns + col, ne);
          }
        }
        break;
      }
      default:
        return;
    }
    focus = collapsedTo(focus);
    if (shift) {
      if (focus < anchor) el.setSelectionRange(focus, anchor, 'backward');
      else el.setSelectionRange(anchor, focus, 'forward');
    } else {
      el.setSelectionRange(focus, focus);
    }
  }

  function moveCaretInEditable(key, shift, word) {
    const sel = window.getSelection();
    const alter = shift ? 'extend' : 'move';
    const map = {
      ArrowLeft: ['backward', word ? 'word' : 'character'],
      ArrowRight: ['forward', word ? 'word' : 'character'],
      ArrowUp: ['backward', 'line'],
      ArrowDown: ['forward', 'line'],
      Home: ['backward', word ? 'documentboundary' : 'lineboundary'],
      End: ['forward', word ? 'documentboundary' : 'lineboundary'],
    };
    const m = map[key];
    if (m) {
      try {
        sel.modify(alter, m[0], m[1]);
      } catch {}
    }
  }

  function selectAll(el) {
    if (isTextField(el)) el.select();
    else if (isEditable(el)) document.execCommand('selectAll');
    else window.getSelection().selectAllChildren(document.body || document.documentElement);
  }

  function deleteWord(el, forward) {
    if (isTextField(el)) {
      try {
        const pos = el.selectionStart;
        if (pos === el.selectionEnd) {
          const text = el.value;
          let [s, e] = wordBounds(text, forward ? pos : Math.max(0, pos - 1));
          if (forward) s = pos;
          else e = pos;
          el.setSelectionRange(s, e);
        }
      } catch {}
    } else {
      try {
        const sel = window.getSelection();
        if (sel.isCollapsed) sel.modify('extend', forward ? 'forward' : 'backward', 'word');
      } catch {}
    }
    document.execCommand('delete');
  }

  const EDIT_COMMANDS = {
    selectAll: (el) => selectAll(el),
    deleteBackward: () => document.execCommand('delete'),
    deleteForward: () => document.execCommand('forwardDelete'),
    deleteWordBackward: (el) => deleteWord(el, false),
    deleteWordForward: (el) => deleteWord(el, true),
    undo: () => document.execCommand('undo'),
    redo: () => document.execCommand('redo'),
    copy: () => document.execCommand('copy'),
    cut: () => document.execCommand('cut'),
    paste: () => document.execCommand('paste'),
    insertNewline: () => document.execCommand('insertParagraph'),
    insertLineBreak: () => document.execCommand('insertLineBreak'),
  };
  const CARET_COMMANDS = {
    moveLeft: ['ArrowLeft', false, false],
    moveRight: ['ArrowRight', false, false],
    moveUp: ['ArrowUp', false, false],
    moveDown: ['ArrowDown', false, false],
    moveWordLeft: ['ArrowLeft', false, true],
    moveWordRight: ['ArrowRight', false, true],
    moveToBeginningOfLine: ['Home', false, false],
    moveToEndOfLine: ['End', false, false],
    moveToBeginningOfDocument: ['Home', false, true],
    moveToEndOfDocument: ['End', false, true],
    moveLeftAndModifySelection: ['ArrowLeft', true, false],
    moveRightAndModifySelection: ['ArrowRight', true, false],
    moveWordLeftAndModifySelection: ['ArrowLeft', true, true],
    moveWordRightAndModifySelection: ['ArrowRight', true, true],
    moveToBeginningOfLineAndModifySelection: ['Home', true, false],
    moveToEndOfLineAndModifySelection: ['End', true, false],
  };

  function runEditCommand(name, el) {
    const cmd = String(name).replace(/:$/, '');
    if (EDIT_COMMANDS[cmd]) {
      try {
        EDIT_COMMANDS[cmd](el);
      } catch {}
      return true;
    }
    const caret = CARET_COMMANDS[cmd];
    if (caret) {
      if (isTextField(el)) moveCaretInField(el, ...caret);
      else moveCaretInEditable(...caret);
      return true;
    }
    return false;
  }

  function keyScroll(target, key, shift) {
    const vh = window.innerHeight;
    const se = document.scrollingElement || document.documentElement;
    const deltas = {
      ArrowDown: [0, 40],
      ArrowUp: [0, -40],
      ArrowRight: [40, 0],
      ArrowLeft: [-40, 0],
      PageDown: [0, vh * 0.875],
      PageUp: [0, -vh * 0.875],
      ' ': [0, (shift ? -1 : 1) * vh * 0.875],
      Home: [0, -se.scrollHeight],
      End: [0, se.scrollHeight],
    };
    const d = deltas[key];
    if (d) scrollFrom(target === document.body ? null : target, d[0], d[1]);
  }

  function changeSelect(select, key) {
    const step = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
    let i = select.selectedIndex + step;
    while (i >= 0 && i < select.options.length && select.options[i].disabled) i += step;
    if (i < 0 || i >= select.options.length) return;
    select.selectedIndex = i;
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function defaultKeyAction(target, p) {
    const key = p.key;
    const mods = p.modifiers || 0;
    const ctrlOrMeta = !!(mods & 2) || !!(mods & 4);
    const shift = !!(mods & 8);
    const alt = !!(mods & 1);
    const field = isTextField(target);
    const editable = field || isEditable(target);
    const wordMod = ctrlOrMeta || alt;

    switch (key) {
      case 'Enter':
        if (target.localName === 'input') return implicitSubmit(target);
        if (target.localName === 'textarea') insertText('\n');
        else if (isEditable(target)) document.execCommand(shift ? 'insertLineBreak' : 'insertParagraph');
        else if (target.localName === 'a' || target.localName === 'button' || target.getAttribute('role') === 'button' || target.getAttribute('role') === 'link') {
          return clickElement(target);
        }
        return {};
      case 'Backspace':
        if (editable) wordMod ? deleteWord(target, false) : document.execCommand('delete');
        return {};
      case 'Delete':
        if (editable) wordMod ? deleteWord(target, true) : document.execCommand('forwardDelete');
        return {};
      case 'Tab':
        moveFocus(shift ? -1 : 1);
        return {};
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
      case 'Home':
      case 'End':
        if (field) moveCaretInField(target, key, shift, wordMod);
        else if (isEditable(target)) moveCaretInEditable(key, shift, wordMod);
        else if (target.localName === 'select' && !key.startsWith('Home') && !key.startsWith('End')) changeSelect(target, key);
        else keyScroll(target, key, shift);
        return {};
      case 'PageUp':
      case 'PageDown':
        if (!editable) keyScroll(target, key, shift);
        return {};
      case ' ':
        if (!editable && !isActivatable(target)) keyScroll(target, key, shift);
        return {};
      default:
        break;
    }
    if (ctrlOrMeta && typeof key === 'string' && key.length === 1) {
      const k = key.toLowerCase();
      if (k === 'a') selectAll(target);
      else if (k === 'z') document.execCommand(shift ? 'redo' : 'undo');
      else if (k === 'y') document.execCommand('redo');
      else if (k === 'x') document.execCommand('cut');
      else if (k === 'c') document.execCommand('copy');
    }
    return {};
  }

  function isActivatable(el) {
    if (!el || el.nodeType !== 1) return false;
    const name = el.localName;
    if (name === 'button' || name === 'summary') return true;
    if (name === 'input' && ['button', 'submit', 'reset', 'checkbox', 'radio', 'image'].includes(el.type)) return true;
    const role = el.getAttribute('role');
    return role === 'button' || role === 'checkbox' || role === 'switch' || role === 'menuitem' || role === 'tab';
  }

  function focusableElements() {
    const selector =
      'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
    const all = [...document.querySelectorAll(selector)].filter((el) => {
      if (el.disabled || el.getAttribute('tabindex') === '-1') return false;
      if (el.localName === 'input' && el.type === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
    const positive = all.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...all.filter((el) => el.tabIndex === 0)];
  }

  function moveFocus(dir) {
    const list = focusableElements();
    if (!list.length) return;
    const current = document.activeElement;
    let i = list.indexOf(current);
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    const next = list[i];
    next.focus();
    if (isTextField(next)) {
      try {
        next.select();
      } catch {}
    }
  }

  function key(p) {
    const target = deepActiveElement() || document.body || document.documentElement;
    if (isFrame(target)) {
      const frameId = frameIdOf(target);
      if (frameId != null) return { forward: { frameId, params: p } };
    }
    const vk = p.windowsVirtualKeyCode ?? p.nativeVirtualKeyCode ?? 0;
    if (p.type === 'keyDown' || p.type === 'rawKeyDown') {
      const ok = fireKey(target, 'keydown', p, vk);
      state.lastKeyDownPrevented = !ok;
      if (!ok) return {};
      const text = p.text ?? '';
      const mods = p.modifiers || 0;
      const commandModifier = !!(mods & 2) || !!(mods & 4);
      let result = {};
      if (p.type === 'keyDown' && text && !commandModifier && text !== '\r' && text !== '\n') {
        const code = text.codePointAt(0);
        // Kein Textfeld fokussiert (z. B. Leertaste auf der Seite): Standardaktion statt Text.
        if (fireKey(target, 'keypress', p, 0, code) && !insertText(text)) result = defaultKeyAction(target, p) || {};
      } else if (!(p.commands && p.commands.length)) {
        result = defaultKeyAction(target, p) || {};
      }
      for (const c of p.commands || []) runEditCommand(c, target);
      return result;
    }
    if (p.type === 'keyUp') {
      const ok = fireKey(target, 'keyup', p, vk);
      if (ok && p.key === ' ' && !state.lastKeyDownPrevented && isActivatable(target)) return clickElement(target);
      return {};
    }
    if (p.type === 'char') {
      const text = p.text ?? '';
      if (text && fireKey(target, 'keypress', p, 0, text.codePointAt(0))) insertText(text);
      return {};
    }
    return { error: `Unsupported key event type ${p.type}` };
  }

  function insertTextOp(p) {
    const target = deepActiveElement();
    if (isFrame(target)) {
      const frameId = frameIdOf(target);
      if (frameId != null) return { forward: { frameId, params: p } };
    }
    insertText(String(p.text ?? ''));
    return {};
  }

  function metrics() {
    const se = document.scrollingElement || document.documentElement;
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollWidth: se ? se.scrollWidth : window.innerWidth,
      scrollHeight: se ? se.scrollHeight : window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    };
  }

  // --- Console-Mitschnitt -----------------------------------------------------

  const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'assert'];
  const con = { installed: false, enabled: false, buffering: false, buffer: [], queue: [], timer: null, originals: {} };

  function waive(obj) {
    try {
      return (obj && obj.wrappedJSObject) || obj;
    } catch {
      return obj;
    }
  }

  function describeNode(n) {
    if (n.nodeType !== 1) return n.nodeName;
    let d = n.nodeName.toLowerCase();
    if (n.id) d += `#${n.id}`;
    if (typeof n.className === 'string' && n.className.trim()) d += `.${n.className.trim().split(/\s+/).join('.')}`;
    return d;
  }

  function describe(value) {
    try {
      const raw = waive(value);
      const tag = Object.prototype.toString.call(raw);
      if (tag === '[object Error]' || (raw && typeof raw.message === 'string' && typeof raw.stack === 'string')) {
        return raw.stack ? `${raw.name}: ${raw.message}\n${raw.stack}` : `${raw.name}: ${raw.message}`;
      }
      if (raw && typeof raw.nodeType === 'number') return describeNode(raw);
      const seen = new WeakSet();
      const json = JSON.stringify(raw, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        if (typeof v === 'function') return '[Function]';
        if (typeof v === 'bigint') return `${v}n`;
        return v;
      });
      if (json === undefined) return String(raw);
      return json.length > 5000 ? `${json.slice(0, 5000)}…` : json;
    } catch {
      try {
        return String(value);
      } catch {
        return '[object]';
      }
    }
  }

  function remoteArg(a) {
    const t = typeof a;
    if (a === undefined) return { type: 'undefined', description: 'undefined' };
    if (a === null) return { type: 'object', subtype: 'null', value: null };
    if (t === 'string' || t === 'number' || t === 'boolean') return { type: t, value: a };
    if (t === 'bigint') return { type: t, description: `${a}n` };
    if (t === 'symbol') return { type: t, description: String(a) };
    if (t === 'function') return { type: t, description: `function ${a.name || ''}` };
    return { type: 'object', description: describe(a) };
  }

  function callerFrame(stack) {
    for (const line of String(stack || '').split('\n')) {
      if (!line || line.includes('moz-extension://')) continue;
      const m = line.match(/^(.*?)@(.*):(\d+):(\d+)$/);
      if (m) return { functionName: m[1] || '', url: m[2], lineNumber: Number(m[3]) - 1, columnNumber: Number(m[4]) - 1 };
    }
    return null;
  }

  function pushEntry(entry) {
    if (con.enabled) {
      con.queue.push(entry);
      if (!con.timer) con.timer = setTimeout(flushConsole, 100);
    } else if (con.buffering && con.buffer.length < 1000) {
      con.buffer.push(entry);
    }
  }

  function flushConsole() {
    con.timer = null;
    const entries = con.queue.splice(0, con.queue.length);
    if (entries.length) ext.runtime.sendMessage({ __ffCdp: 'console', entries }).catch(() => {});
  }

  function recordConsole(level, args) {
    let list = Array.prototype.slice.call(args, 0, 50);
    if (level === 'assert') {
      if (list[0]) return;
      list = ['Assertion failed:', ...list.slice(1)];
    }
    const frame = callerFrame(new Error().stack);
    pushEntry({
      kind: 'console',
      level,
      args: list.map(remoteArg),
      timestamp: Date.now(),
      stackTrace: frame ? { callFrames: [frame] } : undefined,
    });
  }

  function onPageError(e) {
    if (!(e instanceof ErrorEvent) || !(con.enabled || con.buffering)) return;
    let description = e.message || 'Script error.';
    try {
      const err = waive(e.error);
      if (err && err.stack) description = `${e.message}\n${err.stack}`;
    } catch {}
    pushEntry({
      kind: 'exception',
      text: 'Uncaught',
      description,
      url: e.filename,
      lineNumber: Math.max(0, (e.lineno || 1) - 1),
      columnNumber: Math.max(0, (e.colno || 1) - 1),
      timestamp: Date.now(),
    });
  }

  function onRejection(e) {
    if (!(con.enabled || con.buffering)) return;
    pushEntry({
      kind: 'exception',
      text: 'Uncaught (in promise)',
      description: `Uncaught (in promise) ${describe(e.reason)}`,
      url: location.href,
      lineNumber: 0,
      columnNumber: 0,
      timestamp: Date.now(),
    });
  }

  function installConsoleHooks() {
    if (con.installed) return;
    con.installed = true;
    let pageConsole;
    try {
      pageConsole = window.wrappedJSObject.console;
    } catch {
      return;
    }
    for (const level of LEVELS) {
      const original = pageConsole[level];
      if (typeof original !== 'function') continue;
      con.originals[level] = original;
      const hook = function (...args) {
        if (con.enabled || con.buffering) {
          try {
            recordConsole(level, args);
          } catch {}
        }
        // Reflect.apply aus der Content-Script-Welt: die Seite darf unser Array nicht lesen.
        return Reflect.apply(original, this, args);
      };
      try {
        exportFunction(hook, pageConsole, { defineAs: level });
      } catch {}
    }
    window.addEventListener('error', onPageError, true);
    window.addEventListener('unhandledrejection', onRejection, true);
  }

  function setConsole(enabled) {
    if (enabled) installConsoleHooks();
    con.enabled = enabled;
    if (enabled && con.buffer.length) {
      con.queue.push(...con.buffer.splice(0, con.buffer.length));
      if (!con.timer) con.timer = setTimeout(flushConsole, 0);
    }
    if (!enabled) con.buffer.length = 0;
    con.buffering = false;
  }

  function boot() {
    if (con.enabled || con.buffering) return;
    installConsoleHooks();
    con.buffering = true;
    ext.runtime
      .sendMessage({ __ffCdp: 'consoleQuery' })
      .then((r) => setConsole(!!(r && r.enabled)))
      .catch(() => setConsole(false));
  }

  // --- Einstiegspunkt ---------------------------------------------------------

  globalThis.__ffCdpAgent = {
    handle(op, params = {}) {
      try {
        switch (op) {
          case 'mouse':
            return mouse(params);
          case 'key':
            return key(params);
          case 'insertText':
            return insertTextOp(params);
          case 'console':
            setConsole(!!params.enabled);
            return {};
          case 'metrics':
            return { value: metrics() };
          case 'scrollChain': {
            // Scroll-Weitergabe aus einem iframe: ab dem iframe-Element nach oben scrollen.
            const el = deepElementFromPoint(Number(params.x) || 0, Number(params.y) || 0);
            const moved = scrollFrom(el ? parentOf(el) : null, Number(params.deltaX) || 0, Number(params.deltaY) || 0);
            return !moved && window !== window.top ? { unscrolled: true } : {};
          }
          default:
            return { error: `Unknown agent operation ${op}` };
        }
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    },
    boot,
  };

  if (globalThis.__ffConsoleBoot) boot();
})();

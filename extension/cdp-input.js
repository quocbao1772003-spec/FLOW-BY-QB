/**
 * CDP input (0.1.16) — bấm chuột/gõ phím THẬT qua chrome.debugger (protocol 1.3).
 *
 * Vì sao (cmd-26/27, 26/11): driver cũ dùng el.click()/sự kiện giả lập (isTrusted:false);
 * Polymer/tp-yt của Flow bỏ qua một phần các sự kiện đó — bấm item menu ngôn ngữ không có
 * tác dụng, dropdown chế độ hiển thị không mở, ô giờ không nhận chữ gõ. Input.dispatchMouseEvent
 * / dispatchKeyEvent / insertText của CDP sinh sự kiện isTrusted:true như người dùng thật.
 *
 * - Chạy trong background SW (importScripts). CHỈ gắn vào tab làm việc của extension
 *   (workTabId) — background.js kiểm trước khi gọi attach, không bao giờ tab của Owner.
 * - Chrome hiện thanh vàng "…đang gỡ lỗi trình duyệt này" trong lúc attach (Owner đồng ý 26/11).
 * - DevTools/extension khác đang attach → attach lỗi, kind='DEBUGGER_BUSY', thông điệp rõ.
 * - Toạ độ click là CSS px của viewport (đúng đơn vị Input.dispatchMouseEvent).
 * - FILE vẫn đi đường DataTransfer cũ (set_files/set_files_opfs): file nằm trong OPFS,
 *   không có đường dẫn trên đĩa nên DOM.setFileInputFiles không dùng được.
 */
const FB_CDP = (() => {
  const PROTOCOL = '1.3';
  const attached = new Set();

  if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
    // Người dùng bấm "Huỷ" trên thanh vàng / tab đóng → Chrome tự detach, dọn cờ.
    chrome.debugger.onDetach.addListener((source) => {
      if (source && source.tabId != null) attached.delete(source.tabId);
    });
  }

  function cmd(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error('CDP ' + method + ': ' + err.message));
        else resolve(result);
      });
    });
  }

  /** Gắn debugger vào tab (idempotent). Tab đang bị DevTools/extension khác gỡ lỗi → DEBUGGER_BUSY. */
  function attach(tabId) {
    if (attached.has(tabId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, PROTOCOL, () => {
        const err = chrome.runtime.lastError;
        if (!err) { attached.add(tabId); resolve(); return; }
        const msg = String(err.message || err);
        const e = new Error(/already attached|another debugger/i.test(msg)
          ? 'Tab Flow đang bị DevTools/extension khác gỡ lỗi — đóng DevTools của tab đó rồi chạy lại (' + msg + ')'
          : 'Không gắn được debugger vào tab Flow: ' + msg);
        e.kind = 'DEBUGGER_BUSY';
        reject(e);
      });
    });
  }

  /** Gỡ debugger (idempotent, không bao giờ throw — dùng được trong finally). */
  function detach(tabId) {
    if (!attached.has(tabId)) return Promise.resolve();
    attached.delete(tabId);
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
    });
  }

  function isAttached(tabId) { return attached.has(tabId); }
  function attachedTabs() { return [...attached]; }

  /** Chỉ rê chuột (hover) — hiện nút ẩn theo hover của hàng bảng Flow. */
  function moveTo(tabId, x, y) {
    return cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  }

  /** mouseMoved → mousePressed → mouseReleased (chuột trái, clickCount 1) tại CSS px viewport. */
  async function clickAt(tabId, x, y) {
    await cmd(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
    const base = { x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' };
    await cmd(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
    await cmd(tabId, 'Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
  }

  /** Chèn chữ vào phần tử đang focus (kiểu IME — trusted, không cần map từng phím/ký tự). */
  function typeText(tabId, text) {
    return cmd(tabId, 'Input.insertText', { text: String(text == null ? '' : text) });
  }

  // key → {code, vk, text}. text chỉ cho phím sinh ký tự (Enter cần '\r' để trang nhận keypress).
  const KEYS = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', vk: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Delete: { key: 'Delete', code: 'Delete', vk: 46 },
    Escape: { key: 'Escape', code: 'Escape', vk: 27 },
    a: { key: 'a', code: 'KeyA', vk: 65 },
  };
  const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const MOD_KEYS = {
    alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
    ctrl: { key: 'Control', code: 'ControlLeft', vk: 17 },
    meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
    shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
  };

  /**
   * Nhấn 1 phím (keyDown + keyUp, đủ code + windowsVirtualKeyCode), kèm modifier
   * ctrl/shift/alt/meta nếu có. Ctrl+A gắn commands:['selectAll'] — một số bản Chrome
   * không tự map shortcut biên tập từ sự kiện CDP.
   */
  async function pressKey(tabId, key, modifiers) {
    const spec = KEYS[key];
    if (!spec) throw new Error('pressKey: phím chưa khai báo: ' + key);
    const mods = (modifiers || []).reduce((n, m) => n | (MODS[m] || 0), 0);
    const held = [];
    for (const m of modifiers || []) {
      const mk = MOD_KEYS[m];
      if (!mk) continue;
      await cmd(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: mk.key, code: mk.code,
        windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk, modifiers: MODS[m],
      });
      held.push(mk);
    }
    const down = {
      type: spec.text && !mods ? 'keyDown' : 'rawKeyDown',
      key: spec.key, code: spec.code,
      windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: mods,
    };
    if (spec.text && !mods) down.text = spec.text;
    if ((mods & MODS.ctrl) && key === 'a') down.commands = ['selectAll'];
    await cmd(tabId, 'Input.dispatchKeyEvent', down);
    await cmd(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: spec.key, code: spec.code,
      windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: mods,
    });
    for (const mk of held.reverse()) {
      await cmd(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: mk.key, code: mk.code,
        windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk,
      });
    }
  }

  return { attach, detach, isAttached, attachedTabs, clickAt, moveTo, typeText, pressKey };
})();

// eslint-disable-next-line no-undef
if (typeof module !== 'undefined' && module.exports) module.exports = FB_CDP;

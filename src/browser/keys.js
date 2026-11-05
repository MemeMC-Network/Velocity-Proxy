/**
 * Translates browser KeyboardEvent data from the client into raw CDP
 * Input.dispatchKeyEvent parameters. Using CDP directly keeps keydown
 * semantics (and therefore site shortcuts / web app frameworks) intact.
 */

const TEXT_KEYS = {
  Enter: '\r',
  Tab: '\t',
};

const NAMED_KEYCODES = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
};

const modifierMask = (modifiers = {}) =>
  (modifiers.alt ? 1 : 0) | (modifiers.ctrl ? 2 : 0) | (modifiers.meta ? 4 : 0) | (modifiers.shift ? 8 : 0);

export const buildKeyParams = ({ type, key, code, keyCode, modifiers, autoRepeat }) => {
  const keyValue = typeof key === 'string' ? key : '';
  const codeValue = typeof code === 'string' ? code : '';
  const mask = modifierMask(modifiers);
  const virtualKeyCode = Number.isFinite(Number(keyCode)) && Number(keyCode) > 0
    ? Number(keyCode)
    : NAMED_KEYCODES[keyValue] || 0;

  const base = {
    modifiers: mask,
    key: keyValue,
    code: codeValue,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    autoRepeat: Boolean(autoRepeat),
  };

  if (type === 'up') return { ...base, type: 'keyUp' };

  const printable = keyValue.length === 1 && !modifiers?.ctrl && !modifiers?.meta && !modifiers?.alt;
  if (printable) {
    return { ...base, type: 'keyDown', text: keyValue, unmodifiedText: keyValue };
  }
  if (TEXT_KEYS[keyValue]) {
    return { ...base, type: 'keyDown', text: TEXT_KEYS[keyValue], unmodifiedText: TEXT_KEYS[keyValue] };
  }
  return { ...base, type: 'rawKeyDown' };
};

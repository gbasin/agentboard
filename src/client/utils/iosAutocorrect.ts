/** Experimental native-input adapter. Enable only for append-at-cursor prompt entry. */
import { bracketedPaste } from './paste'
import type { Terminal } from '@xterm/xterm'

/** Replace a tracked suffix using terminal DEL, without splitting Unicode code points. */
export function correctionDelta(previous: string, next: string, explicitReplacement = false): string {
  const before = Array.from(previous)
  const after = Array.from(next)
  let common = 0
  while (common < before.length && common < after.length && before[common] === after[common]) common++
  const inserted = after.slice(common).join('')
  // An explicit paste ends Codex's paste-burst Enter suppression. Raw correction
  // letters followed immediately by CR would otherwise become a newline.
  return '\x7f'.repeat(before.length - common) + (explicitReplacement && inserted ? bracketedPaste(inserted) : inserted)
}

export function installIosAutocorrect(terminal: Terminal, canInput: () => boolean = () => true): { reset: () => void; dispose: () => void } {
  const textarea = terminal.textarea!
  const element = terminal.element!
  let sent = ''
  let emitting = false
  const original = ['autocorrect', 'autocapitalize', 'spellcheck'].map(name => [name, textarea.getAttribute(name)] as const)
  textarea.setAttribute('autocorrect', 'on')
  textarea.setAttribute('autocapitalize', 'off')
  textarea.setAttribute('spellcheck', 'true')
  const reset = () => { if (!emitting) { sent = ''; textarea.value = '' } }
  const emit = (data: string) => {
    if (!data || !canInput()) return
    emitting = true
    try { terminal.input(data, true) } finally { emitting = false }
  }
  const sync = (explicitReplacement: boolean) => {
    // WebKit inserts NBSP for keyboard spaces in its editing buffer.
    const next = textarea.value.replace(/\u00a0/g, ' ')
    emit(correctionDelta(sent, next, explicitReplacement))
    sent = next
  }
  const isTextKey = (event: KeyboardEvent) => !event.ctrlKey && !event.metaKey && !event.altKey
    && (Array.from(event.key).length === 1 || event.key === 'Backspace' || event.key === 'Enter' || event.keyCode === 229)
  const keyboard = (event: KeyboardEvent) => {
    if (event.target !== textarea) return
    if (isTextKey(event)) {
      // Preserve the browser default edit, but prevent xterm's keypress/IME path from also sending it.
      event.stopImmediatePropagation()
      if (event.type === 'keydown' && event.key === 'Backspace' && !sent && !textarea.value) {
        event.preventDefault()
        emit('\x7f')
      }
    } else if (event.type === 'keydown' && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) {
      reset()
    }
  }
  const beforeInput = (event: InputEvent) => {
    if (event.target !== textarea) return
    if (!canInput()) { event.preventDefault(); event.stopImmediatePropagation(); reset(); return }
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      event.preventDefault()
      event.stopImmediatePropagation()
      reset()
      emit('\r')
    }
  }
  const input = (event: Event) => {
    if (event.target !== textarea) return
    event.stopImmediatePropagation()
    if (!canInput()) { reset(); return }
    sync((event as InputEvent).inputType === 'insertReplacementText')
  }
  const composition = (event: Event) => {
    if (event.target === textarea) event.stopImmediatePropagation()
  }
  for (const name of ['keydown', 'keypress', 'keyup']) element.addEventListener(name, keyboard as EventListener, true)
  element.addEventListener('beforeinput', beforeInput as EventListener, true)
  element.addEventListener('input', input, true)
  for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) element.addEventListener(name, composition, true)
  textarea.addEventListener('blur', reset)
  element.addEventListener('paste', reset, true)
  return { reset, dispose() {
    for (const name of ['keydown', 'keypress', 'keyup']) element.removeEventListener(name, keyboard as EventListener, true)
    element.removeEventListener('beforeinput', beforeInput as EventListener, true)
    element.removeEventListener('input', input, true)
    for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) element.removeEventListener(name, composition, true)
    textarea.removeEventListener('blur', reset)
    element.removeEventListener('paste', reset, true)
    for (const [name, value] of original) { if (value === null) textarea.removeAttribute(name); else textarea.setAttribute(name, value) }
    reset()
  } }
}

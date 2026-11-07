/** Experimental native-input adapter. Enable only for append-at-cursor prompt entry. */
import type { Terminal } from '@xterm/xterm'

/** Replace a tracked suffix using terminal DEL, without splitting Unicode code points. */
export function correctionDelta(previous: string, next: string): string {
  const before = Array.from(previous)
  const after = Array.from(next)
  let common = 0
  while (common < before.length && common < after.length && before[common] === after[common]) common++
  return '\x7f'.repeat(before.length - common) + after.slice(common).join('')
}

export function installIosAutocorrect(terminal: Terminal): { reset: () => void; dispose: () => void } {
  const textarea = terminal.textarea!
  const element = terminal.element!
  let sent = ''
  const original = ['autocorrect', 'autocapitalize', 'spellcheck'].map(name => [name, textarea.getAttribute(name)] as const)
  textarea.setAttribute('autocorrect', 'on')
  textarea.setAttribute('autocapitalize', 'off')
  textarea.setAttribute('spellcheck', 'true')
  const reset = () => { sent = ''; textarea.value = '' }
  const emit = (data: string) => { if (data) terminal.input(data, true) }
  const sync = () => {
    // WebKit inserts NBSP for keyboard spaces in its editing buffer.
    const next = textarea.value.replace(/\u00a0/g, ' ')
    emit(correctionDelta(sent, next))
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
    sync()
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

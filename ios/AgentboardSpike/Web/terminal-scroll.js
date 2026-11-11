// Live sessions own history in tmux. Never scroll a second local xterm buffer.
// Capture touch events before xterm, including when UIKit disables xterm stdin.
window.installTerminalScroll = function (terminal, container, bridge) {
    let touch = null;
    let remainder = 0;
    let frame = null;
    const reset = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null; touch = null; remainder = 0;
    };
    const coast = (velocity, previous) => {
        frame = requestAnimationFrame(now => {
            frame = null;
            if (!bridge.live() || terminal.hasSelection()) { reset(); return; }
            // Bound work after a suspended frame; never replay a background backlog.
            const elapsed = Math.min(32, now - previous);
            const decay = Math.exp(-elapsed / 240);
            emit(velocity * 240 * (1 - decay));
            velocity *= decay;
            if (Math.abs(velocity) > 0.03) coast(velocity, now);
            else remainder = 0;
        });
    };
    const emit = delta => {
        remainder += delta;
        const count = Math.trunc(remainder / 30);
        remainder -= count * 30;
        const button = count < 0 ? 64 : 65;
        const col = Math.max(1, Math.floor(terminal.cols / 2));
        const row = Math.max(1, Math.floor(terminal.rows / 2));
        if (count) bridge.input(`\x1b[<${button};${col};${row}M`.repeat(Math.abs(count)));
    };
    container.addEventListener('touchstart', event => {
        reset();
        if (!bridge.live() || event.touches.length !== 1 || terminal.hasSelection()) return;
        const point = event.touches[0];
        touch = { id: point.identifier, x: point.clientX, y: point.clientY, scrolling: false, time: performance.now(), velocity: 0 };
        // Prevent xterm starting its own touch scroll; taps still reach WebKit.
        event.stopImmediatePropagation();
    }, { capture: true, passive: true });
    container.addEventListener('touchmove', event => {
        if (!touch) return;
        if (!bridge.live() || event.touches.length !== 1 || terminal.hasSelection()) { reset(); return; }
        const point = event.touches[0];
        if (point.identifier !== touch.id) { reset(); return; }
        const dx = point.clientX - touch.x;
        const dy = point.clientY - touch.y;
        event.stopImmediatePropagation();
        if (!touch.scrolling) {
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) { reset(); return; }
            if (Math.abs(dy) < 8) return;
            touch.scrolling = true;
        }
        event.preventDefault();
        const now = performance.now();
        const elapsed = Math.max(1, now - touch.time);
        touch.velocity = Math.max(-3, Math.min(3, -dy / elapsed));
        touch.time = now;
        emit(-dy);
        touch.y = point.clientY;
    }, { capture: true, passive: false });
    container.addEventListener('touchend', () => {
        const last = touch;
        const now = performance.now();
        touch = null;
        if (last?.scrolling && now - last.time < 80 && Math.abs(last.velocity) > 0.1) {
            coast(last.velocity, now);
        } else reset();
    }, { capture: true });
    container.addEventListener('touchcancel', reset, { capture: true });
    terminal.attachCustomWheelEventHandler(event => {
        if (!bridge.live()) return true;
        if (frame !== null) reset();
        if (event.shiftKey || terminal.hasSelection()) return false;
        const unit = event.deltaMode === 1 ? 30 : event.deltaMode === 2 ? container.clientHeight : 1;
        emit(event.deltaY * unit);
        return false;
    });
    return { reset };
}

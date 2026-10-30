# Central state traces

## Retained size influence

Invariant: a view that explicitly suspends must not continue setting shared pane dimensions.

Current:
t0 desktop={tty:D,cols:160,visible:true,ignoreSize:false}; phone={tty:P,cols:40,visible:true,ignoreSize:false}; pane={cols:40}
t1 phone visibility hidden -> runtime.suspend: phone={tty:P,ready:false,currentSession:null,ignoreSize:false}; pane={cols:40}. Violation: observer remains sizing participant.
t2 desktop input with latest mode makes pane160; smallest mode stays40. Actual probe confirmed both.

Fixed:
t1 suspend invalidates input/generation immediately and queues P ignoreSize=true.
t2 queued mutation completes: phone={tty:P,ready:false,ignoreSize:true}; pane={cols:160}.
t3 foreground attach awaits P ignoreSize=false after any queued suspend, then capture/switch/verification. Only current sequence may become ready.
Startup edge: relay-created PTY begins ignoreSize=true. Hide before start resolves never enables it. A stale start callback cannot restore sizing.
Disposal edge: mark proxy DEAD before queue drain; queued stale mutations skip, in-flight command finishes before deliberate PTY release. Natural exits remain a separate tty-identity hazard to review.

## Overload retry

Invariant: transport OPEN alone does not prove the consumer can sustain terminal output.

Current:
t0 socket={open:true,outstanding:0,retry:0}; producer={running:true}; parser={acks:false}.
t1 outstanding reaches1MiB -> close1013; socket.retry=1, reconnect scheduled1s.
t2 replacementOPEN resets retry0; parser stillacksfalse.
t3 repeats t1/t2 indefinitely. Real probe observed four closures in about12s.

Fixed:
t1 close1013 increments overload streak and records absolute not-before deadline.
t2 OPEN retains streak; repeated close schedules2s,4s,... capped30s. Visibility cannot bypass deadline.
t3 producer stops/consumer progresses; visible verified-ready stable interval clears streak. Quiet terminals must also qualify once transport health proves readiness.

## Lazy worker allocation

Invariant: a catalog-only browser needs a token, not a PTY worker realm.
Current handshake createslease+worker even with no terminal selection (six tabs measured +85MiB immediately).
Fixed handshake createslease={token,owner,claim,worker:null}; firstvalidattach creates/popsworker, sendsinit thenresume thenattach in FIFO order. Updates beforeattach only update front registry; init seeslatest snapshot. Close/expiry of worker:null lease must not create retirement promise or worker. Staleowner cannot lazilyspawn. Worker capacity includes active,retiring,idle; unused lightweightleases remain under existingleasecap.

## Reviewed recovery input

Invariant: unavailable input can become editable text, never an automatically replayed terminal command.
A={identity:[sessionId,target,host,remote],ready:false,draft:none}; type printable text/newline -> A.draft={text,pending:true}; socket sends nothing.
A.ready=true after current parser barrier -> draft stays pending; continued typing extends it rather than becoming a command.
Select B -> B sees only B's draft; A remains in local browser storage. Return A -> same text. No resume, ready, selection, or visibility event sends it.
Explicit Send with ready=false -> disabled. Explicit Send returning false -> same pending draft. Successful explicit Send -> one bracketed terminal-paste with reviewed text, then clear; no extra Enter.
Control/escape sequences and file uploads are excluded. Async clipboard work started before a generation change stays canceled.
Total capacity64KiB across identities; truncation persists as pending even if zero characters fit. Review shows warning and explicit discard-other-terminal-drafts action, avoiding silent rejection. Editing/discarding acknowledges the truncated text.
Mobile keyboard can open locally while unready; command/file controls stay gated. Browser reload restores the durable record for review. Failed saving has an explicit memory-only warning. A successful send whose stored copy cannot be removed enters a cleanup-only state and cannot send again.

## WebKit overload close-code loss

Native WebSocket pressure probe (no Playwright routing): same server1013 close becomes1005 in WebKit. Backoff keyed only to CloseEvent.code loops1s.
Fixed: bounded terminal-overload frame precedes close; current socket records overload and revokes readiness immediately. Close increments once regardless of1005/1013; stale sockets ignored.
Real-browser measurements: Chromium retry1006/2000/4007ms; WebKit1004/1999/4006ms. Both recover withoutreload and deliver final marker once afterproducerstops.


## Backend restart and durable identity

Native failed control: stored A key included createdAt20:26:42.286, restart regenerated createdAt20:31:54.883, same tmuxPID7831/window@0. Record remained on disk, but key mismatch hid the draft.
Fixed: known tmuxPID plus monotonic windowID owns the key; synthesized creation time is excluded. Missing PID uses conservative legacy timestamp fallback. Late board/run tags do not alter it. Native restart then actualSafariReload restores exact text; explicitDiscard then secondReload leavesnone; root actualpane marker absent throughout.

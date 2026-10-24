# Draft review and broad-suite follow-up

The earlier root full-suite run failed digit navigation and several first-in-file paste cases. Its server predates the PTY spawn mutex. The precise cause of those paste failures was not reproduced or established.

Fresh-server diagnostics on isolated port4194: app-mouse2 + arrow + files4 passed7/7. Adding app tests passed8/9; digit failed because an exiting mouse-sel DOM row shifted the DOM index while the live session count already excluded it. The digit test now owns both windows, filters DOM order by live API IDs, and cleans up both windows.

Five repeats of browser-files4 + manual-paste2 + paste1 passed35/35 with fresh mutex code. Native WebSocket diagnostics show several ERR_TMUX_SWITCH_FAILED messages for deleted auto-selected old windows followed by a successful current attach with a new attachId. No current-target failure appeared. Raw stdout retained in repeat-35.log. This does not prove the spawn mutex caused the earlier failures.

Temporary WS instrumentation was removed. Fixed attach sleeps are replaced by actual selection, ready-status absence, and enabled Paste controls; browser-files also checks that typed Compare text reached the real pane before uploading. Final root rerun still required.

Terminal unavailable now remains visible when connected input is unready after an attachment error. Component regression passed.

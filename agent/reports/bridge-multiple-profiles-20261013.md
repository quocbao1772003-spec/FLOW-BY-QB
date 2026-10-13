# Multiple Chrome profiles — 2026-10-13

## Evidence

- Request 326 completed with two references and Nano Banana Pro. The user confirmed the image was produced.
- Request 327 failed with UNUSUAL_ACTIVITY. Its error text matched an older extension implementation, not current source, and its trace lacked the new context fields.
- The next attempt returned legacy tRPC `project.createProject` UNAUTHORIZED, whereas current code routes that operation to BOQ.
- At investigation time port 9223 had two established client sockets (remote ports 64005 and 63918). The user confirmed multiple browser profiles with Bridge installed.
- `ws_server._handler` previously selected every newly connected socket. Messages from all sockets reached the shared identity/cache. Any socket disconnect called `clear_extension()` unconditionally, including when another socket was active.

This establishes a connection ownership defect and explains how old behavior can reappear. It does not prove that every Google 403 in the history has the same cause.

## Fix — Bridge 0.1.15

- Require protocol 2 hello with version and a locally persisted random profile instance before selecting a socket or sending its callback secret.
- First accepted profile owns the agent session. Another profile is rejected without altering requests, identity, callback secret or selected socket.
- Disconnect cleanup and inbound messages are checked against socket ownership. Same-profile reconnect is allowed after disconnect; another profile requires intentional agent restart.
- Rotate callback secrets on connect/disconnect. Discard delayed credit lookup results from a previous connection/token.
- Show connected in the popup only after agent acceptance, with a readable rejection reason.
- Load profile instance lazily on every worker lifecycle, including alarm wakes without onStartup.

## Verification

Six unittest regressions passed: legacy rejection, second-profile rejection and dispatch ownership, unrelated disconnect during an active job, same-profile reconnect with secret rotation, rejection cleanup isolation, and stale identity after logout. Extension test suite passed before live reload.

Prepared a separate board **QA Image 0-3 refs - 13 Oct** (board 3), nodes 43–46 for text-only and one/two/three reference inputs. Live four-case verification pending reload of 0.1.15 in the selected Chrome profile. No generation result is claimed for these cases yet.

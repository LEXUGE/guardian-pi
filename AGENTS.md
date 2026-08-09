 # Guardian Pi

 This project runs inside an ephemeral Guardian sandbox. The following environment
 constraints apply to every agent session and must not be violated.

 ## Network

 - All network access is exposed **only** through the SOCKS5 proxy
   `socks5h://127.0.0.1:1080`.
 - Direct outbound connections are not available. Any tool, command, or process
   that needs network access must route traffic through this proxy (e.g. `-D`,
   `--proxy`, or `ALL_PROXY`/`HTTPS_PROXY` set to `socks5h://127.0.0.1:1080`).

 ## Persistence

 - **Only `/workspace` is persisted** across tool calls and sessions.
 - Any changes written anywhere outside `/workspace` (e.g. `/tmp`, `/home`,
   system directories) will be lost and must be treated as ephemeral.
 - Persist all important files, results, and configuration under `/workspace`.
 - Assume the container may be torn down at any time; do not rely on state
   surviving anywhere other than `/workspace`.

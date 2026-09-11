# dsh-opencode-session (local fork)

Local fork of [dsh-opencode-session](https://github.com/nobu121/dsh-opencode-session)
(upstream 0.1.1) as a temporary patch until the `@earendil-works/pi-ai`
upstream fix (commit `561a2e0`, "fix(ai): send OpenCode session header")
ships in a DeepSeek Harness release.

## Fork deltas

1. **Force override** — while a per-session store is active (explicit model
   calls on `opencode` / `opencode-go` routes), the patched fetch now
   force-sets `x-opencode-session` instead of skipping requests that already
   carry the header. A static header configured on the provider profile can
   no longer shadow the per-session value.
2. **Auxiliary-call fallback** — calls that carry no session id (implicit
   model calls from other plugins, e.g. memory auto-summary) previously
   passed through untouched and failed with `400 MissingSessionID`. When the
   new `fallback` config value is set, such requests aimed at the OpenCode
   gateway (`opencode.ai` and subdomains) get the stable fallback value
   filled in, unless the request already carries the header.

Everything else (AsyncLocalStorage plumbing, `llm/stream` waterfall hook,
fiber-scoped fetch patch, debug logging) is unchanged from upstream.

## Install / update

```
dsh plugin --profile web add github:Dessera/dsh-opencode-session
```

To install from a local checkout instead (e.g. for development):

```
dsh plugin --profile web add D:\Projects\dsh-opencode-session-fork
```

A local-path install materializes as a pnpm `link:` junction, so edits to
the fork sources take effect on the next full dsh restart — no re-install
needed. A GitHub install tracks the published commits; re-run the add
command after the fork receives new commits.

## Retire when upstream lands

```
dsh plugin --profile web remove dsh-opencode-session
```

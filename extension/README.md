# OpenCLI Browser Bridge Extension

The extension connects Chrome tabs to the local OpenCLI daemon. It uses Chrome
extension APIs only as a transport and browser-control layer for explicit CLI
commands.

## Permission Notes

- `debugger`: sends CDP commands to OpenCLI-controlled or bound tabs.
- `tabs`: manages the dedicated OpenCLI automation windows and reports selected
  tab metadata back to the CLI.
- `cookies`: reads cookies for browser-backed adapters that need authenticated
  fetches.
- `downloads`: surfaces download lifecycle to `opencli browser wait download`.
  The extension observes started / in-progress / completed / failed downloads so
  the CLI can wait for a file triggered by an automation command. OpenCLI
  filters by the command's filename/URL pattern and timeout, and does not modify,
  redirect, or persist browser download history.

Suggested Chrome Web Store justification for `downloads`:

> This extension uses `chrome.downloads` to surface download lifecycle
> (started / in-progress / completed / failed) to the OpenCLI command-line tool,
> so agents can wait for downloads triggered during an automation workflow. The
> command filters by a user-provided filename or URL pattern and timeout. We do
> not modify, redirect, or persist user download history.

## Form-fill Agent

The popup's **Fill this page with DeepSeek Harness** button binds the current
tab to a fresh `opencli browser` session and asks the daemon to open a Terminal
window running a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) agent for it. The workspace is created under `~/Downloads/opencli-agent-*`,
and the task is in its `TASK.md`. Each reply you type runs one headless
`dsh --json` turn, and later turns resume the same session. The agent only fills
fields. You review and submit the form yourself.

The agent looks up your details in your local files first (InfoGrep, then
Spotlight) and uses web search only as a last resort for public facts. For the
InfoGrep tools, create a dedicated dsh profile. Without it the agent runs on the
stock `headless` profile, without InfoGrep.

```sh
dsh --profile opencli-form-fill --from-default-profile headless --help
```

Then add the InfoGrep MCP server to `~/.dsh/profiles/opencli-form-fill/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-infogrep
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: infogrep
        transport: stdio
        command: /path/to/infogrep
        args: [ 'mcp', '--dir', '/path/to/indexed/folder' ]
        toolCallTimeoutMs: 900000

# Optional: keep the full session log, which includes your personal details,
# out of official DeepSeek API requests.
- id: session-log-deepseek
  name: '@deepseek-ai/dsh-session-log-deepseek'
  config:
    enabled: false
```

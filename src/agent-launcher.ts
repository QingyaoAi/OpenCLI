/**
 * Launches a DeepSeek Harness (dsh) form-fill agent in a fresh Terminal
 * window, seeded with a task file that points it at an opencli browser
 * session already bound to the user's current Chrome tab (see extension's
 * "Fill this page" button). The window runs form-fill-chat, which drives dsh
 * one headless turn at a time.
 */

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

export function buildFormFillTask(session: string, url: string, contextId?: string): string {
  const profileFlag = contextId ? ` --profile ${contextId}` : '';
  return `# OpenCLI form-fill task

An OpenCLI browser session named "${session}" is already bound to the user's
currently open Chrome tab:

  URL: ${url}

Use \`opencli${profileFlag} browser ${session} state\` to see the page, and
\`opencli${profileFlag} browser ${session} <command>\` (click/fill/type/select/...)
to interact with it. Then help the user fill out any form(s) visible on the page.

If that \`state\` command fails, stop and tell the user the error (the
extension may be disconnected or the tab closed). Do not try to work around it
by inspecting opencli, Chrome, ports, processes, or other apps' data.

## Where to get the user's information

The values are about the user, so look them up in the user's own local files
first, in this order:

1. InfoGrep (the \`mcp__infogrep__*\` tools) searches the content of the user's
   local documents. Run one focused query per field (name, affiliation, email,
   phone, address, ID or passport number, dates, ...): \`search_sparse\` for
   exact names, numbers and dates, \`search_hybrid\` otherwise. Before entering a
   value, read the file the hit came from to confirm it in context. Snippets
   are truncated.
2. Other local sources, when InfoGrep has nothing: Spotlight (\`mdfind\`) and
   reading the matching files directly. Stay within the user's documents. Do
   not dig through app data, browser profiles, caches, or other agents' logs.
3. Web search is a last resort for public, non-sensitive facts, such as an
   institution's official name or address, after local files came up empty.
   Never use it for personal identifiers such as ID numbers, phone numbers or
   account details. Tell the user when a value came from the web.

If none of these give a value, ask the user. Never guess personal or sensitive
data.

## Rules

- Only fill fields in. Do NOT click submit / pay / apply. Leave that for the
  user to review and do themselves.
- When done, list each field you filled with its value and source (file path,
  web page, or "asked user"), plus any fields you left empty.
`;
}

/** Command that runs the chat loop, from source (tsx) in dev and from dist otherwise. */
function formFillChatCommand(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsPath = join(here, 'form-fill-chat.ts');
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // tsx is resolved from here: the script runs with the workspace as cwd,
  // where a bare `--import tsx/esm` would not resolve.
  return existsSync(tsPath)
    ? `${quote(process.execPath)} --import ${quote(import.meta.resolve('tsx/esm'))} ${quote(tsPath)}`
    : `${quote(process.execPath)} ${quote(join(here, 'form-fill-chat.js'))}`;
}

/**
 * Creates a workspace under ~/Downloads with a TASK.md + start.sh, then opens
 * it in a new Terminal window running the dsh chat loop. Best-effort: on
 * platforms without a supported terminal launcher, the workspace is still
 * created and logged so the user can run it manually.
 */
export async function launchFormFillAgent(session: string, url: string, contextId?: string): Promise<void> {
  const dirName = `opencli-agent-${Date.now()}-${session}`;
  const workspaceDir = join(homedir(), 'Downloads', dirName);
  mkdirSync(workspaceDir, { recursive: true });

  writeFileSync(join(workspaceDir, 'TASK.md'), buildFormFillTask(session, url, contextId), 'utf-8');

  // dsh headless never prompts for approval. Its default workspace-write
  // sandbox still lets the agent read the user's files and reach the local
  // opencli daemon, while writes stay confined to this workspace.
  const scriptPath = join(workspaceDir, 'start.sh');
  writeFileSync(scriptPath, `#!/bin/bash\ncd "${workspaceDir}"\n${formFillChatCommand()}\n`, 'utf-8');
  chmodSync(scriptPath, 0o755);

  if (process.platform === 'darwin') {
    const appleScript = `tell application "Terminal"
  activate
  do script "bash ${scriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell`;
    execFile('osascript', ['-e', appleScript], (err) => {
      if (err) log.warn(`[daemon] Failed to open Terminal for form-fill agent: ${err.message}`);
    });
    return;
  }

  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', 'cmd', '/k', `bash "${scriptPath}"`], (err) => {
      if (err) log.warn(`[daemon] Failed to open a terminal for form-fill agent: ${err.message}`);
    });
    return;
  }

  log.warn(`[daemon] Cannot auto-open a terminal on this platform; run manually: bash ${scriptPath}`);
}

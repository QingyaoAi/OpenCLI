/**
 * Launches a Claude Code agent in a fresh Terminal window, seeded with a
 * task file that points it at an opencli browser session already bound to
 * the user's current Chrome tab (see extension's "Fill this page" button).
 */

import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

Rules:
- Ask the user for any information you do not already know before entering it —
  never guess personal or sensitive data.
- Only fill fields in. Do NOT click submit / pay / apply — leave that for the
  user to review and do themselves.
`;
}

/**
 * Creates a workspace under ~/Downloads with a TASK.md + start.sh, then opens
 * it in a new Terminal window running Claude Code. Best-effort: on platforms
 * without a supported terminal launcher, the workspace is still created and
 * logged so the user can run it manually.
 */
export async function launchFormFillAgent(session: string, url: string, contextId?: string): Promise<void> {
  const dirName = `opencli-agent-${Date.now()}-${session}`;
  const workspaceDir = join(homedir(), 'Downloads', dirName);
  mkdirSync(workspaceDir, { recursive: true });

  writeFileSync(join(workspaceDir, 'TASK.md'), buildFormFillTask(session, url, contextId), 'utf-8');

  const scriptPath = join(workspaceDir, 'start.sh');
  writeFileSync(
    scriptPath,
    `#!/bin/bash\ncd "${workspaceDir}"\nclaude "Read TASK.md in this directory and follow its instructions to help me fill out the form on the page it describes."\n`,
    'utf-8',
  );
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

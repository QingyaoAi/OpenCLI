/**
 * Terminal chat loop for the form-fill agent (see agent-launcher.ts).
 *
 * DeepSeek Harness (dsh) has no terminal chat UI, so each user turn is one
 * `dsh --profile <p> --json` headless run in the workspace directory; every
 * follow-up turn resumes the same session via --session-id. The task text is
 * piped over stdin so user replies never get parsed as dsh flags.
 *
 * Run with the workspace as cwd: `node form-fill-chat.js`.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Headless bundle + the InfoGrep MCP server; see the form-fill section of extension/README.md. */
export const FORM_FILL_DSH_PROFILE = 'opencli-form-fill';

export const FORM_FILL_FIRST_MESSAGE =
  'Read TASK.md in this directory and follow its instructions to help me fill out the form on the page it describes.';

const MAX_TOOL_LINE = 160;
const EXIT_GRACE_MS = 15_000;

type DshEvent = { type?: unknown; [key: string]: unknown };

/** The dedicated form-fill profile when it exists, else the stock headless one. */
export function resolveDshProfile(dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')): string {
  return existsSync(join(dshHome, 'profiles', FORM_FILL_DSH_PROFILE, 'package.json'))
    ? FORM_FILL_DSH_PROFILE
    : 'headless';
}

export function buildDshArgs(profile: string, sessionId?: string): string[] {
  return ['--profile', profile, '--json', ...(sessionId ? ['--session-id', sessionId] : [])];
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
    return (input as { command: string }).command;
  }
  return input === undefined ? '' : JSON.stringify(input);
}

/**
 * The line to print for a dsh `--json` event, or null when the user doesn't
 * need to see it. `session`, `text` and `final` are handled by the turn
 * runner itself; `thinking` and ordinary status events are dropped.
 */
export function formatDshEvent(event: DshEvent): string | null {
  if (event.type === 'tool_call') {
    const line = `→ ${String(event.tool)} ${summarizeToolInput(event.input)}`.replace(/\s+/g, ' ').trim();
    return line.length > MAX_TOOL_LINE ? `${line.slice(0, MAX_TOOL_LINE - 1)}…` : line;
  }
  if (event.type === 'error') return `dsh error: ${String(event.message ?? 'unknown error')}`;
  if (event.type === 'status' && event.phase === 'turn_end') {
    const reason = event.reason as { kind?: unknown; message?: unknown } | undefined;
    if (reason?.kind === 'completed') return null;
    return `(turn ended: ${String(reason?.kind ?? 'unknown')}${reason?.message ? ` — ${String(reason.message)}` : ''})`;
  }
  return null;
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

/** Runs one dsh turn, streaming progress; resolves to the session id it used. */
async function runTurn(profile: string, message: string, sessionId?: string): Promise<string | undefined> {
  const child = spawn('dsh', buildDshArgs(profile, sessionId), { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(message);

  // Ctrl-C reaches dsh too (same process group) and aborts the turn; keep the
  // chat loop alive so the user can redirect the agent.
  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.on('SIGINT', onSigint);

  // dsh has been seen idling for hours after a long turn ended, never exiting.
  // Every event is already in the session log by then (resuming works after a
  // kill), so once a turn ends give dsh a grace period, then stop it. A new
  // turn_start (dsh continuing on its own) disarms the timer.
  let stoppedAfterTurn = false;
  let exitTimer: NodeJS.Timeout | undefined;
  const armExitTimer = () => {
    exitTimer ??= setTimeout(() => {
      stoppedAfterTurn = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, EXIT_GRACE_MS);
  };
  const disarmExitTimer = () => {
    clearTimeout(exitTimer);
    exitTimer = undefined;
  };

  let currentSession = sessionId;
  // The latest assistant text is held back: if the turn ends normally the
  // `final` event repeats it untruncated (`text` events are capped at 8 KiB).
  let heldText: string | null = null;
  const flushHeld = () => {
    if (heldText) console.log(`\n${heldText.trim()}\n`);
    heldText = null;
  };

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let event: DshEvent;
    try {
      event = JSON.parse(line) as DshEvent;
    } catch {
      return;
    }
    if (event.type === 'status' && event.phase === 'turn_start') disarmExitTimer();
    if ((event.type === 'status' && event.phase === 'turn_end') || event.type === 'final') armExitTimer();

    if (event.type === 'session' && typeof event.sessionId === 'string') {
      currentSession = event.sessionId;
    } else if (event.type === 'text' && typeof event.text === 'string') {
      flushHeld();
      heldText = event.text;
    } else if (event.type === 'final' && typeof event.text === 'string') {
      // No held text means the final answer was already printed before a
      // later tool call (e.g. the turn was aborted mid-tool).
      if (heldText !== null) heldText = event.text;
      flushHeld();
    } else {
      const out = formatDshEvent(event);
      if (out) {
        flushHeld();
        console.log(dim(out));
      }
    }
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      stderr += err.code === 'ENOENT'
        ? 'dsh: command not found on PATH — install DeepSeek Harness or add it to PATH.\n'
        : `dsh: ${err.message}\n`;
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  disarmExitTimer();
  lines.close();
  process.off('SIGINT', onSigint);
  flushHeld();

  // stderr also carries MCP server logs; on failure show only dsh's own
  // diagnostics, or the raw tail when dsh died before printing any.
  if (interrupted) {
    console.log(dim('(interrupted)'));
  } else if (stoppedAfterTurn) {
    console.log(dim('(dsh did not exit after the turn ended; stopped it)'));
  } else if (exitCode !== 0) {
    const diagnostics = stderr.split('\n').filter((l) => l.startsWith('dsh:'));
    const shown = diagnostics.length > 0 ? diagnostics : stderr.trim().split('\n').slice(-15);
    if (shown.join('').trim()) console.error(shown.join('\n'));
  }
  return currentSession;
}

/** Reads one line from the user; null on Ctrl-D / Ctrl-C. */
function ask(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => { if (!answered) resolve(null); });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

export async function main(): Promise<void> {
  const profile = resolveDshProfile();
  console.log(`OpenCLI form-fill agent · DeepSeek Harness (dsh --profile ${profile})`);
  if (profile !== FORM_FILL_DSH_PROFILE) {
    console.log(dim(`dsh profile "${FORM_FILL_DSH_PROFILE}" not found; running without the InfoGrep MCP tools.`));
  }
  console.log(dim('Reply after each answer. Ctrl-C stops the running turn; Ctrl-D or "exit" quits.'));

  let sessionId: string | undefined;
  let message = FORM_FILL_FIRST_MESSAGE;
  for (;;) {
    sessionId = await runTurn(profile, message, sessionId);
    let answer: string | null;
    do answer = await ask('you> ');
    while (answer !== null && !answer.trim());
    if (answer === null || /^(exit|quit)$/i.test(answer.trim())) return;
    message = answer;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

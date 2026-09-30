import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFormFillTask } from './agent-launcher.js';
import { FORM_FILL_DSH_PROFILE, buildDshArgs, formatDshEvent, resolveDshProfile } from './form-fill-chat.js';

describe('resolveDshProfile', () => {
  let dshHome: string | undefined;
  afterEach(() => {
    if (dshHome) rmSync(dshHome, { recursive: true, force: true });
    dshHome = undefined;
  });

  it('uses the dedicated form-fill profile when it exists', () => {
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    mkdirSync(join(dshHome, 'profiles', FORM_FILL_DSH_PROFILE), { recursive: true });
    writeFileSync(join(dshHome, 'profiles', FORM_FILL_DSH_PROFILE, 'package.json'), '{}');
    expect(resolveDshProfile(dshHome)).toBe(FORM_FILL_DSH_PROFILE);
  });

  it('falls back to the stock headless profile', () => {
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'));
    expect(resolveDshProfile(dshHome)).toBe('headless');
  });
});

describe('buildDshArgs', () => {
  it('starts a fresh session, then resumes it', () => {
    expect(buildDshArgs('p')).toEqual(['--profile', 'p', '--json']);
    expect(buildDshArgs('p', 'session-1')).toEqual(['--profile', 'p', '--json', '--session-id', 'session-1']);
  });
});

describe('formatDshEvent', () => {
  it('shows a bash tool call as its command on one line', () => {
    expect(formatDshEvent({ type: 'tool_call', tool: 'bash', input: { command: 'opencli browser s state\n' } }))
      .toBe('→ bash opencli browser s state');
  });

  it('shows other tool calls with their JSON input, truncated', () => {
    expect(formatDshEvent({ type: 'tool_call', tool: 'mcp__infogrep__search_sparse', input: { query: 'passport' } }))
      .toBe('→ mcp__infogrep__search_sparse {"query":"passport"}');
    const long = formatDshEvent({ type: 'tool_call', tool: 't', input: { q: 'x'.repeat(500) } });
    expect(long).toHaveLength(160);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('reports errors and abnormal turn ends, and drops everything else', () => {
    expect(formatDshEvent({ type: 'error', message: 'boom' })).toBe('dsh error: boom');
    expect(formatDshEvent({ type: 'status', phase: 'turn_end', reason: { kind: 'aborted' } })).toBe('(turn ended: aborted)');
    expect(formatDshEvent({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })).toBeNull();
    expect(formatDshEvent({ type: 'status', phase: 'step_start' })).toBeNull();
    expect(formatDshEvent({ type: 'thinking', text: 'hmm' })).toBeNull();
  });
});

describe('buildFormFillTask', () => {
  it('points at the bound session and puts local lookups before web search', () => {
    const task = buildFormFillTask('fill-1', 'https://example.com/form', 'ctx9');
    expect(task).toContain('opencli --profile ctx9 browser fill-1 state');
    expect(task).toContain('https://example.com/form');
    const infogrep = task.indexOf('mcp__infogrep__');
    const web = task.indexOf('Web search is a last resort');
    expect(infogrep).toBeGreaterThan(-1);
    expect(web).toBeGreaterThan(infogrep);
    expect(task).toContain('Do NOT click submit');
  });
});

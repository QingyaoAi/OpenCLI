/**
 * Doubao AI Chat via browser automation.
 * Doubao is ByteDance's AI assistant (www.doubao.com).
 *
 * Thin wrapper around the same send/wait helpers the official `doubao ask`
 * command uses — the original hand-rolled DOM interaction here (element
 * handles, page.$/keyboard/waitForFunction) predated those helpers and no
 * longer matches this SDK's IPage API.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { DOUBAO_DOMAIN, getDoubaoTranscriptLines, getDoubaoVisibleTurns, sendDoubaoMessage, waitForDoubaoResponse } from './utils.js';

cli({
    site: 'doubao',
    name: 'chat',
    access: 'write',
    description: 'Chat with Doubao AI',
    domain: DOUBAO_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false,
    args: [
        { name: 'message', positional: true, required: true, help: 'Message to send to Doubao AI' },
        { name: 'timeout', type: 'int', default: 60, help: 'Timeout in seconds for response (default: 60)' },
    ],
    columns: ['response'],
    func: async (page, args) => {
        const timeout = args.timeout;
        if (!Number.isInteger(timeout) || timeout < 1) {
            throw new ArgumentError('--timeout must be a positive integer (seconds)');
        }
        const beforeTurns = await getDoubaoVisibleTurns(page);
        const beforeLines = await getDoubaoTranscriptLines(page);
        await sendDoubaoMessage(page, args.message);
        const response = await waitForDoubaoResponse(page, beforeLines, beforeTurns, args.message, timeout);
        return [{ response: response || `No response within ${timeout}s. Doubao may still be generating.` }];
    },
});

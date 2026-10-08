import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Foreman } from '../../foreman.js';
import { classifyToolUse, describeRuleKey, describeToolCall } from '../../policy.js';
import { PERMISSION_OPTIONS } from '../../protocol.js';
import { truncate } from '../../util/text.js';
import { userName } from '../../user.js';

/** Shared permission path for the legacy backend and role queue SDK turns. */
export function toolPermission(fm: Foreman, agentId: string, role: 'lead' | 'worker', cwd: string,
  turn: { signal: AbortSignal }, server = 'agentcraft', waiting?: (value: boolean) => void): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      // a stopped/paused/cancelled turn runs nothing more, even if its CLI has not exited yet
      if (turn.signal.aborted) return { behavior: 'deny', message: `Your turn was stopped by ${userName()}.`, interrupt: true };
      const verdict = classifyToolUse(toolName, input, {
        role,
        cwd,
        readDirs: [fm.memory.dir],
        alwaysAllow: fm.store.data.permissionRules[agentId] ?? [],
        mcpServer: server,
      });
      if (verdict.action === 'allow') return { behavior: 'allow', updatedInput: input };
      if (verdict.action === 'deny') {
        fm.agentLog(agentId, 'error', `blocked: ${describeToolCall(toolName, input)} (${verdict.reason})`);
        return { behavior: 'deny', message: verdict.reason };
      }
      const prev = fm.agent(agentId);
      const prevState = prev ? { state: prev.state, station: prev.station, activity: prev.activity } : undefined;
      waiting?.(true);
      const t = prev?.taskId;
      const d = fm.createDecision({
        agentId,
        kind: 'permission',
        tool: toolName,
        question: `${fm.nameOf(agentId)} wants to run ${truncate(describeToolCall(toolName, input), 160)}`,
        options: [...PERMISSION_OPTIONS],
        context: `${describeToolCall(toolName, input)}\n${verdict.reason}\ncwd: ${cwd}\n"${PERMISSION_OPTIONS[1]}" covers: ${[...new Set(verdict.ruleKeys.map(describeRuleKey))].join('; ')}${opts.title ? `\n${opts.title}` : ''}`,
        ...(t ? { taskId: t } : {}),
      });
      fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'asking permission' });
      fm.agentLog(agentId, 'tool', `permission? ${describeToolCall(toolName, input)}`);
      const onAbort = () => fm.decisions.cancel(d.id, 'turn stopped');
      if (opts.signal.aborted || turn.signal.aborted) onAbort();
      else {
        turn.signal.addEventListener('abort', onAbort, { once: true });
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      const res = await fm.decisions.wait(d.id);
      opts.signal.removeEventListener('abort', onAbort);
      turn.signal.removeEventListener('abort', onAbort);
      if (!turn.signal.aborted) waiting?.(false);
      if (opts.signal.aborted || turn.signal.aborted) return { behavior: 'deny', message: 'The turn was stopped.' };
      if (prevState) fm.setAgent(agentId, prevState);
      const opt = res.answer?.option;
      if (res.status === 'answered' && (opt === PERMISSION_OPTIONS[0] || opt === PERMISSION_OPTIONS[1])) {
        if (opt === PERMISSION_OPTIONS[1]) {
          // every key the call needed: each is scoped (see policy.ts), so this grants exactly
          // what the prompt listed
          const rules = (fm.store.data.permissionRules[agentId] ??= []);
          for (const k of verdict.ruleKeys) if (!rules.includes(k)) rules.push(k);
          fm.store.markDirty();
        }
        fm.agentLog(agentId, 'result', `${userName()} allowed: ${describeToolCall(toolName, input)}`);
        return { behavior: 'allow', updatedInput: input };
      }
      fm.agentLog(agentId, 'error', `${res.status === 'cancelled' ? 'Permission request withdrawn' : `${userName()} denied`}: ${describeToolCall(toolName, input)}`);
      return { behavior: 'deny', message: `${userName()} denied this${res.answer?.text ? `: ${res.answer.text}` : ''}. Find another way or ask_user.` };
    };
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AcpError } from '@process/acp/errors/AcpError';
import { normalizeError } from '@process/acp/errors/errorNormalize';
import type { AcpMetrics } from '@process/acp/metrics/AcpMetrics';
import type { AuthNegotiator } from '@process/acp/session/AuthNegotiator';
import type { MessageTranslator } from '@process/acp/session/MessageTranslator';
import { PromptTimer } from '@process/acp/session/PromptTimer';
import type { SessionLifecycle } from '@process/acp/session/SessionLifecycle';
import type { AgentConfig, PromptContent, SessionCallbacks, SessionStatus } from '@process/acp/types';

/** Minimal interface that AcpSession exposes so PromptExecutor can drive state transitions. */
export type PromptHost = {
  readonly status: SessionStatus;
  readonly lifecycle: SessionLifecycle;
  readonly messageTranslator: MessageTranslator;
  readonly authNegotiator: AuthNegotiator;
  readonly callbacks: SessionCallbacks;
  readonly metrics: AcpMetrics;
  readonly agentConfig: AgentConfig;

  setStatus(status: SessionStatus): void;
  enterError(message: string): void;
};

export class PromptExecutor {
  private pendingPrompt: PromptContent | null = null;
  private readonly timer: PromptTimer;

  // ─── Retry state ─────────────────────────────────────────────
  private readonly maxPromptRetries: number;
  /** The prompt currently being executed (preserved for crash recovery via inflightContent). */
  private currentContent: PromptContent | null = null;
  private rejectRetrySleep: (() => void) | null = null;

  constructor(
    private readonly host: PromptHost,
    timeoutMs: number,
    maxPromptRetries = 2
  ) {
    this.timer = new PromptTimer(timeoutMs, () => this.handleTimeout());
    this.maxPromptRetries = maxPromptRetries;
  }

  /** The prompt currently being executed. Read by AcpSession.onDisconnect for crash recovery. */
  get inflightContent(): PromptContent | null {
    return this.currentContent;
  }

  // ─── Pending prompt buffer ────────────────────────────────────

  hasPending(): boolean {
    return this.pendingPrompt !== null;
  }

  setPending(content: PromptContent): void {
    this.pendingPrompt = content;
  }

  clearPending(): void {
    this.pendingPrompt = null;
  }

  /** Fire the pending prompt if one exists and session is active. */
  flush(): void {
    if (this.pendingPrompt && this.host.status === 'active') {
      const content = this.pendingPrompt;
      this.pendingPrompt = null;
      void this.execute(content);
    }
  }

  // ─── Execute ──────────────────────────────────────────────────

  async execute(content: PromptContent): Promise<void> {
    const { lifecycle } = this.host;
    if (!lifecycle.client || !lifecycle.sessionId) return;

    this.host.setStatus('prompting');
    this.currentContent = content;

    try {
      await lifecycle.reassertConfig();
    } catch {
      /* best effort — continue to prompt even if config sync fails */
    }

    let attempt = 0;
    let lastRetryError: AcpError | undefined;

    while (true) {
      if (attempt > 0) {
        const delay = this.computeRetryDelay(attempt, lastRetryError!);
        this.host.callbacks.onSignal({
          type: 'retrying',
          attempt,
          max: this.maxPromptRetries,
          reason: lastRetryError!.message,
        });
        try {
          // eslint-disable-next-line no-await-in-loop
          await this.sleepForRetry(delay);
        } catch {
          // Cancelled during retry wait (e.g. user cancelled the prompt)
          this.currentContent = null;
          return;
        }
        // Bail if state changed while sleeping (cancelled, disconnected, etc.)
        if (this.host.status !== 'prompting') {
          this.currentContent = null;
          return;
        }
        if (!lifecycle.client || !lifecycle.sessionId) {
          // Process disconnected during retry wait — reconnect path handles replay
          return;
        }
      }

      try {
        this.timer.start();
        // eslint-disable-next-line no-await-in-loop
        const result = await lifecycle.client.prompt(lifecycle.sessionId, content);
        this.timer.stop();

        // Compatibility fallback for @agentclientprotocol/claude-agent-acp >= 0.37:
        // In some environments Claude Code writes the assistant turn to its JSONL transcript
        // but emits no agent_message_chunk notifications over ACP, leaving AionUi with a
        // completed turn and an empty UI response. If this turn produced no translated
        // messages, recover the latest assistant text from Claude's transcript and emit it.
        this.emitClaudeTranscriptFallbackIfNeeded();

        // Fallback: emit usage from PromptResponse for backends that don't send usage_update
        if (result.usage) {
          this.host.callbacks.onContextUsage({
            used: result.usage.totalTokens,
            total: 0,
            percentage: 0,
          });
        }
      } catch (err) {
        this.timer.stop();
        this.host.messageTranslator.onTurnEnd();

        const acpErr = normalizeError(err);
        const isDisconnect = acpErr.code === 'PROCESS_CRASHED';
        const shouldRetry =
          acpErr.retryable && acpErr.code !== 'AUTH_REQUIRED' && !isDisconnect && attempt < this.maxPromptRetries;

        if (shouldRetry) {
          lastRetryError = acpErr;
          this.host.metrics.recordError(this.host.agentConfig.agentBackend, acpErr.code);
          console.warn(
            `[PromptExecutor] prompt error (${acpErr.code}), retry ${attempt + 1}/${this.maxPromptRetries}: ${acpErr.message}`
          );
          attempt++;
          continue;
        }

        // For process crashes: keep currentContent so AcpSession.onDisconnect can
        // save it as pending before triggering reconnect.
        if (!isDisconnect) {
          this.currentContent = null;
        }
        this.handlePromptError(err, content);
        return;
      }

      // Success
      this.host.messageTranslator.onTurnEnd();
      this.host.setStatus('active');
      this.host.callbacks.onSignal({ type: 'turn_finished' });
      this.currentContent = null;
      return;
    }
  }

  private computeRetryDelay(attempt: number, error: AcpError): number {
    const baseMs = error.retryDelayMs ?? 1_000;
    return Math.min(baseMs * Math.pow(2, attempt - 1), 30_000);
  }

  private sleepForRetry(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.rejectRetrySleep = reject;
      setTimeout(() => {
        this.rejectRetrySleep = null;
        resolve();
      }, ms);
    });
  }

  private emitClaudeTranscriptFallbackIfNeeded(): void {
    if (this.host.agentConfig.agentBackend !== 'claude') return;
    if (this.host.messageTranslator.activeEntryCount > 0) return;
    const sessionId = this.host.lifecycle.sessionId;
    if (!sessionId) return;

    try {
      const transcriptPath = this.findClaudeTranscriptPath(sessionId);
      if (!transcriptPath) {
        console.warn(`[PromptExecutor] Claude transcript fallback: transcript not found for session ${sessionId}`);
        return;
      }

      const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/).toReversed();
      for (const line of lines) {
        if (!line.trim()) continue;
        let row: any;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row?.type !== 'assistant' || row?.message?.role !== 'assistant') continue;
        const content = row.message.content;
        const text = Array.isArray(content)
          ? content
              .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
              .map((item: any) => item.text)
              .join('')
          : typeof content === 'string'
            ? content
            : '';
        if (!text.trim()) continue;

        const msgId = crypto.randomUUID();
        this.host.callbacks.onMessage({
          id: msgId,
          msg_id: msgId,
          conversation_id: this.host.messageTranslator.conversationIdForFallback,
          type: 'text',
          content: { content: text },
          position: 'left',
          status: 'finish',
        } as any);
        console.warn('[PromptExecutor] Recovered Claude assistant text from transcript fallback');
        return;
      }
    } catch (err) {
      console.warn('[PromptExecutor] Claude transcript fallback failed:', err);
    }
  }

  private findClaudeTranscriptPath(sessionId: string): string | null {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const target = `${sessionId}.jsonl`;
    if (!fs.existsSync(root)) return null;

    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name === target) {
          return fullPath;
        }
      }
    }
    return null;
  }

  private handlePromptError(err: unknown, content: PromptContent): void {
    const acpErr = normalizeError(err);

    if (acpErr.code === 'AUTH_REQUIRED') {
      this.pendingPrompt = content;
      this.host.lifecycle.setAuthPendingForPrompt();
      void this.host.lifecycle.teardown().then(() => {
        this.host.setStatus('error');
        this.host.callbacks.onSignal({
          type: 'auth_required',
          auth: this.host.authNegotiator.buildAuthRequiredData(undefined),
        });
      });
      return;
    }

    console.error(`[PromptExecutor] prompt failed (${acpErr.code}):`, acpErr.message);
    this.host.metrics.recordError(this.host.agentConfig.agentBackend, acpErr.code);

    if (acpErr.retryable) {
      this.host.setStatus('active');
      this.host.callbacks.onSignal({ type: 'error', message: acpErr.message, recoverable: true });
    } else {
      this.host.enterError(acpErr.message);
    }

    // Re-throw so callers (AcpSession.sendMessage → AcpAgentV2.sendMessage) can
    // return structured error types to AcpAgentManager.
    throw acpErr;
  }

  // ─── Cancel ───────────────────────────────────────────────────

  cancel(): void {
    // Abort any pending retry sleep immediately
    if (this.rejectRetrySleep) {
      this.rejectRetrySleep();
      this.rejectRetrySleep = null;
    }
    const { lifecycle } = this.host;
    if (this.host.status !== 'prompting' || !lifecycle.client || !lifecycle.sessionId) return;
    lifecycle.client.cancel(lifecycle.sessionId).catch(() => {});
  }

  cancelAll(): void {
    this.pendingPrompt = null;
    if (this.rejectRetrySleep) {
      this.rejectRetrySleep();
      this.rejectRetrySleep = null;
    }
    if (this.host.status === 'prompting') this.cancel();
  }

  // ─── Timer delegation (for permission pause/resume) ───────────

  pauseTimer(): void {
    this.timer.pause();
  }

  resumeTimer(): void {
    this.timer.resume();
  }

  resetTimer(): void {
    this.timer.reset();
  }

  stopTimer(): void {
    this.timer.stop();
  }

  private handleTimeout(): void {
    if (this.host.status !== 'prompting') return;
    this.cancel();
    this.host.callbacks.onSignal({
      type: 'error',
      message: 'Prompt timed out',
      recoverable: true,
    });
  }
}

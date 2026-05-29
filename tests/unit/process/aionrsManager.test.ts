import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn(async () => {}));
const mockStart = vi.hoisted(() => vi.fn(async () => {}));
const mockSetConfig = vi.hoisted(() => vi.fn());
const mockAddMessage = vi.hoisted(() => vi.fn());
const mockUpdateConversation = vi.hoisted(() => vi.fn());

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { responseStream: { emit: vi.fn() } },
  },
}));

vi.mock('@process/agent/aionrs', () => ({
  AionrsAgent: vi.fn().mockImplementation(function () {
    return {
      start: mockStart,
      send: mockSend,
      setConfig: mockSetConfig,
      stop: vi.fn(),
      kill: vi.fn(),
      capabilities: null,
      isAlive: true,
    };
  }),
}));

vi.mock('@process/services/database', () => ({
  getDatabase: vi.fn(async () => ({
    getConversationMessages: vi.fn(() => ({ success: true, data: [] })),
    getConversation: vi.fn(() => ({ success: true, data: { type: 'aionrs', extra: {} } })),
    updateConversation: mockUpdateConversation,
  })),
}));

vi.mock('@process/utils/message', () => ({
  addMessage: mockAddMessage,
  addOrUpdateMessage: vi.fn(),
}));

vi.mock('@process/utils/mainLogger', () => ({
  mainError: vi.fn(),
  mainLog: vi.fn(),
  mainWarn: vi.fn(),
}));

vi.mock('@process/services/cron/CronBusyGuard', () => ({
  cronBusyGuard: { setProcessing: vi.fn() },
}));

vi.mock('@process/services/cron/SkillSuggestWatcher', () => ({
  skillSuggestWatcher: { onFinish: vi.fn() },
}));

vi.mock('@process/task/ConversationTurnCompletionService', () => ({
  ConversationTurnCompletionService: {
    getInstance: () => ({ notifyPotentialCompletion: vi.fn() }),
  },
}));

vi.mock('@process/task/MessageMiddleware', () => ({
  processCronInMessage: vi.fn(),
}));

vi.mock('@process/task/CronCommandDetector', () => ({
  hasCronCommands: vi.fn(() => false),
}));

vi.mock('@process/team/teamEventBus', () => ({
  teamEventBus: { emit: vi.fn() },
}));

vi.mock('@process/channels/agent/ChannelEventBus', () => ({
  channelEventBus: { emitAgentMessage: vi.fn() },
}));

vi.mock('@/common/utils', () => ({
  uuid: vi.fn(() => 'uuid'),
}));

vi.mock('@/common/chat/chatLib', () => ({
  transformMessage: vi.fn(() => null),
}));

vi.mock('@process/agent/gemini/cli/tools/tools', () => ({
  ToolConfirmationOutcome: {
    ProceedAlways: 'always',
    ProceedOnce: 'once',
    Cancel: 'cancel',
  },
}));

import { AionrsManager } from '@process/task/AionrsManager';
import type { TProviderWithModel } from '@/common/config/storage';

const model = {
  id: 'provider-1',
  name: 'Provider',
  platform: 'custom',
  baseUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  model: ['test-model'],
  useModel: 'test-model',
} as TProviderWithModel;

describe('AionrsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not persist synthetic team prompts when sent silently', async () => {
    const manager = new AionrsManager(
      {
        workspace: '/tmp',
        conversation_id: 'conv-1',
        teamMcpStdioConfig: { name: 'team', command: 'node', args: [], env: [] },
      },
      model
    );

    await manager.sendMessage({ content: '# Team Leader prompt', msg_id: 'msg-1', silent: true });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateConversation).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith('# Team Leader prompt', 'msg-1', undefined);
  });

  it('persists normal user messages before sending', async () => {
    const manager = new AionrsManager({ workspace: '/tmp', conversation_id: 'conv-1' }, model);

    await manager.sendMessage({ content: 'hello', msg_id: 'msg-2' });

    expect(mockAddMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        id: 'msg-2',
        position: 'right',
        content: { content: 'hello' },
      })
    );
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {});
    expect(mockSend).toHaveBeenCalledWith('hello', 'msg-2', undefined);
  });

  it('rejects sends when the agent fails to start', async () => {
    mockStart.mockRejectedValueOnce(new Error('startup failed'));
    const manager = new AionrsManager({ workspace: '/tmp', conversation_id: 'conv-1' }, model);

    await expect(manager.sendMessage({ content: 'hello', msg_id: 'msg-3' })).rejects.toThrow('startup failed');
  });

  it('applies model switches to the running aionrs process', async () => {
    const manager = new AionrsManager({ workspace: '/tmp', conversation_id: 'conv-1' }, model);
    await manager.sendMessage({ content: 'ready', msg_id: 'msg-4', silent: true });

    manager.setModel({ ...model, useModel: 'next-model' });

    expect(mockSetConfig).toHaveBeenCalledWith({ model: 'next-model' });
  });
});

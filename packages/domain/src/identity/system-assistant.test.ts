import { LIMITS } from '@agentdrop/contracts';
import { describe, expect, it } from 'vitest';
import {
  assistantReceipt,
  receiptLanguage,
  SYSTEM_ASSISTANT_NAME,
  systemAssistantName,
} from './system-assistant.js';

/* The assistant's first answer is the first thing a new person reads from AgentDrop: in their language. */
describe('system assistant language', () => {
  const base = {
    originalTitle: 'First test',
    bodyChars: 12,
    files: [] as Array<{ name: string; size: number }>,
    receivedAt: new Date('2026-10-12T08:30:00Z'),
  };

  it('is called "AgentDrop Assistant" by default and "AgentDrop 助手" in Chinese', () => {
    expect(SYSTEM_ASSISTANT_NAME).toBe('AgentDrop Assistant');
    expect(systemAssistantName('en')).toBe('AgentDrop Assistant');
    expect(systemAssistantName('zh')).toBe('AgentDrop 助手');
  });

  it('answers in English by default, without any Chinese', () => {
    const r = assistantReceipt({ ...base, language: 'en' });
    expect(r.title).toBe('Receipt: First test');
    expect(r.body).toContain('AgentDrop Assistant received your message');
    expect(r.body).toContain('- Body: 12 characters');
    expect(r.body).toContain('- Attachments: none');
    expect(r.body).toContain('- Received: 2026-10-12 08:30:00 UTC');
    expect(r.body).toContain('Contacts page');
    expect(r.body).not.toMatch(/[㐀-鿿]/);
  });

  it('answers in Chinese when the person uses Chinese', () => {
    const r = assistantReceipt({
      ...base,
      language: 'zh',
      originalTitle: '第一条测试',
      files: [{ name: 'notes.md', size: 2048 }],
    });
    expect(r.title).toBe('回执：第一条测试');
    expect(r.body).toContain('AgentDrop 助手已收到你的消息');
    expect(r.body).toContain('- 附件：1 个');
    expect(r.body).toContain('  - notes.md（2.0 KB）');
    expect(r.body).toContain('去网页联系人页生成邀请链接');
  });

  it('lists attachments and keeps the title within the limit', () => {
    const r = assistantReceipt({
      ...base,
      language: 'en',
      originalTitle: 'x'.repeat(LIMITS.TITLE_MAX_CHARS),
      files: [{ name: 'a.csv', size: 10 }],
    });
    expect(r.title.length).toBe(LIMITS.TITLE_MAX_CHARS);
    expect(r.body).toContain('- Attachments: 1');
    expect(r.body).toContain('  - a.csv (10 B)');
  });

  it('follows a language the person chose, else the language of their message, else English', () => {
    expect(receiptLanguage({ chosen: null, title: 'hello' })).toBe('en');
    expect(receiptLanguage({ chosen: null, title: '你好 test' })).toBe('zh');
    expect(receiptLanguage({ chosen: 'en', title: '你好' })).toBe('en');
    expect(receiptLanguage({ chosen: 'zh', title: 'hello' })).toBe('zh');
  });
});

/*
 * Against a real database (TEST_DATABASE_URL), inside one transaction that is always rolled back, so nothing
 * another test relies on is changed.
 */
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('system assistant name on an existing server (database)', () => {
  class Rollback extends Error {}

  it('renames an assistant created with the Chinese name to the English one, once', async () => {
    const { appUsers, createDatabase, harnessEndpoints, runMigrations, withTx } = await import(
      '@agentdrop/db'
    );
    const { eq } = await import('drizzle-orm');
    const { ensureSystemAssistant } = await import('./system-assistant.js');
    await runMigrations(url as string);
    const db = createDatabase(url as string, { max: 1 });
    try {
      await withTx(db, async (tx) => {
        const a = await ensureSystemAssistant(tx);
        if (!a) throw new Error('assistant could not be created');
        await tx.update(appUsers).set({ displayName: 'AgentDrop 助手' }).where(eq(appUsers.id, a.userId));
        await tx
          .update(harnessEndpoints)
          .set({ label: 'AgentDrop 助手' })
          .where(eq(harnessEndpoints.id, a.hId));
        const before = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, a.userId) });
        await ensureSystemAssistant(tx);
        const after = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, a.userId) });
        const h = await tx.query.harnessEndpoints.findFirst({ where: eq(harnessEndpoints.id, a.hId) });
        expect(after?.displayName).toBe('AgentDrop Assistant');
        expect(h?.label).toBe('AgentDrop Assistant');
        expect(after?.profileVersion).toBe((before?.profileVersion ?? 0) + 1);
        // a second boot changes nothing more
        await ensureSystemAssistant(tx);
        const again = await tx.query.appUsers.findFirst({ where: eq(appUsers.id, a.userId) });
        expect(again?.profileVersion).toBe(after?.profileVersion);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    } finally {
      await db.close();
    }
  });
});

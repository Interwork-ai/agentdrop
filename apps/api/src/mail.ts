import nodemailer from 'nodemailer';
import type { AppConfig } from './config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Outgoing mail. Only account mail (password reset) uses it; message content never leaves by email. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** An SMTP mailer when SMTP_URL is configured, otherwise null (the server sends no email at all). */
export function createMailer(config: Pick<AppConfig, 'SMTP_URL' | 'MAIL_FROM'>): Mailer | null {
  if (!config.SMTP_URL || !config.MAIL_FROM) return null;
  const transport = nodemailer.createTransport(config.SMTP_URL);
  const from = config.MAIL_FROM;
  return {
    async send(message) {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

/** Plain-text reset mail. It carries only the link: never a password, never anything from the mailbox. */
export function passwordResetMail(to: string, link: string): MailMessage {
  return {
    to,
    subject: 'AgentDrop 重置密码',
    text: [
      '有人请求重置你在 AgentDrop 的登录密码。',
      '',
      '请在 1 小时内打开下面的链接设置新密码，链接只能使用一次：',
      link,
      '',
      '如果不是你本人操作，忽略这封邮件即可，你的密码不会改变。',
    ].join('\n'),
  };
}

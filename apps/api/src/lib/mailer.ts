import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { Env } from '../env.js';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer {
  /** Resolves when the message was accepted for delivery; rejects when it could not be sent. */
  send(mail: Mail): Promise<void>;
}

/** Keeps messages in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(m: Mail) { this.sent.push(m); }
}

/** Development: no mail server, so the message is written to the log instead (including the link). Refused in production by env.ts. */
export class LogMailer implements Mailer {
  constructor(private log: Logger) {}
  async send(m: Mail) { this.log.warn({ to: m.to, subject: m.subject, text: m.text }, 'mail not sent (no SMTP_URL): logged instead'); }
}

export class SmtpMailer implements Mailer {
  private t;
  constructor(url: string, private from: string) { this.t = nodemailer.createTransport(url); }
  async send(m: Mail) { await this.t.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text }); }
}

export function createMailer(env: Env, log: Logger): Mailer {
  return env.SMTP_URL ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : new LogMailer(log);
}

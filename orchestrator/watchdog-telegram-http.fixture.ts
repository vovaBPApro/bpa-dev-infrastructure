#!/usr/bin/env bun
import { appendFile, readFile } from 'node:fs/promises';

const [recordFile, modeFile] = Bun.argv.slice(2);
if (!recordFile || !modeFile) throw new Error('usage: fixture <record-file> <mode-file>');

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') body = await request.json() as Record<string, unknown>;
    await appendFile(recordFile, `${JSON.stringify({ path, body })}\n`);
    const rejecting = (await readFile(modeFile, 'utf8').catch(() => 'success')).trim() === 'reject';
    if (path.endsWith('/sendMessage') && rejecting) {
      return Response.json({ ok: false, error_code: 503, description: 'fixture reject' }, { status: 503 });
    }
    if (path.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 123456, is_bot: true, first_name: 'fixture', username: 'fixture_bot' } });
    if (path.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
    if (path.endsWith('/sendMessage')) return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text } });
    return Response.json({ ok: true, result: true });
  },
});
console.log(server.port);

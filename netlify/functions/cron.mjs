import { runCron } from './api.mjs';

// Запускается Netlify автоматически раз в 10 минут: контроль скорости ответа и автоворонки.
export default async () => new Response(JSON.stringify(await runCron()), { headers: { 'Content-Type': 'application/json' } });
export const config = { schedule: '*/10 * * * *' };

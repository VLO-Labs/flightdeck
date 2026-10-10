// Thin typed client for the Flightdeck API. Responses are parsed with the shared contracts.
import { z } from 'zod';
import { Chat, Project, Rule, type Decision, type NewRule } from '../shared/contracts.ts';

async function call<T>(schema: z.ZodType<T>, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `${res.status}`);
  return schema.parse(json);
}
const Ok = z.object({ ok: z.boolean() });

export const api = {
  projects: () => call(z.array(Project), 'GET', '/api/projects'),
  addProject: (name: string, path: string) => call(Project, 'POST', '/api/projects', { name, path }),
  chats: (projectId: number) => call(z.array(Chat), 'GET', `/api/projects/${projectId}/chats`),
  newChat: (projectId: number) => call(Chat, 'POST', `/api/projects/${projectId}/chats`),
  send: (chatId: number, text: string) => call(Ok, 'POST', `/api/chats/${chatId}/messages`, { text }),
  stop: (chatId: number) => call(Ok, 'POST', `/api/chats/${chatId}/stop`),
  setModel: (chatId: number, model: string) => call(Ok, 'POST', `/api/chats/${chatId}/model`, { model }),
  decide: (approvalId: number, d: Decision) => call(Ok, 'POST', `/api/approvals/${approvalId}`, d),
  rules: (projectId: number) => call(z.array(Rule), 'GET', `/api/projects/${projectId}/rules`),
  addRule: (projectId: number, r: NewRule) => call(Rule, 'POST', `/api/projects/${projectId}/rules`, r),
  deleteRule: (projectId: number, ruleId: number) => call(Ok, 'DELETE', `/api/projects/${projectId}/rules/${ruleId}`),
};

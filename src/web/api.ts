// Thin typed client for the Flightdeck API. Responses are parsed with the shared contracts.
import { z } from 'zod';
import { BrowseResponse, Chat, FileResponse, MapResponse, PlanResponse, ProcessGroup, Project, Rule, type Decision, type MapViewId, type Mode, type NewRule } from '../shared/contracts.ts';

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
  browse: (path?: string) => call(BrowseResponse, 'GET', `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  addProject: (name: string, path: string) => call(Project, 'POST', '/api/projects', { name, path }),
  createProject: (body: { name: string; path: string; stack: string; description?: string }) =>
    call(z.object({ project: Project, chatId: z.number(), error: z.string().optional() }), 'POST', '/api/projects/new', body),
  chats: (projectId: number) => call(z.array(Chat), 'GET', `/api/projects/${projectId}/chats`),
  newChat: (projectId: number) => call(Chat, 'POST', `/api/projects/${projectId}/chats`),
  send: (chatId: number, text: string, context?: { view: string; nodeId: string }[]) =>
    call(Ok, 'POST', `/api/chats/${chatId}/messages`, { text, context: context?.length ? context : undefined }),
  stop: (chatId: number) => call(Ok, 'POST', `/api/chats/${chatId}/stop`),
  chatSettings: (chatId: number, body: { mode?: Mode; discussModel?: string | null; buildModel?: string | null }) =>
    call(Chat, 'POST', `/api/chats/${chatId}/settings`, body),
  projectSettings: (projectId: number, body: { discussModel: string; buildModel: string; mapsRepo?: string | null }) =>
    call(Project, 'POST', `/api/projects/${projectId}/settings`, body),
  decide: (approvalId: number, d: Decision) => call(Ok, 'POST', `/api/approvals/${approvalId}`, d),
  map: (projectId: number, view: MapViewId) => call(MapResponse, 'GET', `/api/projects/${projectId}/maps/${view}`),
  generateMap: (projectId: number, view: MapViewId) => call(Ok, 'POST', `/api/projects/${projectId}/maps/${view}/generate`),
  stopMap: (projectId: number) => call(Ok, 'POST', `/api/projects/${projectId}/maps/stop`),
  file: (projectId: number, path: string) => call(FileResponse, 'GET', `/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`),
  plan: (chatId: number, versionId?: number) =>
    call(PlanResponse, 'GET', `/api/chats/${chatId}/plan${versionId ? `?version=${versionId}` : ''}`),
  approvePlan: (chatId: number, versionId: number) => call(PlanResponse, 'POST', `/api/chats/${chatId}/plan/approve`, { versionId }),
  revalidatePlan: (chatId: number, versionId: number) => call(PlanResponse, 'POST', `/api/chats/${chatId}/plan/revalidate`, { versionId }),
  checkPlan: (chatId: number) => call(PlanResponse, 'POST', `/api/chats/${chatId}/plan/check`),
  dropPlan: (chatId: number) => call(PlanResponse, 'POST', `/api/chats/${chatId}/plan/drop`),
  processes: (projectId: number) => call(z.array(ProcessGroup), 'GET', `/api/projects/${projectId}/processes`),
  stopProcess: (projectId: number, pid: number) => call(Ok, 'POST', `/api/projects/${projectId}/processes/${pid}/stop`),
  rules: (projectId: number) => call(z.array(Rule), 'GET', `/api/projects/${projectId}/rules`),
  addRule: (projectId: number, r: NewRule) => call(Rule, 'POST', `/api/projects/${projectId}/rules`, r),
  deleteRule: (projectId: number, ruleId: number) => call(Ok, 'DELETE', `/api/projects/${projectId}/rules/${ruleId}`),
};

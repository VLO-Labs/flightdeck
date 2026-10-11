// Where the app is, as a URL, so a reload (or a shared link) returns to the same place:
//   /p/6                                  a project, nothing open
//   /p/6/map/architecture?at=a/b&node=c   its map: view, drill-down path, selected node
//   /p/6/chats/12                         a chat
//   /p/6/settings                         project settings
import { MAP_VIEWS, type MapViewId } from '../shared/contracts.ts';

export type Route =
  | { projectId?: number; screen: 'none' }
  | { projectId: number; screen: 'map'; mapView: MapViewId; at: string[]; node: string | null }
  | { projectId: number; screen: 'chat'; chatId: number }
  | { projectId: number; screen: 'settings' };

const isView = (v: string): v is MapViewId => MAP_VIEWS.some(m => m.id === v);

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'p' || !/^\d+$/.test(parts[1] ?? '')) return { screen: 'none' };
  const projectId = Number(parts[1]);
  const q = new URLSearchParams(search);
  if (parts[2] === 'map') {
    const v = parts[3] ?? 'architecture';
    return {
      projectId, screen: 'map', mapView: isView(v) ? v : 'architecture',
      at: (q.get('at') ?? '').split('/').filter(Boolean), node: q.get('node') || null,
    };
  }
  if (parts[2] === 'chats' && /^\d+$/.test(parts[3] ?? '')) return { projectId, screen: 'chat', chatId: Number(parts[3]) };
  if (parts[2] === 'settings') return { projectId, screen: 'settings' };
  return { projectId, screen: 'none' };
}

export function formatRoute(r: Route): string {
  if (r.projectId === undefined) return '/';
  const base = `/p/${r.projectId}`;
  switch (r.screen) {
    case 'none': return base;
    case 'settings': return `${base}/settings`;
    case 'chat': return `${base}/chats/${r.chatId}`;
    case 'map': {
      const q = new URLSearchParams();
      if (r.at.length) q.set('at', r.at.join('/'));
      if (r.node) q.set('node', r.node);
      const qs = q.toString().replace(/%2F/g, '/');
      return `${base}/map/${r.mapView}${qs ? `?${qs}` : ''}`;
    }
  }
}

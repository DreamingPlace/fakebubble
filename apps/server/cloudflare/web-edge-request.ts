import { ensure } from '../../../packages/domain/errors.ts';

export const WEB_EDGE_PEER_HEADER = 'x-internal-web-peer';
/** Only a private DO Fetch binding may call this boundary, never a public Worker handler.
 * The sole public edge strips all caller-supplied internal headers before setting this one.
 */
export function trustedWebRequest(request: Request) {
  const peer = request.headers.get(WEB_EDGE_PEER_HEADER);
  ensure(peer && peer.length <= 128 && /^[0-9a-fA-F:.]+$/.test(peer), 'WEB_EDGE_PEER_REQUIRED');
  const headers = new Headers(request.headers); headers.delete(WEB_EDGE_PEER_HEADER);
  return { request: new Request(request, { headers }), peer };
}

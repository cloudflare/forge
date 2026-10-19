// The Cloudflare API as an MCP server, over Streamable HTTP at /mcp. The
// caller authenticates with a Cloudflare API token as a bearer token, which
// every tool call forwards to the API.
import { createForgeMcpHandler, type Catalogue } from '../../src/index.ts';
import catalogue from '../generated/mcp-tools.json';

const mcp = createForgeMcpHandler({
  catalogue: catalogue as Catalogue,
  serverInfo: { name: 'cloudflare-api-forge-mcp', version: '0.1.0' },
  authorize(request) {
    const authorization = request.headers.get('Authorization');
    if (authorization?.startsWith('Bearer ')) {
      return { Authorization: authorization };
    }
    return new Response('Send a Cloudflare API token as a bearer token.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  },
});

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (new URL(request.url).pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }
    return mcp.fetch(request);
  },
};

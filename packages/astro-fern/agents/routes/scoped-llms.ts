import { getLlmsStaticPaths, renderLlmsPathnameResponse, renderLlmsResponse } from 'astro-fern/server';

export const getStaticPaths = getLlmsStaticPaths;

export function GET({ props, url }: { props: { agentRouteId?: string }; url: URL }): Promise<Response> {
  return props.agentRouteId ? renderLlmsResponse(props.agentRouteId) : renderLlmsPathnameResponse(url.pathname);
}

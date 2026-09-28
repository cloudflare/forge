import { renderLlmsResponse } from 'astro-fern/server';

export function GET(): Promise<Response> {
  return renderLlmsResponse('llms:site');
}

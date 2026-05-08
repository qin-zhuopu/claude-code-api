export interface Options {
  abortController?: AbortController;
  [key: string]: any;
}

export interface SDKMessage {
  type: string;
  content?: any;
  name?: string;
  input?: any;
}

export class Query implements AsyncIterable<SDKMessage> {
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    yield { type: 'text', content: [{ text: 'Mock response' }] };
  }

  async interrupt(): Promise<void> {
    // Mock interrupt
  }
}

export function query(config: { prompt: string; options?: Options }): Query {
  return new Query();
}

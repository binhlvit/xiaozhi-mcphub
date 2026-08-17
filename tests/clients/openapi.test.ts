const mockUserDao = {
  findByUsername: jest.fn(),
};

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => mockUserDao,
}));

const mockDnsLookup = jest.fn();
jest.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
}));

import { OpenAPIClient } from '../../src/clients/openapi.js';
import type { ServerConfig } from '../../src/types/index.js';

describe('OpenAPIClient SSRF/LFI guard', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserDao.findByUsername.mockResolvedValue({ isAdmin: false });
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 599,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('rejects an internal/loopback openapi.url for a non-admin owner without ever making a network request', async () => {
    const config: ServerConfig = {
      type: 'openapi',
      owner: 'regular-user',
      openapi: {
        url: 'http://127.0.0.1:1/openapi.json',
        version: '3.1.0',
        security: { type: 'none' },
      },
    };

    await expect(new OpenAPIClient(config).initialize()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to an internal IP (DNS-rebinding) without making a network request — the library's own string blocklist alone would miss this", async () => {
    // Doesn't match any literal "127.0.0.1"/"localhost"/RFC1918-prefix string,
    // so swagger-parser's own lexical safeUrlResolver would have let it through —
    // only a real DNS-resolving check (assertSafeUrl) catches this.
    mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const config: ServerConfig = {
      type: 'openapi',
      owner: 'regular-user',
      openapi: {
        url: 'http://rebind.example.com:1/openapi.json',
        version: '3.1.0',
        security: { type: 'none' },
      },
    };

    await expect(new OpenAPIClient(config).initialize()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDnsLookup).toHaveBeenCalledWith('rebind.example.com', { all: true });
  });

  it('does not resolve a local filesystem $ref embedded in a user-supplied schema', async () => {
    const config: ServerConfig = {
      type: 'openapi',
      owner: 'regular-user',
      openapi: {
        schema: {
          openapi: '3.0.0',
          info: { title: 'evil', version: '1.0.0' },
          paths: {
            '/x': {
              get: {
                operationId: 'x',
                parameters: [{ name: 'leak', in: 'query', schema: { $ref: 'package.json' } }],
                responses: { 200: { description: 'ok' } },
              },
            },
          },
        } as any,
        version: '3.1.0',
        security: { type: 'none' },
      },
    };

    await expect(new OpenAPIClient(config).initialize()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets an admin-owned server reach an internal openapi.url (allowInternal bypass actually takes effect)', async () => {
    mockUserDao.findByUsername.mockResolvedValue({ isAdmin: true });
    const config: ServerConfig = {
      type: 'openapi',
      owner: 'admin',
      openapi: {
        url: 'http://127.0.0.1:1/openapi.json',
        version: '3.1.0',
        security: { type: 'none' },
      },
    };

    // Outcome of initialize() itself doesn't matter here (the mocked response
    // isn't a valid spec) — what matters is that the block was bypassed and a
    // real network request was attempted, proving allowInternal took effect.
    await new OpenAPIClient(config).initialize().catch(() => {});
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:1/openapi.json',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });
});

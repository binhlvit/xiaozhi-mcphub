jest.mock('../../src/services/oauthService.js', () => ({
  initializeAllOAuthClients: jest.fn(),
}));

jest.mock('../../src/services/mcpOAuthProvider.js', () => ({
  createOAuthProvider: jest.fn(),
}));

jest.mock('../../src/services/sseService.js', () => ({
  getGroup: jest.fn(() => ''),
}));

jest.mock('../../src/services/groupService.js', () => ({
  getServersInGroup: jest.fn(),
  getServerConfigInGroup: jest.fn(),
}));

jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
}));

jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: jest.fn(() => ({
    logToolCall: jest.fn(),
  })),
}));

jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: jest.fn(),
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: jest.fn(),
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: jest.fn(() => false),
}));

jest.mock('../../src/services/services.js', () => ({
  getDataService: jest.fn(() => ({
    filterData: (data: any) => data,
  })),
}));

jest.mock('../../src/dao/index.js', () => ({
  getServerDao: jest.fn(() => ({ findById: jest.fn() })),
  getSystemConfigDao: jest.fn(() => ({ get: jest.fn() })),
  getBuiltinPromptDao: jest.fn(() => ({ findEnabled: jest.fn() })),
  getBuiltinResourceDao: jest.fn(() => ({ findEnabled: jest.fn() })),
}));

jest.mock('../../src/config/index.js', () => ({
  expandEnvVars: jest.fn((val: string) => val),
  replaceEnvVars: jest.fn((val: any) => val),
  getNameSeparator: jest.fn(() => '::'),
  default: {
    mcpHubName: 'test-hub',
    mcpHubVersion: '1.0.0',
    initTimeout: 60000,
  },
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateProxychainsConfig } from '../../src/services/mcpService.js';

describe('generateProxychainsConfig', () => {
  const serverName = 'proxy-injection-test';
  const configPath = path.join(os.tmpdir(), 'mcphub-proxychains', `${serverName}.conf`);

  afterEach(() => {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  it('refuses to write a config when host contains a newline (directive injection)', () => {
    const result = generateProxychainsConfig(serverName, {
      enabled: true,
      host: 'proxy.example.com\n[ProxyList]\nsocks5 attacker.example.com 1080',
      port: 1080,
    });

    expect(result).toBeNull();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('refuses to write a config when username/password contain a newline', () => {
    const result = generateProxychainsConfig(serverName, {
      enabled: true,
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      password: 'pass\nlocalnet 0.0.0.0/0.0.0.0',
    });

    expect(result).toBeNull();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('writes exactly one ProxyList entry for a well-formed config', () => {
    const result = generateProxychainsConfig(serverName, {
      enabled: true,
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });

    expect(result).toBe(configPath);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content.match(/socks5 proxy\.example\.com 1080 user pass/g)).toHaveLength(1);
    expect(content.match(/\[ProxyList\]/g)).toHaveLength(1);
  });
});

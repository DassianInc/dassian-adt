import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeLive = hasLiveConfig() ? describe : describe.skip;

describeLive('SystemHandlers (live)', () => {
  let client: ADTClient;
  let handlers: TestHandlers;

  beforeAll(async () => {
    client = createClient();
    handlers = createHandlers(client);
  }, 15000);

  afterAll(async () => {
    try { await client.logout(); } catch (_) {}
  });

  it('healthcheck returns healthy', async () => {
    const result = parseResult(await handlers.system.validateAndHandle('healthcheck', {}));
    expect(result.status).toBe('success');
    expect(result.healthy).toBe(true);
  }, 15000);

  it('login returns loggedIn', async () => {
    const result = parseResult(await handlers.system.validateAndHandle('login', {}));
    expect(result.status).toBe('success');
    expect(result.loggedIn).toBe(true);
  }, 15000);

  it('abap_get_dump returns dumps array', async () => {
    // Use a specific query to limit results — unfiltered dumps can exceed XML parser limits
    // on systems with many short dumps (entity expansion limit 1000)
    const result = parseResult(await handlers.system.validateAndHandle('abap_get_dump', {
      query: 'ABAP_PROGRAM'
    }));
    expect(result.status).toBe('success');
    expect(Array.isArray(result.dumps)).toBe(true);
  }, 30000);
});

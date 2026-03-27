import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeLive = hasLiveConfig() ? describe : describe.skip;

describeLive('abap_get_source (live)', () => {
  let client: ADTClient;
  let handlers: TestHandlers;

  beforeAll(async () => {
    client = createClient();
    handlers = createHandlers(client);
    await client.login();
  }, 15000);

  afterAll(async () => {
    try { await client.logout(); } catch (_) {}
  });

  it('reads class source (CLAS)', async () => {
    const result = parseResult(await handlers.source.validateAndHandle('abap_get_source', {
      name: 'CL_ABAP_TYPEDESCR', type: 'CLAS'
    }));
    expect(result.status).toBe('success');
    expect(typeof result.source).toBe('string');
    expect(result.source.length).toBeGreaterThan(0);
  }, 15000);

  it('reads program source (PROG/P)', async () => {
    // RSABAPPROGRAM is a standard SAP report that exists on every system
    const result = parseResult(await handlers.source.validateAndHandle('abap_get_source', {
      name: 'RSABAPPROGRAM', type: 'PROG/P'
    }));
    expect(result.status).toBe('success');
    expect(typeof result.source).toBe('string');
  }, 15000);
});

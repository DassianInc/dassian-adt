import { ADTClient, session_types } from 'abap-adt-api';
import { SourceHandlers } from '../../handlers/SourceHandlers';
import { ObjectHandlers } from '../../handlers/ObjectHandlers';
import { RunHandlers } from '../../handlers/RunHandlers';
import { TransportHandlers } from '../../handlers/TransportHandlers';
import { DataHandlers } from '../../handlers/DataHandlers';
import { QualityHandlers } from '../../handlers/QualityHandlers';
import { GitHandlers } from '../../handlers/GitHandlers';
import { SystemHandlers } from '../../handlers/SystemHandlers';
import { DdicHandlers } from '../../handlers/DdicHandlers';

export interface TestHandlers {
  source: SourceHandlers;
  object: ObjectHandlers;
  run: RunHandlers;
  transport: TransportHandlers;
  data: DataHandlers;
  quality: QualityHandlers;
  git: GitHandlers;
  system: SystemHandlers;
  ddic: DdicHandlers;
}

export function hasLiveConfig(): boolean {
  return !!(process.env.SAP_URL && process.env.SAP_USER && process.env.SAP_PASSWORD);
}

export function createClient(): ADTClient {
  const client = new ADTClient(
    process.env.SAP_URL!,
    process.env.SAP_USER!,
    process.env.SAP_PASSWORD!,
    process.env.SAP_CLIENT || '',
    process.env.SAP_LANGUAGE || ''
  );
  client.stateful = session_types.stateful;
  return client;
}

export function createHandlers(client: ADTClient): TestHandlers {
  return {
    source: new SourceHandlers(client),
    object: new ObjectHandlers(client),
    run: new RunHandlers(client),
    transport: new TransportHandlers(client),
    data: new DataHandlers(client),
    quality: new QualityHandlers(client),
    git: new GitHandlers(client),
    system: new SystemHandlers(client),
    ddic: new DdicHandlers(client),
  };
}

/** Parse the JSON response from a handler's success() method. */
export function parseResult(result: any): any {
  if (result?.content?.[0]?.text) {
    return JSON.parse(result.content[0].text);
  }
  return result;
}

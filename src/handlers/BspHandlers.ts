import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';
import { parseQueryResponse } from 'abap-adt-api/build/api/tablecontents.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract relative file paths from a SAP ADT filestore XML response.
 * The endpoint returns either an APP::service doc (top-level collections) or
 * an Atom feed (entries with edit-link hrefs). We extract every href that
 * contains the filestore content path and reduce it to the relative portion.
 */
function parseBspFileList(xml: string, appName: string): string[] {
  const contentPrefix = `/sap/bc/adt/filestore/ui5-bsp/applications/${encodeURIComponent(appName)}/content/`;
  const paths: string[] = [];
  // Match all href="..." and rel="..." href patterns
  const hrefRe = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(xml)) !== null) {
    const href = m[1];
    if (href.startsWith(contentPrefix)) {
      paths.push(href.slice(contentPrefix.length));
    } else if (href.startsWith('content/')) {
      paths.push(href.slice('content/'.length));
    }
  }
  // Deduplicate
  return [...new Set(paths)].filter(p => p.length > 0);
}

const TEXT_EXTENSIONS = new Set([
  '.json', '.js', '.ts', '.xml', '.html', '.htm',
  '.css', '.txt', '.properties', '.yaml', '.yml', '.mjs'
]);

function isTextFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  return dot !== -1 && TEXT_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

// ── Handler ───────────────────────────────────────────────────────────────────

export class BspHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'bsp_read_file',
        annotations: { readOnlyHint: true },
        description:
          'Read a file from a BSP / UI5 application repository, or list all files in the application. ' +
          'Uses the SAP ADT filestore endpoint (/sap/bc/adt/filestore/ui5-bsp). ' +
          'Without file_path: returns a list of all files in the app. ' +
          'With file_path: returns the raw content of that file (e.g. webapp/manifest.json). ' +
          'Use this to read manifest.json for component IDs, OData service URIs, and dependency info.',
        inputSchema: {
          type: 'object',
          properties: {
            app_name: {
              type: 'string',
              description: 'BSP application name, e.g. Z_MY_APP or /UI5/TS_TEST_APP'
            },
            file_path: {
              type: 'string',
              description: 'Relative file path within the app, e.g. webapp/manifest.json or Component.js. ' +
                           'Omit to list all files in the application.'
            }
          },
          required: ['app_name']
        }
      },
      {
        name: 'bsp_search_content',
        annotations: { readOnlyHint: true },
        description:
          'Search for a string inside the text files of a BSP / UI5 application. ' +
          'Lists all files in the app, reads each text file (.json, .js, .xml, .html, .css, .properties, etc.), ' +
          'and returns the file paths that contain the search string. ' +
          'This is the primary way to find which BSP file contains a specific component ID, ' +
          'OData service name, or any other string — without needing to know the file name in advance.',
        inputSchema: {
          type: 'object',
          properties: {
            app_name: {
              type: 'string',
              description: 'BSP application name to search within, e.g. Z_MY_APP'
            },
            search_string: {
              type: 'string',
              description: 'Exact string to search for (case-sensitive)'
            },
            max_results: {
              type: 'number',
              description: 'Stop after finding this many matching files (default 20)'
            }
          },
          required: ['app_name', 'search_string']
        }
      },
      {
        name: 'ui5_app_index_lookup',
        annotations: { readOnlyHint: true },
        description:
          'Look up UI5 application metadata from the SAP UI5 Application Index (/UI5/APPIDX). ' +
          'The app index is maintained by /UI5/APP_INDEX_CALCULATE and stores parsed manifest.json ' +
          'metadata: component ID, BSP application name, libraries, last updated timestamp. ' +
          'Faster than reading manifest.json directly — use this to find which BSP app owns a component ID, ' +
          'or to enumerate all UI5 apps on the system.',
        inputSchema: {
          type: 'object',
          properties: {
            component_id: {
              type: 'string',
              description: 'UI5 component ID to look up, e.g. dassian.s4fd.app.FlowdownAttribute'
            },
            app_name: {
              type: 'string',
              description: 'BSP application name to look up, e.g. Z_MY_APP. Can combine with component_id.'
            }
          }
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'bsp_read_file':        return this.handleBspReadFile(args);
      case 'bsp_search_content':   return this.handleBspSearchContent(args);
      case 'ui5_app_index_lookup': return this.handleUi5AppIndex(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  // ── bsp_read_file ─────────────────────────────────────────────────────────

  private async handleBspReadFile(args: any): Promise<any> {
    const appName  = (args.app_name  || '').trim();
    const filePath = (args.file_path || '').trim();

    if (!appName) this.fail('bsp_read_file: app_name is required.');

    const h = (this.adtclient as any).h;
    if (!h) this.fail('bsp_read_file: underlying HTTP client not available.');

    try {
      if (filePath) {
        // Read specific file
        const cleanPath = filePath.replace(/^\/+/, '');
        const url = `/sap/bc/adt/filestore/ui5-bsp/applications/${encodeURIComponent(appName)}/content/${cleanPath}`;
        const response = await this.withSession(() =>
          h.request(url, { method: 'GET', headers: { Accept: '*/*' } })
        ) as any;
        return this.success({
          app_name:  appName,
          file_path: filePath,
          content:   (response.body ?? response.data ?? '').toString()
        });
      } else {
        // List files in app
        const url = `/sap/bc/adt/filestore/ui5-bsp/applications/${encodeURIComponent(appName)}`;
        const response = await this.withSession(() =>
          h.request(url, { method: 'GET', headers: { Accept: 'application/xml' } })
        ) as any;
        const body = (response.body ?? response.data ?? '').toString();
        const files = parseBspFileList(body, appName);
        return this.success({
          app_name:     appName,
          file_count:   files.length,
          files,
          // Return raw response if we couldn't parse any files — lets the caller see the format
          raw_response: files.length === 0 ? body : undefined
        });
      }
    } catch (error: any) {
      this.fail(formatError(`bsp_read_file(${appName}${filePath ? '/' + filePath : ''})`, error));
    }
  }

  // ── bsp_search_content ───────────────────────────────────────────────────

  private async handleBspSearchContent(args: any): Promise<any> {
    const appName      = (args.app_name      || '').trim();
    const searchString = (args.search_string || '').trim();
    const maxResults   = Math.min(args.max_results ?? 20, 100);

    if (!appName)      this.fail('bsp_search_content: app_name is required.');
    if (!searchString) this.fail('bsp_search_content: search_string is required.');

    const h = (this.adtclient as any).h;
    if (!h) this.fail('bsp_search_content: underlying HTTP client not available.');

    try {
      // Step 1: get file listing
      const listUrl  = `/sap/bc/adt/filestore/ui5-bsp/applications/${encodeURIComponent(appName)}`;
      const listResp = await this.withSession(() =>
        h.request(listUrl, { method: 'GET', headers: { Accept: 'application/xml' } })
      ) as any;
      const allFiles = parseBspFileList((listResp.body ?? listResp.data ?? '').toString(), appName);

      if (allFiles.length === 0) {
        return this.success({
          app_name:      appName,
          search_string: searchString,
          matches:       [],
          note: 'File listing returned no parseable entries. Try bsp_read_file with no file_path to inspect the raw listing response.'
        });
      }

      // Step 2: read each text file and search
      const textFiles = allFiles.filter(isTextFile);
      const matches: Array<{ file_path: string }> = [];
      let filesRead = 0;

      for (const filePath of textFiles) {
        if (matches.length >= maxResults) break;
        const cleanPath = filePath.replace(/^\/+/, '');
        const fileUrl   = `/sap/bc/adt/filestore/ui5-bsp/applications/${encodeURIComponent(appName)}/content/${cleanPath}`;
        try {
          const fileResp = await this.withSession(() =>
            h.request(fileUrl, { method: 'GET', headers: { Accept: '*/*' } })
          ) as any;
          filesRead++;
          const content = (fileResp.body ?? fileResp.data ?? '').toString();
          if (content.includes(searchString)) {
            matches.push({ file_path: filePath });
          }
        } catch (_) {
          // skip unreadable files
        }
      }

      return this.success({
        app_name:       appName,
        search_string:  searchString,
        files_scanned:  filesRead,
        total_files:    allFiles.length,
        text_files:     textFiles.length,
        matches
      });
    } catch (error: any) {
      this.fail(formatError(`bsp_search_content(${appName})`, error));
    }
  }

  // ── ui5_app_index_lookup ─────────────────────────────────────────────────

  private async handleUi5AppIndex(args: any): Promise<any> {
    const componentId = (args.component_id || '').trim().toUpperCase();
    const appName     = (args.app_name     || '').trim().toUpperCase();

    if (!componentId && !appName) {
      this.fail('ui5_app_index_lookup: provide at least one of component_id or app_name.');
    }

    try {
      const h = (this.adtclient as any).h;
      if (!h) this.fail('ui5_app_index_lookup: underlying HTTP client not available.');

      const conditions: string[] = [];
      if (componentId) conditions.push(`COMPONENT = '${componentId}'`);
      if (appName)     conditions.push(`BSP_APPLICATION = '${appName}'`);

      // /UI5/APPIDX is the standard SAP UI5 Application Index table.
      // Fields: COMPONENT, BSP_APPLICATION, NAMESPACE, LIBRARY_NAME, LAST_CHANGED, etc.
      const sql = `SELECT * FROM /UI5/APPIDX WHERE ${conditions.join(' AND ')}`;

      const result = await this.withSession(async () => {
        const response = await h.request('/sap/bc/adt/datapreview/freestyle', {
          qs: { rowNumber: 50 },
          headers: { Accept: 'application/*', 'Content-Type': 'text/plain' },
          method: 'POST',
          body: sql
        });
        return parseQueryResponse(response.body);
      });

      return this.success({ result });
    } catch (error: any) {
      this.fail(formatError('ui5_app_index_lookup', error));
    }
  }
}

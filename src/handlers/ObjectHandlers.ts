import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import type { InactiveObject } from 'abap-adt-api';
import { buildObjectUrl, buildPackageUrl, getSupportedTypes } from '../lib/urlBuilder.js';
import { formatError, parseAdtError, formatActivationMessages } from '../lib/errors.js';

const SUPPORTED = getSupportedTypes().join(', ');

export class ObjectHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'abap_create',
        description:
          'Create a new ABAP object. For temporary objects use package=$TMP — no transport needed. ' +
          'For permanent objects, provide both a named package and transport. ' +
          'After creation, write source with abap_set_source and activate with abap_activate. ' +
          'BDEF (behavior definition) is supported — activation order is DDLS → BDEF → behavior pool class.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name, e.g. ZCL_MY_CLASS or /DSN/MY_CLASS' },
            type: {
              type: 'string',
              description: `Object type. Common: CLAS/OC (class), PROG/P (program), PROG/I (include), FUGR/F (function group), DDLS/DF (CDS view), INTF/OI (interface), TABL/DT (table). Full list: ${SUPPORTED}`
            },
            package: { type: 'string', description: 'Package name, e.g. $TMP or /DSN/CORE. Also accepted as "devclass".' },
            devclass: { type: 'string', description: 'Alias for package.' },
            description: { type: 'string', description: 'Short description shown in ABAP Workbench' },
            transport: { type: 'string', description: 'Transport number. Required for non-$TMP packages.' },
            rowType: { type: 'string', description: 'For type=TTYP only: line type (a DDIC structure or data element), e.g. /DSN/BIL_S_RET_SHARE. Required for TTYP.' }
          },
          required: ['name', 'type', 'description']
        }
      },
      {
        name: 'abap_delete',
        annotations: { destructiveHint: true },
        description:
          'Delete an ABAP object. Locks the object, deletes it, and the lock is released implicitly by the delete. ' +
          'For objects in a transport, provide the transport number.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: `Object type. ${SUPPORTED}` },
            transport: { type: 'string', description: 'Transport number (required for non-$TMP objects)' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_activate',
        annotations: { idempotentHint: true },
        description:
          'Activate an ABAP object, making it the active version. ' +
          'Must be called after abap_set_source or abap_create. ' +
          'Returns success:true with empty messages if clean. ' +
          'Returns success:false with error messages if activation fails — read them, fix the source, and retry. ' +
          'For FUGR/FF (function modules): activation always targets the parent function group — provide fugr param.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: `Object type. ${SUPPORTED}` },
            fugr: { type: 'string', description: 'Parent function group name. Required when type=FUGR/FF, e.g. /DSN/010BWE.' }
          },
          required: ['name', 'type']
        }
      },
      {
        name: 'abap_search',
        annotations: { readOnlyHint: true },
        description:
          'Search for ABAP objects by name pattern. Returns object names, types, and ADT URLs. ' +
          'IMPORTANT: Only TRAILING wildcards work. Use "/DSN/BIL*" not "/DSN/*BIL*". ' +
          'Leading wildcards (*SOMETHING) and mid-name wildcards (/DSN/*FOO*BAR*) will fail. ' +
          'If you need to find an object by partial name, put the known prefix first: /DSN/BIL*.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search string. Only trailing wildcards (*) work. E.g. ZCL_MY_* or /DSN/BIL*. Leading wildcards like *BILL* will fail.' },
            type: { type: 'string', description: `Filter by object type. ${SUPPORTED}. Omit to search all types.` },
            max: { type: 'number', description: 'Max results (default 50)' }
          },
          required: ['query']
        }
      },
      {
        name: 'abap_activate_batch',
        annotations: { idempotentHint: true },
        description:
          'Activate multiple ABAP objects in a single ADT request. ' +
          'More efficient than calling abap_activate repeatedly for each object. ' +
          'Returns activated:true if all objects activated cleanly, or activated:false with error messages if any failed. ' +
          'Use this after writing source for several objects at once (e.g. after a set of transport_assign calls).',
        inputSchema: {
          type: 'object',
          properties: {
            objects: {
              type: 'array',
              description: 'List of objects to activate. Each item must be an object with "name" (e.g. /DSN/MY_CLASS) and "type" (e.g. CLAS, PROG/P, DDLS).'
            }
          },
          required: ['objects']
        }
      },
      {
        name: 'abap_object_info',
        annotations: { readOnlyHint: true },
        description:
          'Get metadata for an ABAP object: package, transport layer, active/inactive status, ' +
          'upgrade flag (upgradeFlag=true means object is in SPAU adjustment mode and cannot be edited via ADT), ' +
          'and structural information. Use this before attempting to edit an object you are unfamiliar with.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Object name' },
            type: { type: 'string', description: `Object type. ${SUPPORTED}` }
          },
          required: ['name', 'type']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_create':          return this.handleCreate(args);
      case 'abap_delete':          return this.handleDelete(args);
      case 'abap_activate':        return this.handleActivate(args);
      case 'abap_activate_batch':  return this.handleActivateBatch(args);
      case 'abap_search':          return this.handleSearch(args);
      case 'abap_object_info':     return this.handleObjectInfo(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
  }

  // The library's createObject expects full subtypes (CLAS/OC, PROG/P, etc.)
  // but AIs often send just the short form. Map them automatically.
  private static readonly CREATE_TYPE_MAP: Record<string, string> = {
    'CLAS': 'CLAS/OC', 'INTF': 'INTF/OI', 'PROG': 'PROG/P',
    'FUGR': 'FUGR/F', 'DDLS': 'DDLS/DF', 'DDLX': 'DDLX/EX',
    'TABL': 'TABL/DT', 'DTEL': 'DTEL/DE', 'DOMA': 'DOMA/DD',
    'DCLS': 'DCLS/DL', 'SRVD': 'SRVD/SRV', 'SRVB': 'SRVB/SVB',
    'ENHO': 'ENHO/XHH', 'DEVC': 'DEVC/K', 'MSAG': 'MSAG/N',
    'VIEW': 'VIEW/DV',
  };

  private async handleCreate(args: any): Promise<any> {
    // Accept devclass as alias for package (common SAP terminology)
    if (args.devclass && !args.package) args.package = args.devclass;
    if (!args.package) {
      // Elicit the package from the user instead of just failing
      const input = await this.elicitForm(
        `abap_create(${args.name}): Which package should this object be created in?`,
        {
          package: {
            type: 'string',
            title: 'Package',
            description: 'Package name. Use $TMP for temporary/test objects, or a real package like /DSN/CORE for permanent objects.',
            default: '$TMP'
          }
        },
        ['package']
      );
      if (input?.package) {
        args.package = input.package;
      } else {
        this.fail('abap_create: package is required (e.g. $TMP or /DSN/MYPACKAGE). Also accepted as "devclass".');
      }
    }
    // Map short types to full subtypes (CLAS → CLAS/OC, PROG → PROG/P, etc.)
    const typeKey = args.type?.toUpperCase();
    const createType = ObjectHandlers.CREATE_TYPE_MAP[typeKey] || args.type;
    const packageUrl = buildPackageUrl(args.package);

    // DEVC (package): the ADT REST endpoint returns "An exception was raised" with no detail,
    // and the abap-adt-api library's createObject can't supply software_component / transport_layer.
    // Use CL_PACKAGE_FACTORY=>CREATE_NEW_PACKAGE via classrun — that gives us full control and
    // clear sy-subrc / message values when something fails.
    if (typeKey === 'DEVC') {
      try {
        const nameUpper = args.name.toUpperCase();
        const parentUpper = args.package.toUpperCase();
        const transport = (args.transport || '').toUpperCase();
        const safeDesc = (args.description || '').replace(/'/g, "''").slice(0, 60);
        const safeName = nameUpper.replace(/'/g, "''");
        const safeParent = parentUpper.replace(/'/g, "''");
        const transportClause = transport
          ? `i_transport_request = '${transport.replace(/'/g, "''")}'`
          : `i_transport_request = ''`;

        const methodBody = `
DATA: lo_pkg    TYPE REF TO if_package,
      lo_root_x TYPE REF TO cx_root,
      ls_data   TYPE scompkdtln,
      ls_tdevc  TYPE tdevc.

" Look up software component (dlvunit) and transport layer (pdevclass) from parent.
SELECT SINGLE dlvunit pdevclass FROM tdevc
  INTO (ls_data-dlvunit, ls_data-pdevclass)
  WHERE devclass = '${safeParent}'.
IF sy-subrc <> 0.
  out->write( |Parent package ${safeParent} not found in TDEVC| ).
  RETURN.
ENDIF.

ls_data-devclass   = '${safeName}'.
ls_data-ctext      = '${safeDesc}'.
ls_data-as4user    = sy-uname.
ls_data-parentcl   = '${safeParent}'.
ls_data-masterlang = sy-langu.
ls_data-packtype   = 'D'.

TRY.
    cl_package_factory=>create_new_package(
      EXPORTING
        i_reuse_deleted_object  = abap_true
        i_suppress_dialog       = abap_true
      IMPORTING
        e_package               = lo_pkg
      CHANGING
        c_package_data          = ls_data
      EXCEPTIONS
        object_already_existing    = 1
        object_just_created        = 2
        not_authorized             = 3
        wrong_name_prefix          = 4
        undefined_name             = 5
        reserved_local_name        = 6
        invalid_package_name       = 7
        short_text_missing         = 8
        software_component_invalid = 9
        layer_invalid              = 10
        author_not_existing        = 11
        component_not_existing     = 12
        component_missing          = 13
        prefix_in_use              = 14
        unexpected_error           = 15
        intern_err                 = 16
        no_access                  = 17
        invalid_translation_depth  = 18
        wrong_mainpack_value       = 19
        superpackage_invalid       = 20
        error_in_cts_checks        = 21
        OTHERS                     = 22 ).

    IF sy-subrc <> 0.
      out->write( |create_new_package sy-subrc={ sy-subrc } ({ sy-msgid }/{ sy-msgno }) { sy-msgv1 } { sy-msgv2 } { sy-msgv3 } { sy-msgv4 }| ).
    ELSE.
      lo_pkg->save(
        EXPORTING
          i_suppress_dialog   = abap_true
          ${transportClause}
        EXCEPTIONS
          OTHERS              = 1 ).
      IF sy-subrc <> 0.
        out->write( |save sy-subrc={ sy-subrc } ({ sy-msgid }/{ sy-msgno }) { sy-msgv1 } { sy-msgv2 } { sy-msgv3 } { sy-msgv4 }| ).
      ELSE.
        out->write( 'OK' ).
      ENDIF.
    ENDIF.

  CATCH cx_root INTO lo_root_x.
    out->write( |Exception: { lo_root_x->get_text( ) }| ).
ENDTRY.
`;

        const output = await this.runClassrun(methodBody, 'ZCL_TMP_PKG_CREATE');
        if (!output.includes('OK')) {
          this.fail(`abap_create(${nameUpper}): ${output.trim() || 'package factory returned non-zero sy-subrc'}`);
        }
        return this.success({
          message: `Created package ${nameUpper} under ${parentUpper}${transport ? ` on transport ${transport}` : ''} (software component and transport layer inherited from parent).`,
          name: nameUpper,
          type: 'DEVC',
          package: parentUpper
        });
      } catch (error: any) {
        this.fail(formatError(`abap_create(${args.name})`, error));
      }
    }

    // DOMA/DTEL: the ADT REST endpoint rejects creates with "An exception was raised"
    // regardless of Content-Type. Use ABAP FMs (DDIF_DOMA_PUT / DDIF_DTEL_PUT) via
    // classrun instead — more reliable and works across all S/4 releases.
    if (typeKey === 'DOMA' || typeKey === 'DTEL') {
      const nameUpper = args.name.toUpperCase();
      const safeDesc = (args.description || '').replace(/'/g, "''");
      const pkg = args.package.toUpperCase();
      const transport = (args.transport || '').toUpperCase();

      let methodBody: string;
      if (typeKey === 'DOMA') {
        methodBody = `
DATA ls_dd01v TYPE dd01v.
ls_dd01v-domname  = '${nameUpper}'.
ls_dd01v-ddtext   = '${safeDesc}'.
ls_dd01v-datatype = 'CHAR'.
ls_dd01v-leng     = 1.

CALL FUNCTION 'DDIF_DOMA_PUT'
  EXPORTING
    name     = '${nameUpper}'
    dd01v_wa = ls_dd01v
  EXCEPTIONS
    put_failure = 1
    put_refused = 2
    OTHERS      = 3.

IF sy-subrc <> 0.
  out->write( |DDIF_DOMA_PUT failed: sy-subrc = { sy-subrc }| ).
ELSE.
  out->write( 'OK' ).
ENDIF.
`;
      } else {
        methodBody = `
DATA ls_dd04v TYPE dd04v.
ls_dd04v-rollname = '${nameUpper}'.
ls_dd04v-ddtext   = '${safeDesc}'.
ls_dd04v-datatype = 'CHAR'.
ls_dd04v-leng     = 1.

CALL FUNCTION 'DDIF_DTEL_PUT'
  EXPORTING
    name     = '${nameUpper}'
    dd04v_wa = ls_dd04v
  EXCEPTIONS
    put_failure = 1
    put_refused = 2
    OTHERS      = 3.

IF sy-subrc <> 0.
  out->write( |DDIF_DTEL_PUT failed: sy-subrc = { sy-subrc }| ).
ELSE.
  out->write( 'OK' ).
ENDIF.
`;
      }

      try {
        const output = await this.runClassrun(methodBody, 'ZCL_TMP_DDIC_CREATE');
        if (!output.includes('OK')) {
          this.fail(`abap_create(${nameUpper}): ${output.trim() || 'FM returned non-zero sy-subrc'}`);
        }
        const typeName = typeKey === 'DOMA' ? 'Domain' : 'Data element';
        return this.success({
          message:
            `${typeName} ${nameUpper} created in inactive state. ` +
            (transport ? `Assign to transport ${transport} with transport_assign, then ` : '') +
            `use abap_get_source / abap_set_source to set the full definition, then abap_activate.`,
          name: nameUpper,
          type: typeKey,
          package: pkg
        });
      } catch (error: any) {
        this.fail(formatError(`abap_create(${nameUpper})`, error));
      }
    }

    // TTYP (table type): same situation as DOMA/DTEL — the ADT REST endpoint returns
    // "An exception was raised", the library doesn't have TTYP/DA in its CreatableTypes,
    // and RS_CORR_INSERT rejects TTYP names as "wrong syntax" (it auto-converts to LIMU).
    // Use DDIF_TTYP_PUT for the DDIC structure, then INSERT INTO TADIR (and E071 if a
    // transport is provided) directly.
    if (typeKey === 'TTYP') {
      const nameUpper = args.name.toUpperCase();
      const pkg = args.package.toUpperCase();
      const transport = (args.transport || '').toUpperCase();
      const rowType = (args.rowType || '').toUpperCase();
      const safeDesc = (args.description || '').replace(/'/g, "''").slice(0, 60);

      if (!rowType) {
        this.fail(
          `abap_create(${nameUpper}): TTYP requires a rowType arg — pass the DDIC structure or data element ` +
          `to use as the line type, e.g. rowType="/DSN/BIL_S_RET_SHARE".`
        );
      }

      const safeName = nameUpper.replace(/'/g, "''");
      const safeRowType = rowType.replace(/'/g, "''");
      const safePkg = pkg.replace(/'/g, "''");
      const safeTransport = transport.replace(/'/g, "''");

      // Step 1 DDIF_TTYP_PUT to put the inactive DDIC version.
      // Step 2 INSERT INTO TADIR with the requested package.
      // Step 3 If a transport is provided AND the package is not $TMP, add an E071 entry to
      //        the user's open task in that request. We look up the task via E070.
      const methodBody = `
DATA: ls_dd40v TYPE dd40v,
      ls_tadir TYPE tadir,
      ls_e071  TYPE e071,
      lv_task  TYPE trkorr.

" --- DDIC put ---
ls_dd40v-typename   = '${safeName}'.
ls_dd40v-ddtext     = '${safeDesc}'.
ls_dd40v-rowkind    = 'S'.
ls_dd40v-rowtype    = '${safeRowType}'.
ls_dd40v-accessmode = 'T'.
ls_dd40v-keykind    = 'N'.
CALL FUNCTION 'DDIF_TTYP_PUT'
  EXPORTING name = '${safeName}' dd40v_wa = ls_dd40v
  EXCEPTIONS OTHERS = 1.
IF sy-subrc <> 0.
  out->write( |DDIF_TTYP_PUT sy-subrc={ sy-subrc } ({ sy-msgid }/{ sy-msgno }) { sy-msgv1 } { sy-msgv2 }| ).
  RETURN.
ENDIF.

" --- TADIR (skip if already present, e.g. retry after partial) ---
SELECT SINGLE pgmid FROM tadir INTO @DATA(lv_pgmid)
  WHERE pgmid = 'R3TR' AND object = 'TTYP' AND obj_name = '${safeName}'.
IF sy-subrc <> 0.
  ls_tadir-pgmid      = 'R3TR'.
  ls_tadir-object     = 'TTYP'.
  ls_tadir-obj_name   = '${safeName}'.
  ls_tadir-devclass   = '${safePkg}'.
  ls_tadir-srcsystem  = sy-sysid.
  ls_tadir-author     = sy-uname.
  ls_tadir-masterlang = sy-langu.
  INSERT INTO tadir VALUES ls_tadir.
  IF sy-subrc <> 0.
    out->write( |TADIR insert failed sy-subrc={ sy-subrc }| ). RETURN.
  ENDIF.
ENDIF.

" --- Transport assignment (if non-local + transport given) ---
IF '${safePkg}' <> '$TMP' AND '${safeTransport}' IS NOT INITIAL.
  " Find the user's open task in this request
  SELECT SINGLE trkorr FROM e070 INTO @lv_task
    WHERE strkorr = '${safeTransport}'
      AND trstatus = 'D'
      AND as4user = @sy-uname.
  IF sy-subrc <> 0.
    " Fall back to the request itself
    lv_task = '${safeTransport}'.
  ENDIF.

  " Skip if already in the transport
  SELECT SINGLE trkorr FROM e071 INTO @DATA(lv_existing_task)
    WHERE trkorr = @lv_task AND pgmid = 'R3TR' AND object = 'TTYP' AND obj_name = '${safeName}'.
  IF sy-subrc <> 0.
    ls_e071-trkorr   = lv_task.
    ls_e071-as4pos   = 1.
    ls_e071-pgmid    = 'R3TR'.
    ls_e071-object   = 'TTYP'.
    ls_e071-obj_name = '${safeName}'.
    ls_e071-objfunc  = 'K'.
    INSERT INTO e071 VALUES ls_e071.
    IF sy-subrc <> 0.
      out->write( |E071 insert failed sy-subrc={ sy-subrc } — TADIR is set but object is not on transport| ).
    ENDIF.
  ENDIF.
ENDIF.

COMMIT WORK.
out->write( 'OK' ).
`;

      try {
        const output = await this.runClassrun(methodBody, 'ZCL_TMP_TTYP_CREATE');
        if (!output.includes('OK')) {
          this.fail(`abap_create(${nameUpper}): ${output.trim() || 'TTYP creation returned non-zero sy-subrc'}`);
        }
        return this.success({
          message:
            `Table type ${nameUpper} created in inactive state (line type ${rowType}). ` +
            `Activate with abap_activate.`,
          name: nameUpper,
          type: 'TTYP',
          package: pkg,
          rowType
        });
      } catch (error: any) {
        this.fail(formatError(`abap_create(${nameUpper})`, error));
      }
    }

    // BDEF requires a custom Content-Type (application/vnd.sap.adt.blues.v1+xml) that the
    // library's createObject does not support. Bypass it and call the ADT endpoint directly.
    if (typeKey === 'BDEF') {
      try {
        const h = (this.adtclient as any).h;
        const username = ((h.username || 'UNKNOWN') as string).toUpperCase();
        const escDesc = (args.description || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const body =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<blue:blueSource\n` +
          `  xmlns:blue="http://www.sap.com/wbobj/blue"\n` +
          `  xmlns:adtcore="http://www.sap.com/adt/core"\n` +
          `  adtcore:description="${escDesc}"\n` +
          `  adtcore:name="${args.name.toUpperCase()}"\n` +
          `  adtcore:responsible="${username}">\n` +
          `  <adtcore:packageRef adtcore:name="${args.package}"/>\n` +
          `</blue:blueSource>`;
        const qs: any = {};
        if (args.transport) qs.corrNr = args.transport;
        await this.withSession(() =>
          h.request('/sap/bc/adt/bo/behaviordefinitions', {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'application/vnd.sap.adt.blues.v1+xml' },
            qs
          })
        );
        return this.success({
          message: `Created BDEF ${args.name}. Activation order: DDLS first → BDEF → behavior pool class. Use abap_set_source then abap_activate.`,
          name: args.name,
          type: 'BDEF',
          package: args.package
        });
      } catch (error: any) {
        this.fail(formatError(`abap_create(${args.name})`, error));
      }
    }

    try {
      await this.withSession(() =>
        this.adtclient.createObject(
          createType,
          args.name,
          args.package,
          args.description,
          packageUrl,
          undefined,
          args.transport
        )
      );
      return this.success({
        message: `Created ${args.type} ${args.name}. Now write source with abap_set_source and activate with abap_activate.`,
        name: args.name,
        type: args.type,
        package: args.package
      });
    } catch (error: any) {
      this.fail(formatError(`abap_create(${args.name})`, error));
    }
  }

  private async handleDelete(args: any): Promise<any> {
    // Elicit confirmation for non-$TMP objects (they're in a real package with a transport)
    if (args.transport) {
      const confirmed = await this.confirmWithUser(
        `Delete ${args.type} ${args.name} on transport ${args.transport}? This removes the object from the system.`,
        { object: args.name, type: args.type, transport: args.transport }
      );
      if (!confirmed) {
        this.fail(`abap_delete(${args.name}): cancelled by user.`);
      }
    }

    const objectUrl = buildObjectUrl(args.name, args.type);
    let lockHandle: string | null = null;
    try {
      const lockResult = await this.withSession(() =>
        this.adtclient.lock(objectUrl)
      );
      lockHandle = lockResult.LOCK_HANDLE;

      // Transport guard: reject deletes on non-$TMP objects without a transport
      args.transport = this.requireTransport(lockResult, args.transport, args.name);

      await this.withSession(async () => {
        const h = (this.adtclient as any).h;
        const qs: Record<string, string> = { lockHandle: lockHandle! };
        // Some ADT endpoints (e.g. DDLS on certain systems) require corrNr explicitly on DELETE.
        // Include it when we have a transport — the lock CORRNR (task number) is authoritative.
        if (args.transport) qs.corrNr = args.transport;
        await h.request(objectUrl, { method: 'DELETE', qs });
      });
      lockHandle = null;

      return this.success({ message: `Deleted ${args.type} ${args.name}` });
    } catch (error: any) {
      if (lockHandle) {
        try { await this.adtclient.unLock(objectUrl, lockHandle); } catch (_) {}
      }
      const errMsg = (error?.message || '').toLowerCase();
      if (!args.transport && (errMsg.includes('transport') || errMsg.includes('correction') || errMsg.includes('request'))) {
        const input = await this.elicitForm(
          `abap_delete(${args.name}): This object requires a transport. Which transport?`,
          { transport: { type: 'string', title: 'Transport', description: 'Transport request number (e.g. D23K900123)' } },
          ['transport']
        );
        if (input?.transport) {
          args.transport = input.transport;
          return this.handleDelete(args);
        }
      }
      this.fail(formatError(`abap_delete(${args.name})`, error));
    }
  }

  private async handleActivate(args: any): Promise<any> {
    if (!args.name || !args.type) {
      this.fail('abap_activate requires name (object name) and type (e.g. CLAS, PROG/P).');
    }
    // Function modules can't be activated individually — SAP activates the whole function group.
    // When type is FUGR/FF, activate the parent FUGR instead.
    let activateName: string;
    let objectUrl: string;

    if (args.type?.toUpperCase() === 'FUGR/FF') {
      if (!args.fugr) {
        this.fail(
          `abap_activate: type FUGR/FF requires the fugr parameter (parent function group name). ` +
          `Example: fugr="/DSN/010BWE" to activate function group /DSN/010BWE.`
        );
      }
      activateName = args.fugr.toUpperCase();
      objectUrl = buildObjectUrl(args.fugr, 'FUGR/F');
    } else {
      activateName = args.name.toUpperCase();
      objectUrl = buildObjectUrl(args.name, args.type);
    }

    try {
      await this.notify(`Activating ${activateName}…`);
      const result = await this.withSession(() =>
        this.adtclient.activate(activateName, objectUrl)
      );

      if (result && !result.success) {
        const errorText = formatActivationMessages(result.messages || []);

        // If the error mentions a dump but gives no ID, try to fetch the most recent dump
        // automatically — SAP sometimes fails to write the full ST22 entry.
        let recentDump: any = undefined;
        const hasDumpHint = errorText.toLowerCase().includes('dump') || errorText.toLowerCase().includes('runtime');
        const hasEmptyDumpId = /dump id:\s*\)/i.test(errorText) || /dump id:\s*"?\s*"?\s*\)/i.test(errorText);
        if (hasDumpHint && hasEmptyDumpId) {
          try {
            const feed = await this.withSession(() => this.adtclient.dumps());
            const dumps = (feed as any)?.dumps || [];
            recentDump = dumps[0] || null;
          } catch (_) {}
        }

        return this.success({
          activated: false,
          name: args.name,
          errors: errorText,
          ...(recentDump ? {
            recentDump: {
              hint: 'Empty dump ID — fetched most recent ST22 entry automatically:',
              text: recentDump.text,
              type: recentDump.type,
              id: recentDump.id
            }
          } : {})
        });
      }

      // Check for still-inactive dependents — offer to activate them
      const inactive = result?.inactive || [];
      const inactiveNames = inactive
        .map((i: any) => i.object?.['adtcore:name'])
        .filter(Boolean);

      if (inactiveNames.length > 0) {
        const activateMore = await this.confirmWithUser(
          `${args.name} activated successfully, but ${inactiveNames.length} dependent object(s) are still inactive: ${inactiveNames.join(', ')}. Activate them too?`,
          { dependents: inactiveNames.join(', ') }
        );
        if (activateMore) {
          const activatedDeps: string[] = [];
          const failedDeps: string[] = [];
          for (const dep of inactive) {
            const depName = dep.object?.['adtcore:name'];
            const depUrl = dep.object?.['adtcore:uri'];
            if (depName && depUrl) {
              try {
                await this.withSession(() => this.adtclient.activate(depName, depUrl));
                activatedDeps.push(depName);
              } catch (_) {
                failedDeps.push(depName);
              }
            }
          }
          return this.success({
            activated: true,
            name: args.name,
            dependentsActivated: activatedDeps,
            dependentsFailed: failedDeps.length > 0 ? failedDeps : undefined
          });
        }
      }

      return this.success({
        activated: true,
        name: args.name,
        dependentsStillInactive: inactiveNames.length > 0 ? inactiveNames : []
      });
    } catch (error: any) {
      this.fail(formatError(`abap_activate(${args.name})`, error));
    }
  }

  // Map short types to their ADT adtcore:type subtype for activation
  private static readonly ACTIVATE_TYPE_MAP: Record<string, string> = {
    'CLAS': 'CLAS/OC', 'INTF': 'INTF/OI', 'PROG': 'PROG/P',
    'FUGR': 'FUGR/F', 'DDLS': 'DDLS/DF', 'DDLX': 'DDLX/EX',
    'TABL': 'TABL/DT', 'DTEL': 'DTEL/DE', 'DOMA': 'DOMA/DD',
    'DCLS': 'DCLS/DL', 'SRVD': 'SRVD/SRV', 'SRVB': 'SRVB/SVB',
    'ENHO': 'ENHO/XHH', 'DEVC': 'DEVC/K', 'MSAG': 'MSAG/N',
    'VIEW': 'VIEW/DV', 'BDEF': 'BDEF',
  };

  private async handleActivateBatch(args: any): Promise<any> {
    if (!args.objects || !Array.isArray(args.objects) || args.objects.length === 0) {
      this.fail('abap_activate_batch: objects array is required and must not be empty.');
    }
    try {
      // Build activation payload. SAP's batch endpoint uses the same minimal format as single:
      // {uri, name} only — adding adtcore:type or adtcore:parentUri causes "Check of condition failed".
      const objectRefs = args.objects.map((o: any) => {
        if (!o.name || !o.type) {
          throw new Error(`Each object must have name and type. Got: ${JSON.stringify(o)}`);
        }
        const uri = buildObjectUrl(o.name, o.type);
        return { uri, name: o.name.toUpperCase() };
      });

      await this.notify(`Activating ${objectRefs.length} object(s)…`);

      // Post directly — the library's array form adds adtcore:type/parentUri which SAP rejects
      const h = (this.adtclient as any).h;
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
        objectRefs.map((r: any) => `<adtcore:objectReference adtcore:uri="${r.uri}" adtcore:name="${r.name}"/>`).join('\n') +
        `</adtcore:objectReferences>`;

      const rawResp = await this.withSession(() =>
        h.request('/sap/bc/adt/activation', {
          method: 'POST', body,
          qs: { method: 'activate', preauditRequested: true }
        })
      );

      // Parse response the same way the library does
      const { XMLParser } = await import('fast-xml-parser');
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
      const parsed = parser.parse((rawResp as any).body || '');
      const msgs: any[] = [];
      const chkl = parsed?.messages;
      if (chkl) {
        const arr = Array.isArray(chkl.msg) ? chkl.msg : (chkl.msg ? [chkl.msg] : []);
        arr.forEach((m: any) => msgs.push({ type: m['@_type'] || 'E', shortText: m?.shortText?.txt || 'Syntax error', objName: m['@_objName'] || '' }));
      }
      const hasError = msgs.some((m: any) => /[EAX]/.test(m.type));
      const inactives: any[] = [];
      const ioc = parsed?.inactiveObjects;
      if (ioc) {
        const entries = Array.isArray(ioc.entry) ? ioc.entry : (ioc.entry ? [ioc.entry] : []);
        entries.forEach((e: any) => inactives.push(e));
      }
      const result = { success: !hasError && inactives.length === 0, messages: msgs, inactive: inactives };

      if (result && !result.success) {
        const errorText = formatActivationMessages(result.messages || []);

        // Offer to retry each object individually to isolate which one(s) are failing
        const choice = await this.elicitChoice(
          `Batch activation failed for ${objectRefs.length} object(s).\n${errorText}\n\n` +
          `Retry each object individually to find which one(s) are causing the failure?`,
          'action',
          ['Retry individually', 'Abort'],
          'Retry individually'
        );

        if (choice === 'Retry individually') {
          const passed: string[] = [];
          const failed: Array<{ name: string; error: string }> = [];
          for (const obj of objectRefs) {
            try {
              const r = await this.withSession(() =>
                this.adtclient.activate(obj.name, obj.uri)
              );
              if (r && !r.success) {
                failed.push({ name: obj.name, error: formatActivationMessages(r.messages || []) });
              } else {
                passed.push(obj.name);
              }
            } catch (e: any) {
              failed.push({ name: obj.name, error: (e as any).message });
            }
          }
          return this.success({
            activated: failed.length === 0,
            mode: 'individual_retry',
            passed,
            failed
          });
        }

        this.fail(`abap_activate_batch: activation failed.\n${errorText}`);
      }

      const inactive = result?.inactive || [];
      const inactiveNames = inactive
        .map((i: any) => i.object?.['adtcore:name'])
        .filter(Boolean);

      // Offer to activate still-inactive dependents
      if (inactiveNames.length > 0) {
        const activateDeps = await this.confirmWithUser(
          `${objectRefs.length} object(s) activated. ` +
          `${inactiveNames.length} dependent(s) are still inactive: ${inactiveNames.join(', ')}. Activate them too?`,
          { dependents: inactiveNames.join(', ') }
        );
        if (activateDeps) {
          const activatedDeps: string[] = [];
          const failedDeps: string[] = [];
          for (const dep of inactive) {
            const depName = dep.object?.['adtcore:name'];
            const depUrl = dep.object?.['adtcore:uri'];
            if (depName && depUrl) {
              try {
                await this.withSession(() => this.adtclient.activate(depName, depUrl));
                activatedDeps.push(depName);
              } catch (_) {
                failedDeps.push(depName);
              }
            }
          }
          return this.success({
            activated: true,
            objectCount: objectRefs.length,
            objects: args.objects.map((o: any) => o.name),
            dependentsActivated: activatedDeps,
            dependentsFailed: failedDeps.length > 0 ? failedDeps : undefined
          });
        }
      }

      return this.success({
        activated: true,
        objectCount: objectRefs.length,
        objects: args.objects.map((o: any) => o.name),
        dependentsStillInactive: inactiveNames.length > 0 ? inactiveNames : []
      });
    } catch (error: any) {
      this.fail(formatError('abap_activate_batch', error));
    }
  }

  /**
   * Sanitize search query for SAP ADT quick search.
   * SAP only supports trailing wildcards (e.g. /DSN/BIL*).
   * Leading wildcards (*BILL*) and multi-wildcards (/DSN/*FOO*BAR*) return 400.
   * This method rewrites bad patterns into valid ones and returns a warning.
   */
  private sanitizeSearchQuery(query: string): { query: string; warning?: string } {
    if (!query) return { query };
    const original = query;

    // Pattern: *SOMETHING or *SOMETHING* (leading wildcard, no namespace)
    // e.g. *SF1403* → SF1403*
    if (query.startsWith('*')) {
      query = query.replace(/^\*+/, '').replace(/\*+$/, '') + '*';
      return {
        query,
        warning: `Rewrote "${original}" → "${query}" (SAP ADT only supports trailing wildcards)`
      };
    }

    // Pattern: /NS/*SOMETHING* (namespace + leading wildcard in name part)
    // e.g. /DSN/*BILL* → /DSN/BILL*
    // e.g. /VNO/*FORM* → /VNO/FORM*
    const nsMatch = query.match(/^(\/[^/]+\/)\*(.+)$/);
    if (nsMatch) {
      const ns = nsMatch[1];
      const rest = nsMatch[2].replace(/\*+$/, '') + '*';
      query = ns + rest;
      return {
        query,
        warning: `Rewrote "${original}" → "${query}" (SAP ADT only supports trailing wildcards)`
      };
    }

    // Pattern: multiple wildcards in the name e.g. /DSN/FOO*BAR*
    const wildcardCount = (query.match(/\*/g) || []).length;
    if (wildcardCount > 1) {
      // Keep everything up to the first wildcard
      const firstStar = query.indexOf('*');
      query = query.substring(0, firstStar + 1);
      return {
        query,
        warning: `Rewrote "${original}" → "${query}" (SAP ADT does not support multiple wildcards)`
      };
    }

    return { query };
  }

  private async handleSearch(args: any): Promise<any> {
    const { query, warning } = this.sanitizeSearchQuery(args.query);
    try {
      const results = await this.withSession(() =>
        this.adtclient.searchObject(query, args.type, args.max || 50)
      );
      const count = Array.isArray(results) ? results.length : 0;
      const hint = count === 0 && query && !query.includes('*')
        ? ` No results — try adding a wildcard, e.g. "${query}*"`
        : undefined;
      return this.success({ results, count, ...(warning ? { warning } : {}), ...(hint ? { hint } : {}) });
    } catch (error: any) {
      this.fail(formatError(`abap_search(${query})`, error) +
        (warning ? ` (original query "${args.query}" was rewritten to "${query}")` : ''));
    }
  }

  private async handleObjectInfo(args: any): Promise<any> {
    // For FUGR/FF (function modules), objectStructure is not meaningful on the FM directly.
    // Redirect to the parent FUGR if available, otherwise explain.
    const effectiveType = args.type?.toUpperCase() === 'FUGR/FF' ? 'FUGR/F' : args.type;
    const effectiveName = args.type?.toUpperCase() === 'FUGR/FF'
      ? (args.fugr || args.name)  // use fugr param if provided, else fall through and let buildObjectUrl fail clearly
      : args.name;

    const objectUrl = buildObjectUrl(effectiveName, effectiveType);

    try {
      const structure = await this.withSession(() =>
        this.adtclient.objectStructure(objectUrl)
      );

      // Surface the upgrade flag prominently — if true, edits will fail with "adjustment mode"
      const structureStr = JSON.stringify(structure).toLowerCase();
      const upgradeFlag = (structure as any)?.upgradeFlag === true ||
        structureStr.includes('"upgradeflag":true');

      return this.success({
        name: args.name,
        type: args.type,
        structure,
        upgradeFlag,
        upgradeWarning: upgradeFlag
          ? 'WARNING: This object is in SPAU adjustment mode. All lock/edit/delete operations will fail with "Enhancement is in adjustment mode." Use SPAU_ENH in SAP GUI to clear this before editing.'
          : undefined
      });
    } catch (error: any) {
      const info = parseAdtError(error);
      // For FUGRs, objectStructure may return an unusual shape or temporarily fail during
      // activation processing. Surface what we know rather than a raw API error.
      if (args.type?.toUpperCase() === 'FUGR/F' || args.type?.toUpperCase() === 'FUGR') {
        this.fail(
          `abap_object_info(${args.name}): Could not retrieve function group structure. ` +
          `If the function group is mid-activation or has an active lock, try again after activation completes. ` +
          `Details: ${info.message}`
        );
      }
      this.fail(formatError(`abap_object_info(${args.name})`, error));
    }
  }
}

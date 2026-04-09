/**
 * ADT URL Builder — the LLM should never construct ADT URLs manually.
 * Pass (name, type) and get the correct URL back, including namespace encoding.
 *
 * Encoding rules:
 *   - / in object names → %2f  (namespace separator: /DSN/FOO → %2fdsn%2ffoo)
 *   - $ in package names → %24 ($TMP → %24tmp)
 *   - names are lowercased in URLs (ABAP is case-insensitive; ADT uses lowercase)
 */

const TYPE_PATHS: Record<string, string> = {
  // Classes and interfaces
  'CLAS':     '/sap/bc/adt/oo/classes',
  'CLAS/OC':  '/sap/bc/adt/oo/classes',
  'INTF':     '/sap/bc/adt/oo/interfaces',
  'INTF/OI':  '/sap/bc/adt/oo/interfaces',

  // Programs and includes
  'PROG':     '/sap/bc/adt/programs/programs',
  'PROG/P':   '/sap/bc/adt/programs/programs',
  'PROG/I':   '/sap/bc/adt/programs/includes',

  // Function groups (modules and includes are nested — use buildFunctionModuleUrl / buildFunctionIncludeUrl)
  'FUGR':     '/sap/bc/adt/functions/groups',
  'FUGR/F':   '/sap/bc/adt/functions/groups',

  // CDS / Data definitions
  'DDLS':     '/sap/bc/adt/ddic/ddl/sources',
  'DDLS/DF':  '/sap/bc/adt/ddic/ddl/sources',
  'DDLX':     '/sap/bc/adt/ddic/ddlx/sources',   // CDS view extensions (verify path)
  'DDLX/EX':  '/sap/bc/adt/ddic/ddlx/sources',

  // DDIC objects
  'TABL':     '/sap/bc/adt/ddic/tables',
  'TABL/DT':  '/sap/bc/adt/ddic/tables',
  'TABL/DS':  '/sap/bc/adt/ddic/structures',
  'STRU':     '/sap/bc/adt/ddic/structures',   // SE11 structures (alias for TABL/DS)
  'DTEL':     '/sap/bc/adt/ddic/dataelements',
  'DTEL/DE':  '/sap/bc/adt/ddic/dataelements',
  'DOMA':     '/sap/bc/adt/ddic/domains',
  'DOMA/DD':  '/sap/bc/adt/ddic/domains',

  // Access control lists
  'DCLS':     '/sap/bc/adt/dcls',
  'DCLS/DL':  '/sap/bc/adt/dcls',

  // RAP behavior definitions
  'BDEF':     '/sap/bc/adt/bo/behaviordefinitions',

  // OData service definitions and bindings
  'SRVD':     '/sap/bc/adt/ddic/srvd/sources',
  'SRVD/SRV': '/sap/bc/adt/ddic/srvd/sources',
  'SRVB':     '/sap/bc/adt/businessservices/bindings',
  'SRVB/SVB': '/sap/bc/adt/businessservices/bindings',

  // Enhancements
  // ENHO/XHH — confirmed from live ADT session. upgradeFlag=true means SPAU_ENH required.
  'ENHO':     '/sap/bc/adt/enhancements/enhoxhh',
  'ENHO/XHH': '/sap/bc/adt/enhancements/enhoxhh',
  'ENHS':     '/sap/bc/adt/enhancements/spots',

  // Packages
  'DEVC':     '/sap/bc/adt/packages',
  'DEVC/K':   '/sap/bc/adt/packages',

  // Message classes
  'MSAG':     '/sap/bc/adt/messageclass',
  'MSAG/N':   '/sap/bc/adt/messageclass',

  // Database views (SE11 maintenance views, database views, projection views)
  'VIEW':     '/sap/bc/adt/ddic/views',
  'VIEW/DV':  '/sap/bc/adt/ddic/views',
  'VIEW/MV':  '/sap/bc/adt/ddic/views',
  'VIEW/PV':  '/sap/bc/adt/ddic/views',
  'VIEW/HV':  '/sap/bc/adt/ddic/views',

  // Other common DDIC types
  'SQLT':     '/sap/bc/adt/ddic/tabletypes',   // table types
  'SHLP':     '/sap/bc/adt/ddic/searchhelps',  // search helps
  'TTYP':     '/sap/bc/adt/ddic/tabletypes',
};

/**
 * Encode an ABAP object name for use in an ADT URL path segment.
 * /DSN/FOO → %2fdsn%2ffoo
 * $TMP     → %24tmp
 */
export function encodeAbapName(name: string): string {
  if (!name) throw new Error('Object name is required.');
  return name
    .replace(/\//g, '%2f')
    .replace(/\$/g, '%24')
    .toLowerCase();
}

/**
 * Build the ADT base URL for an object (no /source/main suffix).
 * Use this for lock(), unLock(), deleteObject(), objectStructure().
 */
export function buildObjectUrl(name: string, type: string): string {
  if (!name) throw new Error('Object name is required.');
  if (!type) throw new Error('Object type is required (e.g. CLAS, PROG/P, DDLS/DF).');
  const key = type.toUpperCase();
  const basePath = TYPE_PATHS[key];
  if (!basePath) {
    const known = Object.keys(TYPE_PATHS).filter(k => !k.includes('/')).join(', ');
    throw new Error(
      `Unknown object type '${type}'. Supported: ${known}. ` +
      `For function modules use type FUGR with buildFunctionModuleUrl().`
    );
  }
  return `${basePath}/${encodeAbapName(name)}`;
}

/**
 * Build the ADT source URL for an object (with /source/main suffix).
 * Use this for getObjectSource() and setObjectSource().
 */
export function buildSourceUrl(name: string, type: string): string {
  return `${buildObjectUrl(name, type)}/source/main`;
}

/**
 * Build the URL for a function module (nested under its function group).
 * fgroupName: the function group (e.g. /DSN/BIL_FG)
 * fmoduleName: the function module (e.g. /DSN/BIL_CALCULATE)
 */
export function buildFunctionModuleUrl(fgroupName: string, fmoduleName: string): string {
  return `/sap/bc/adt/functions/groups/${encodeAbapName(fgroupName)}/fmodules/${encodeAbapName(fmoduleName)}`;
}

/**
 * Build the URL for a function group include (nested under its function group).
 * fgroupName: the function group (e.g. /DSN/010BWE)
 * includeName: the include (e.g. /DSN/010BWE_01)
 */
export function buildFunctionIncludeUrl(fgroupName: string, includeName: string): string {
  return `/sap/bc/adt/functions/groups/${encodeAbapName(fgroupName)}/includes/${encodeAbapName(includeName)}`;
}

/**
 * Build the ADT URL for a class method.
 * className: the class (e.g. /DSN/MY_CLASS)
 * methodName: the method (e.g. GET_CONT)
 */
export function buildMethodUrl(className: string, methodName: string): string {
  return `/sap/bc/adt/oo/classes/${encodeAbapName(className)}/methods/${methodName.toLowerCase()}`;
}

/**
 * Types that require a parent name to construct their URL.
 * For these, SourceHandlers will use searchObject to auto-discover the full URL.
 */
export const NESTED_TYPES = new Set(['FUGR/I', 'FUGR/FF']);

/**
 * Build the URL for a package (handles $TMP → %24tmp).
 */
export function buildPackageUrl(packageName: string): string {
  return `/sap/bc/adt/packages/${encodeAbapName(packageName)}`;
}

export function getSupportedTypes(): string[] {
  return [...new Set(Object.keys(TYPE_PATHS).map(k => k.split('/')[0]))].sort();
}

/**
 * The "runtime" is a tiny BI Publisher data model + report that turns a gzip/base64 encoded SQL
 * string (parameter P_B64_CONTENT) into pipe-delimited CSV by opening a REF CURSOR over it.
 *
 * Idea and file layout originate from the MIT-licensed `fusion-query` project
 * (https://github.com/AleCyriaco/fusion-query, FusionQueryProxy.xdrz). The previous release of this
 * extension expected users to import that catalog archive by hand; here the same objects are
 * generated and uploaded automatically through BI Publisher's CatalogService.
 */
import * as zlib from 'zlib';
import { FusionError } from './errors';
import { readZip, writeZip, ZipEntry } from './zip';
import { xmlEscape } from './xml';

/** Bump when the generated objects change; the version is part of the catalog path. */
export const RUNTIME_VERSION = 2;
export const RUNTIME_FOLDER = 'FusionSqlDev';
export const DEFAULT_DATA_SOURCE = 'ApplicationDB_FSCM';

export interface RuntimeSpec {
  /** Catalog folder that will contain the helper, normally "/~<username>". */
  catalogRoot: string;
  /** BI Publisher JDBC data source name (ApplicationDB_FSCM, ApplicationDB_HCM, ApplicationDB_CRM ...). */
  dataSource: string;
}

export interface RuntimeArtifacts {
  rootFolder: string;
  versionFolder: string;
  dmPath: string;
  reportPath: string;
  dataModelZip: Buffer;
  reportZip: Buffer;
}

export function encodeSql(sql: string): string {
  return zlib.gzipSync(Buffer.from(sql, 'utf8')).toString('base64');
}

export function personalRoot(username: string): string {
  return `/~${username}`;
}

export function runtimePaths(spec: RuntimeSpec): Pick<RuntimeArtifacts, 'rootFolder' | 'versionFolder' | 'dmPath' | 'reportPath'> {
  const suffix = spec.dataSource === DEFAULT_DATA_SOURCE ? '' : '-' + spec.dataSource.replace(/^ApplicationDB_/i, '').replace(/[^\w]/g, '').toLowerCase();
  const rootFolder = `${spec.catalogRoot}/${RUNTIME_FOLDER}`;
  const versionFolder = `${rootFolder}/v${RUNTIME_VERSION}${suffix}`;
  return { rootFolder, versionFolder, dmPath: `${versionFolder}/dm.xdm`, reportPath: `${versionFolder}/csv.xdo` };
}

/** Where earlier tools (fusion-query, Fusion SQL DEV 1.x) were told to import the catalog file. */
export function legacyReportPaths(catalogRoot: string): string[] {
  return [`${catalogRoot}/FusionQuery/v1/csv.xdo`, '/Custom/FusionQuery/Proxy/v1/csv.xdo'];
}

function metaXml(entries: Record<string, string>): string {
  const rows = Object.entries(entries)
    .map(([k, v]) => `    <entry>\n      <key><![CDATA[${k}]]></key>\n      <value><![CDATA[${v}]]></value>\n    </entry>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<metadata>\n  <entries>\n${rows}\n  </entries>\n</metadata>`;
}

function dataModelXml(spec: RuntimeSpec): string {
  const ds = xmlEscape(spec.dataSource);
  const defaultSql = encodeSql('SELECT * FROM DUAL');
  return `<?xml version = '1.0' encoding = 'utf-8'?>
<dataModel xmlns="http://xmlns.oracle.com/oxp/xmlp" version="2.1" xmlns:xdm="http://xmlns.oracle.com/oxp/xmlp" xmlns:xsd="http://wwww.w3.org/2001/XMLSchema" defaultDataSourceRef="${ds}">
   <dataProperties>
      <property name="include_parameters" value="false"/>
      <property name="include_null_Element" value="true"/>
      <property name="include_rowsettag" value="false"/>
      <property name="exclude_tags_for_lob" value="false"/>
      <property name="EXCLUDE_LINE_FEED_AND_CARRIAGE_RETURN_FOR_LOB" value="false"/>
      <property name="xml_tag_case" value="upper"/>
      <property name="generate_output_format" value="csv"/>
      <property name="enforce_validation_status" value="true"/>
      <property name="optimize_query_executions" value="true"/>
      <property name="enable_xml_chunks" value=""/>
      <property name="sql_monitor_report_generated" value="false"/>
   </dataProperties>
   <dataSets>
      <dataSet name="GET" type="simple">
         <sql dataSourceRef="${ds}" nsQuery="true" sp="true" xmlRowTagName="" bindMultiValueAsCommaSepStr="false">
            <![CDATA[DECLARE
TYPE CurType IS REF CURSOR;
xdo_cursor CurType;
BEGIN
  OPEN :xdo_cursor FOR utl_raw.cast_to_varchar2(UTL_COMPRESS.lz_uncompress(TO_BLOB(utl_encode.base64_decode(UTL_RAW.CAST_TO_RAW(:P_B64_CONTENT)))));
END;]]>
         </sql>
      </dataSet>
   </dataSets>
   <output rootName="DATA_DS" uniqueRowName="false">
      <nodeList name="GET"/>
   </output>
   <eventTriggers/>
   <lexicals/>
   <parameters>
      <parameter name="P_B64_CONTENT" defaultValue="${defaultSql}" dataType="xsd:string" rowPlacement="1" mandatory="true">
         <input/>
      </parameter>
   </parameters>
   <valueSets/>
   <bursting/>
   <validations>
      <validation>N</validation>
   </validations>
   <display>
      <layouts>
         <layout name="GET" left="280px" top="317px"/>
         <layout name="DATA_DS" left="0px" top="317px"/>
      </layouts>
      <groupLinks/>
   </display>
</dataModel>
`;
}

const SAMPLE_XML = `<?xml version = '1.0' encoding = 'utf-8'?>
<ROWSET>
<ROW>
<DUMMY>X</DUMMY>
</ROW>
</ROWSET>
`;

export function reportXml(dmPath: string): string {
  return `<?xml version = '1.0' encoding = 'utf-8'?>
<report xmlns="http://xmlns.oracle.com/oxp/xmlp" xmlns:xsd="http://wwww.w3.org/2001/XMLSchema" version="2.0" dataModel="true" useBipParameters="true" producerName="fin-financialCommon" parameterVOName="" parameterTaskFlow="" customDataControl="" cachePerUser="true" cacheSmartRefresh="false" cacheUserRefresh="false">
   <dataModel url="${xmlEscape(dmPath)}"/>
   <description/>
   <property name="showControls" value="false"/>
   <property name="online" value="false"/>
   <property name="openLinkInNewWindow" value="false"/>
   <property name="autoRun" value="false"/>
   <property name="cacheDocument" value="true"/>
   <property name="showReportLinks" value="false"/>
   <property name="asynchronousRun" value="false"/>
   <property name="priority" value="normal"/>
   <property name="sendOutputAsUrl" value="insLevel"/>
   <property name="cacheDuration" value="30"/>
   <property name="controledByExtApp" value="false"/>
   <property name="ignoreEmailDomainRestrictions" value="false"/>
   <property name="saveXMLForRepublishing" value="false"/>
   <property name="disableMakeOutputPublic" value="false"/>
   <parameters paramPerLine="3" style="parameterLocation:in-horizontal;promptLocation:side;"/>
   <templates default="Default">
      <template label="Default" url="Default.xpt" type="xpt" outputFormat="csv" defaultFormat="csv" locale="en_US" active="true" viewOnline="true"/>
   </templates>
</report>
`;
}

// Delimiter and CSV behaviour are driven by this per-report config: pipe separator, no BOM.
const XDO_CFG = `<config version="1.0.0" xmlns="http://xmlns.oracle.com/oxp/config/">
<properties>
\t<property name="xdk-secure-io-mode">true</property>
\t<property name="webservice-optimization">true</property>
\t<property name="flattenxml-trim-whitespaces">true</property>
\t<property name="csv-delimiter">|</property>
\t<property name="csv-output-bom">false</property>
\t<property name="ignore-case-for-catalog-object-path">true</property></properties>
\t<fonts/>
</config>
`;

// A deliberately empty "layout editor" template; with output=csv BI Publisher then emits the raw data set.
const XPT_LAYOUT = `<?xml version="1.0" encoding="UTF-8"?><Report id="1"><ColorPicker/><Page id="2"><Property key="page-width" value="1056px"/><Property key="page-height" value="816px"/><Property key="margin" value="48px 48px 48px 48px"/><Property key="displayUnit" value="px"/><Property key="interactive-max-connections" value="auto"/><Body id="3"/></Page></Report>`;
const XPT_BUSINESS_VIEW = `<output>
   <nodeList name="ROWSET" label="Rowset">
      <group name="ROW" label="Row">
         <element name="DUMMY" label="Dummy" dataType="xsd:string"/>
      </group>
   </nodeList>
</output>`;
// 150x115 placeholder thumbnail used by the layout editor.
const XPT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAJYAAABzCAIAAAD16myEAAAAvUlEQVR42u3RMQ0AAAzDsPIn3ZLYM8mBEKd6XixAKIRCiFAIhVAIEQqhEAohQiEUQiFEKIRCKIQIhVAIhRChEAqhECIUQiEUQoRCKIRCiFAIhVAIEQqhEAohQiEUQiFEKIRCKIQIhVAIhRChEAqhECIUQiEUQoRCKIRCiFAIhVAIEQqhEAohQiEUQiFEKIRCKIQIhVAIhRChEAqhECIUQiEUQoRCKIRCiFAIhVAIEQqhEAohQiEUQiFEKIQ6ai55Z6I9Eu3PAAAAAElFTkSuQmCC';

function xptZip(): Buffer {
  return writeZip([
    { name: 'businessView.xml', data: Buffer.from(XPT_BUSINESS_VIEW, 'utf8') },
    { name: 'layout.xml', data: Buffer.from(XPT_LAYOUT, 'utf8') },
    { name: 'version.txt', data: Buffer.from('2.2.3', 'utf8') }
  ]);
}

export function buildRuntime(spec: RuntimeSpec): RuntimeArtifacts {
  const paths = runtimePaths(spec);
  const enc = (p: string) => encodeURIComponent(p);

  const dataModelZip = writeZip([
    { name: '_datamodel.xdm', data: Buffer.from(dataModelXml(spec), 'utf8') },
    { name: 'sample.xml', data: Buffer.from(SAMPLE_XML, 'utf8') },
    {
      name: '~metadata.meta',
      data: Buffer.from(metaXml({ 'bip:DisplayName': 'dm', DESCRIPTION: 'Fusion SQL DEV helper data model', propertyMap: '1', path: enc(paths.dmPath) }), 'utf8')
    }
  ]);

  const reportZip = writeZip([
    { name: '_report.xdo', data: Buffer.from(reportXml(paths.dmPath), 'utf8') },
    { name: 'Default.xpt.png', data: Buffer.from(XPT_PNG_B64, 'base64') },
    { name: 'Default_en_US.xpt', data: xptZip() },
    { name: 'xdo.cfg', data: Buffer.from(XDO_CFG, 'utf8') },
    {
      name: '~metadata.meta',
      data: Buffer.from(
        metaXml({
          'bip:DisplayName': 'csv',
          DESCRIPTION: 'Fusion SQL DEV helper report',
          ESS_JOB_PKG_NAME: '',
          ESS_JOB_DEF_NAME: '',
          propertyMap: '0',
          path: enc(paths.reportPath)
        }),
        'utf8'
      )
    }
  ]);

  return { ...paths, dataModelZip, reportZip };
}

/** A catalog archive (.xdrz) for manual upload through the BI Publisher Catalog UI (Upload). */
export function buildCatalogArchive(spec: RuntimeSpec): Buffer {
  const art = buildRuntime(spec);
  const enc = encodeURIComponent;
  const meta = (p: string) => Buffer.from(metaXml({ DESCRIPTION: '', propertyMap: '1', path: enc(p) }), 'utf8');
  return writeZip([
    { name: '~metadata.meta', data: meta(art.rootFolder) },
    { name: `${art.versionFolder.slice(art.rootFolder.length + 1)}/`, data: Buffer.alloc(0) },
    { name: `${art.versionFolder.slice(art.rootFolder.length + 1)}/~metadata.meta`, data: meta(art.versionFolder) },
    { name: `${art.versionFolder.slice(art.rootFolder.length + 1)}/dm.xdmz`, data: art.dataModelZip },
    { name: `${art.versionFolder.slice(art.rootFolder.length + 1)}/csv.xdoz`, data: art.reportZip }
  ]);
}

/**
 * A native BI catalog archive (".catalog"), the format produced by Catalog > Download / Archive and
 * accepted by Catalog > Unarchive. Layout (reverse-engineered from a working FusionQuery.catalog):
 * zlib( u32 16, 4 x [u32 len + bytes] header, then per item [u16 0][u32 len + JSON metadata]
 * ([u16 1][u64 len + content])?, finally u16 2 ).
 */
export function buildCatalogFile(spec: RuntimeSpec, owner: string): Buffer {
  const paths = runtimePaths(spec);
  const sha = (b: Buffer) => require('crypto').createHash('sha256').update(b).digest('hex') as string;
  const orig = (p: string) => p.replace(/^\/~/, '/users/');
  const build = 'Build 20.3.1.16.1';
  const now = String(Date.now());
  const meta = (path: string, type: number, props: Record<string, string>, extra?: Record<string, unknown>) =>
    Buffer.from(
      JSON.stringify({
        Attributes: type === 4 ? 8 : 0,
        CatalogArchiveOptions: 0,
        InternalProperties: {},
        ItemName: path.slice(path.lastIndexOf('/') + 1),
        ItemType: type,
        ObjectSignature: '',
        OriginalPath: orig(path),
        WCProperties: { Build: build, 'bip:AUTHOR': owner, ...props },
        ...extra
      }),
      'utf8'
    );
  const str = (b: Buffer) => {
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length);
    return Buffer.concat([h, b]);
  };
  const u32 = (n: number) => {
    const h = Buffer.alloc(4);
    h.writeUInt32LE(n);
    return h;
  };
  const u16 = (n: number) => {
    const h = Buffer.alloc(2);
    h.writeUInt16LE(n);
    return h;
  };
  const content = (b: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeBigUInt64LE(BigInt(b.length));
    return Buffer.concat([u16(1), h, b]);
  };
  const out: Buffer[] = [
    u32(16),
    str(Buffer.from('20.3.1.18.1')),
    str(Buffer.from('fusion-sql-dev')),
    str(Buffer.from('{"CatalogPhysicalPath" : "","IsAccountStriped" : false,"IsSrcFrom11gBICS" : false}')),
    str(Buffer.from(JSON.stringify({ AccountType: 0, ID: owner })))
  ];
  const item = (m: Buffer, c?: Buffer) => out.push(u16(0), str(m), ...(c ? [content(c)] : []));
  const xpt = Buffer.from(XPT_PNG_B64, 'base64');
  const xptz = xptZip();
  const T = { 'bip:OBJ_TYPE': 'Folder', 'bip:MODIFIED': now };
  item(meta(paths.rootFolder, 1, T));
  item(meta(paths.versionFolder, 1, T));
  item(meta(paths.reportPath, 1, { 'bip:MODIFIED': now, 'bip:OBJ_TYPE': 'ReportItem', 'bip:propertyMap': '0', compositeSignature: '.xdo' }));
  item(meta(paths.dmPath, 1, { 'bip:MODIFIED': now, 'bip:OBJ_TYPE': 'ReportItem', compositeSignature: '.xdm' }));
  const child = (parent: string, name: string, sig: string, data: Buffer, hash = false) => {
    const m = meta(`${parent}/${name}`, 4, hash ? { 'bip:contentHashCode': sha(data) } : {}, { ObjectSignature: sig });
    item(m, data);
  };
  child(paths.dmPath, '_datamodel.xdm', 'bipxdmmetadata', Buffer.from(dataModelXml(spec), 'utf8'));
  child(paths.reportPath, '_report.xdo', 'bipxdometadata', Buffer.from(reportXml(paths.dmPath), 'utf8'));
  child(paths.dmPath, 'sample.xml', 'bipxdmmetadata', Buffer.from(SAMPLE_XML, 'utf8'));
  child(paths.reportPath, 'Default.xpt.png', 'bipxdometadata', xpt, true);
  child(paths.reportPath, 'Default_en_US.xpt', 'bipxdometadata', xptz, true);
  child(paths.reportPath, 'xdo.cfg', 'bipxdometadata', Buffer.from(XDO_CFG, 'utf8'));
  out.push(u16(2));
  return zlib.deflateSync(Buffer.concat(out));
}

/** Rewrite `<dataModel url="...">` inside a report archive so it points at our data model. */
export function patchReportZip(reportZip: Buffer, dmPath: string): Buffer {
  const entries: ZipEntry[] = readZip(reportZip).map((e) => {
    if (e.name === '_report.xdo') {
      const text = e.data.toString('utf8').replace(/(<dataModel\s+url=")[^"]*(")/g, (_m, a: string, b: string) => `${a}${xmlEscape(dmPath)}${b}`);
      return { name: e.name, data: Buffer.from(text, 'utf8') };
    }
    return e;
  });
  return writeZip(entries);
}

/** Pull the data model / report archives out of a user-supplied .xdrz (or a bare .xdmz+.xdoz pair). */
export function extractFromArchive(buf: Buffer): { dataModelZip: Buffer; reportZip: Buffer } {
  const entries = readZip(buf);
  const dm = entries.find((e) => /\.xdmz$/i.test(e.name));
  const rpt = entries.find((e) => /\.xdoz$/i.test(e.name));
  if (!dm || !rpt) {
    throw new FusionError('config', 'That file is not a usable catalog archive: it must contain a data model (.xdmz) and a report (.xdoz).', {
      hint: 'Use FusionQueryProxy.xdrz from the fusion-query project, or an export of the data model and report you created in BI Publisher.'
    });
  }
  return { dataModelZip: dm.data, reportZip: rpt.data };
}

/** SOAP v2 envelopes for BI Publisher's CatalogService / ReportService and response/fault parsing. */
import { FusionError, SSO_HINT } from './errors';
import { allTagText, stripTags, tagText, xmlEscape, xmlUnescapeDeep } from './xml';

export interface BodyCredentials {
  userID: string;
  password: string;
}

export function envelope(inner: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://xmlns.oracle.com/oxp/service/v2">\n' +
    '  <soapenv:Header/>\n  <soapenv:Body>\n' +
    inner +
    '\n  </soapenv:Body>\n</soapenv:Envelope>'
  );
}

function creds(c: BodyCredentials | null): string {
  if (!c) {
    return '      <v2:userID></v2:userID>\n      <v2:password></v2:password>';
  }
  return `      <v2:userID>${xmlEscape(c.userID)}</v2:userID>\n      <v2:password>${xmlEscape(c.password)}</v2:password>`;
}

export function runReportBody(reportPath: string, encodedSql: string, c: BodyCredentials | null): string {
  return `    <v2:runReport>
      <v2:reportRequest>
        <v2:attributeFormat>csv</v2:attributeFormat>
        <v2:byPassCache>true</v2:byPassCache>
        <v2:flattenXML>false</v2:flattenXML>
        <v2:parameterNameValues>
          <v2:listOfParamNameValues>
            <v2:item>
              <v2:multiValuesAllowed>false</v2:multiValuesAllowed>
              <v2:name>P_B64_CONTENT</v2:name>
              <v2:refreshParamOnChange>false</v2:refreshParamOnChange>
              <v2:selectAll>false</v2:selectAll>
              <v2:templateParam>false</v2:templateParam>
              <v2:useNullForAll>false</v2:useNullForAll>
              <v2:values>
                <v2:item>${encodedSql}</v2:item>
              </v2:values>
            </v2:item>
          </v2:listOfParamNameValues>
        </v2:parameterNameValues>
        <v2:reportAbsolutePath>${xmlEscape(reportPath)}</v2:reportAbsolutePath>
        <v2:sizeOfDataChunkDownload>-1</v2:sizeOfDataChunkDownload>
      </v2:reportRequest>
${creds(c)}
    </v2:runReport>`;
}

export function createFolderBody(folder: string, c: BodyCredentials | null): string {
  return `    <v2:createFolder>
      <v2:folderAbsolutePath>${xmlEscape(folder)}</v2:folderAbsolutePath>
${creds(c)}
    </v2:createFolder>`;
}

export function uploadObjectBody(path: string, type: 'xdmz' | 'xdoz', zipped: Buffer, c: BodyCredentials | null): string {
  return `    <v2:uploadObject>
      <v2:reportObjectAbsolutePathURL>${xmlEscape(path)}</v2:reportObjectAbsolutePathURL>
      <v2:objectType>${type}</v2:objectType>
      <v2:objectZippedData>${zipped.toString('base64')}</v2:objectZippedData>
${creds(c)}
    </v2:uploadObject>`;
}

export function deleteObjectBody(path: string, c: BodyCredentials | null): string {
  return `    <v2:deleteObject>
      <v2:objectAbsolutePath>${xmlEscape(path)}</v2:objectAbsolutePath>
${creds(c)}
    </v2:deleteObject>`;
}

export function getFolderContentsBody(folder: string, c: BodyCredentials | null): string {
  return `    <v2:getFolderContents>
      <v2:folderAbsolutePath>${xmlEscape(folder)}</v2:folderAbsolutePath>
${creds(c)}
    </v2:getFolderContents>`;
}

/** Extract the base64 payload of a runReport response. */
export function parseReportBytes(body: string): Buffer | undefined {
  const raw = tagText(body, 'reportBytes');
  if (raw === undefined) {
    return undefined;
  }
  return Buffer.from(raw.replace(/\s+/g, ''), 'base64');
}

export function parseFolderFileNames(body: string): string[] {
  return allTagText(body, 'fileName').map((s) => xmlUnescapeDeep(s).trim());
}

const ORACLE_CODE = /\b(?:ORA|PLS|XDO|TNS|SQL|PCC|IMP|EXP|RMAN|LPX|QSM|DRG|BIP|OPSS|JBO)-\d{3,6}\b[^\n<]{0,400}/g;

export function looksLikeHtml(body: string): boolean {
  return /^\s*(?:<!doctype html|<html[\s>])/i.test(body) || /<title>[^<]*(?:sign\s*in|log\s*in|login|single sign)[^<]*<\/title>/i.test(body);
}

/** Pull the human-meaningful part out of an Oracle SOAP fault (ORA-/XDO- codes beat java class names). */
export function extractFaultMessage(body: string): string | undefined {
  const detail = tagText(body, 'detail') ?? '';
  const faultstring = tagText(body, 'faultstring') ?? '';
  const candidates = [xmlUnescapeDeep(detail), xmlUnescapeDeep(faultstring), xmlUnescapeDeep(body)].map((c) => c.replace(/[^\x09\x0A\x0D\x20-\x7E -￿]/g, ''));

  for (const c of candidates) {
    const found = [...c.matchAll(ORACLE_CODE)].map((m) => m[0].replace(/\s+/g, ' ').trim()).filter((l) => l.length > 8);
    if (found.length) {
      const unique = [...new Set(found)];
      const meaningful = unique.filter((l) => !/^ORA-06512\b/.test(l));
      return (meaningful.length ? meaningful : unique).slice(0, 6).join('\n');
    }
  }
  const readable = allTagText(xmlUnescapeDeep(detail), 'message')
    .concat(allTagText(xmlUnescapeDeep(detail), 'text'))
    .map((t) => stripTags(t).trim())
    .filter((t) => t.length > 5 && !/^(?:oracle\.xdo|java\.|com\.|org\.|sun\.)/.test(t));
  if (readable.length) {
    return [...new Set(readable)].slice(0, 4).join('\n');
  }
  const fs = stripTags(xmlUnescapeDeep(faultstring))
    .replace(/(?:oracle\.xdo|java\.lang|com\.oracle)[\w.$]*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return fs.length > 3 ? fs : undefined;
}

/** Translate an unsuccessful HTTP exchange into a FusionError. Returns undefined when the response is OK. */
export function classifyResponse(status: number, headers: Record<string, string | string[] | undefined>, body: string, authKind: string): FusionError | undefined {
  const location = String(headers['location'] ?? '');
  const isFault = /<(?:[\w.-]+:)?Fault[\s>]/i.test(body);

  if (status >= 300 && status < 400) {
    return new FusionError('sso', `The server redirected to ${location ? new URL(location, 'https://x').host || location : 'a login page'} (HTTP ${status}).`, { status, hint: SSO_HINT });
  }
  if (status === 200 && !isFault && looksLikeHtml(body)) {
    return new FusionError('sso', 'The server returned a web page instead of a SOAP response.', { status, hint: SSO_HINT });
  }
  if (status === 200 && !isFault) {
    return undefined;
  }
  if (status === 401) {
    return new FusionError('auth', authKind === 'basic' ? 'Invalid username or password (HTTP 401).' : 'The access token was rejected (HTTP 401).', {
      status,
      hint:
        authKind === 'basic'
          ? 'If your pod uses Single Sign-On, a local Fusion password may not exist or may be disabled - choose "Single Sign-On (OAuth)" in the connection settings. See docs/SSO.md.'
          : 'Sign in again (right-click the connection > Sign In).'
    });
  }
  if (looksLikeHtml(body) && status !== 500) {
    if (status === 404) {
      return new FusionError('http', 'BI Publisher web service was not found (HTTP 404).', {
        status,
        hint: 'Use the base URL of your Fusion pod, e.g. https://abcd.fa.us2.oraclecloud.com - without /fscmUI/... after it.'
      });
    }
    if (status === 502 || status === 503 || status === 504) {
      return new FusionError('http', `The pod's gateway answered HTTP ${status}. The service may be in maintenance or overloaded.`, { status, hint: 'Retry in a minute.' });
    }
    if (status === 403 || status === 200) {
      return new FusionError('sso', `The server returned a web page (HTTP ${status}) instead of a SOAP response.`, { status, hint: SSO_HINT });
    }
  }

  const msg = extractFaultMessage(body);
  if (msg) {
    if (/\b(?:ORA|PLS)-\d+/.test(msg)) {
      return new FusionError('oracle', msg, { status, code: /\b((?:ORA|PLS)-\d+)/.exec(msg)?.[1] });
    }
    if (/invalid\s*credentials|authentication\s*failed|not\s*authenticated|invalid\s*user\s*name|invalid username or password|failed\s*authentication|FailedAuthentication/i.test(msg + body)) {
      return new FusionError('auth', 'Invalid username or password.', {
        status,
        hint: 'Check the credentials. For SSO-only pods use "Single Sign-On (OAuth)" - see docs/SSO.md.'
      });
    }
    if (/(?:not|no)\s+(?:authori[sz]ed|permission)|access\s+denied|permission\s+denied|does not have (?:the )?(?:required )?(?:privilege|permission)/i.test(msg)) {
      return new FusionError('permission', msg, {
        status,
        hint: 'Your user needs the BI Publisher roles (e.g. "BI Consumer"/"BI Author" or "Application Implementation Consultant") and permission to run reports.'
      });
    }
    if (/(?:report|path|object|folder).{0,80}(?:not\s+found|does\s+not\s+exist|invalid|cannot\s+be\s+found|no\s+such)|InvalidParametersException|not\s+exist/i.test(msg + body.slice(0, 2000))) {
      return new FusionError('runtime-missing', msg, { status });
    }
    return new FusionError('oracle', msg, { status });
  }
  if (status === 403) {
    return new FusionError('permission', 'Access forbidden (HTTP 403).', { status, hint: 'Your user may lack the BI Publisher roles, or the pod blocks your IP address.' });
  }
  if (status === 404) {
    return new FusionError('http', 'BI Publisher web service was not found (HTTP 404).', {
      status,
      hint: 'Use the base URL of your Fusion pod, e.g. https://abcd.fa.us2.oraclecloud.com'
    });
  }
  return new FusionError('http', `HTTP ${status}: SOAP fault returned by BI Publisher.`, {
    status,
    hint: isFault ? 'Enable "fusionSqlDev.debugLogging" and check the Fusion SQL DEV output channel for details.' : undefined
  });
}

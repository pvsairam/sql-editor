// Zero-dependency VSIX packager (equivalent to `vsce package` for this extension).
// Usage: node scripts/package-vsix.mjs   -> releases/<name>-<version>.vsix
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const zipLib = join(root, 'out', 'fusion', 'zip.js');
if (!existsSync(zipLib) || !existsSync(join(root, 'out', 'extension.js')) || !existsSync(join(root, 'media', 'webview', 'main.js'))) {
  console.error('Build output missing. Run `node scripts/build.mjs` first.');
  process.exit(1);
}
const { writeZip } = require(zipLib);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}
const rel = (p) => relative(root, p).split(sep).join('/');

const include = [];
const add = (from, to) => include.push({ from: join(root, from), to: `extension/${to ?? from}` });
add('package.json');
add('README.md', 'readme.md');
add('CHANGELOG.md', 'changelog.md');
add('LICENSE', 'LICENSE.txt');
add('NOTICE.md', 'NOTICE.md');
for (const f of walk(join(root, 'media'))) {
  if (!f.endsWith('.map')) {
    add(rel(f));
  }
}
for (const f of walk(join(root, 'out'))) {
  if (f.endsWith('.js')) {
    add(rel(f));
  }
}

for (const i of include) {
  if (!existsSync(i.from)) {
    console.error(`missing file: ${i.from}`);
    process.exit(1);
  }
}
if (!existsSync(join(root, pkg.main))) {
  console.error(`main entry ${pkg.main} not found`);
  process.exit(1);
}
const icon = readFileSync(join(root, pkg.icon));
if (icon.readUInt32BE(0) !== 0x89504e47) {
  console.error('icon must be a real PNG');
  process.exit(1);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kinds = (pkg.extensionKind ?? []).join(',');
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords ?? []).concat(['chat-participant', 'sql']).join(','))}</Tags>
    <Categories>${esc((pkg.categories ?? ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc(kinds)}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${esc(pkg.repository?.url ?? '')}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="${esc(pkg.repository?.url ?? '')}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${esc(pkg.bugs?.url ?? '')}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${esc(pkg.homepage ?? '')}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${esc(pkg.icon)}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${esc(pkg.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const exts = new Set(include.map((i) => '.' + i.to.split('.').pop()));
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.vsixmanifest': 'text/xml' };
exts.add('.vsixmanifest');
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...exts]
  .sort()
  .map((e) => `<Default Extension="${e}" ContentType="${types[e] ?? 'application/octet-stream'}"/>`)
  .join('')}</Types>`;

const entries = [
  { name: 'extension.vsixmanifest', data: Buffer.from(manifest, 'utf8') },
  { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
  ...include.map((i) => ({ name: i.to, data: readFileSync(i.from) }))
];
const zip = writeZip(entries, new Date());
const outDir = join(root, 'releases');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${pkg.name}-${pkg.version}.vsix`);
writeFileSync(file, zip);
console.log(`${rel(file)}  ${(zip.length / 1024).toFixed(0)} KB  (${entries.length} files)`);
for (const e of entries.filter((e) => e.data.length > 100_000)) {
  console.log(`  large: ${e.name} ${(e.data.length / 1024).toFixed(0)} KB`);
}
